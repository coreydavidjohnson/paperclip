import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { postgres } from "@paperclipai/db";
import { WebSocket } from "ws";

const url = process.env.LIVE_EVENTS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("fixture_timeout"); await delay(20); }
}

suite("two-process PostgreSQL UI live events (synthetic DB only)", () => {
  it("isolates companies/business observers, orders/dedupes hints, resyncs oversize/reconnect/DB loss", async () => {
    // Refuse an accidental production test target. This suite intentionally kills backends.
    if (!url!.includes("synthetic-per282")) throw new Error("synthetic_database_required");
    const sql = postgres(url!, { max: 1 });
    const children: ChildProcess[] = [];
    const sockets: WebSocket[] = [];
    let request = 0;
    const spawn = () => {
      const child = fork(fileURLToPath(new URL("./live-events-process-fixture.ts", import.meta.url)), [], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      children.push(child);
      const state = { port: 0, ready: false, losses: 0 };
      child.on("message", (message: any) => {
        if (message.port) state.port = message.port;
        if (typeof message.ready === "boolean") { state.ready = message.ready; if (!message.ready) state.losses++; }
      });
      return { child, state };
    };
    const command = (child: ChildProcess, input: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      const id = ++request;
      const timeout = setTimeout(() => { child.off("message", listen); reject(new Error("ipc_timeout")); }, 5000);
      const listen = (message: any) => { if (message.request !== id) return; clearTimeout(timeout); child.off("message", listen); resolve(message); };
      child.on("message", listen); child.send({ ...input, request: id });
    });
    const connect = async (port: number, company: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${company}/events/ws`);
      sockets.push(socket);
      const events: any[] = [];
      socket.on("message", raw => events.push(JSON.parse(raw.toString())));
      await once(socket, "open");
      return { socket, events };
    };
    try {
      const a = spawn(), b = spawn();
      await until(() => a.state.ready && b.state.ready && !!a.state.port && !!b.state.port);
      let aa = await connect(a.state.port, "a"), ba = await connect(b.state.port, "a");
      const bb = await connect(b.state.port, "b");
      const wildcard = new WebSocket(`ws://127.0.0.1:${b.state.port}/api/companies/%2A/events/ws`);
      sockets.push(wildcard);
      const wildcardRejected = new Promise<void>(resolve => wildcard.on("error", () => resolve()));
      await wildcardRejected;
      expect(wildcard.readyState).not.toBe(WebSocket.OPEN);
      const result = await command(a.child, { command: "publish", companyId: "a", payload: { marker: "first" } });
      expect(result.event.id).toBeTypeOf("number");
      expect(result.business).toBe(1); expect(result.companyObserver).toBe(1);
      await until(() => aa.events.length === 1 && ba.events.length === 1);
      expect(bb.events).toHaveLength(0);
      expect((await command(b.child, { command: "stats" })).business).toBe(0);
      expect((await command(b.child, { command: "stats" })).companyObserver).toBe(0);
      for (let i = 0; i < 10; i++) await command(b.child, { command: "publish", companyId: "a", payload: { seq: i } });
      await until(() => aa.events.length === 11 && ba.events.length === 11);
      expect(aa.events.slice(1).map(e => e.payload.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(ba.events.slice(1).map(e => e.payload.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(new Set(aa.events.map(e => e.id)).size).toBe(11);
      expect(aa.events.every((e, i) => i === 0 || e.id > aa.events[i-1].id)).toBe(true);
      await command(a.child, { command: "publish", companyId: "*", payload: { pluginId: "test" } });
      await until(() => aa.events.length === 12 && ba.events.length === 12 && bb.events.length === 1);
      expect(bb.events[0].companyId).toBe("*");
      // Duplicate notifications (even across separate transactions) do not duplicate UI work.
      const duplicate = JSON.stringify({ origin: randomUUID(), sequence: 1, event: { id: 1, companyId: "a", type: "activity.logged", createdAt: new Date().toISOString(), payload: { marker: "dedupe" } } });
      await sql.notify("paperclip_ui_events_v1", duplicate);
      await sql.notify("paperclip_ui_events_v1", duplicate);
      await until(() => aa.events.length === 13 && ba.events.length === 13); await delay(100);
      expect(aa.events).toHaveLength(13); expect(ba.events).toHaveLength(13);
      const before = [a.state.losses, b.state.losses];
      const backends = await sql`SELECT pid FROM pg_stat_activity WHERE application_name = 'paperclip-live-events' ORDER BY pid`;
      const resetCodes: number[] = [];
      aa.socket.on("close", code => resetCodes.push(code));
      ba.socket.on("close", code => resetCodes.push(code));
      await command(a.child, { command: "publish", companyId: "a", payload: { chunk: "😀".repeat(4000) } });
      await until(() => resetCodes.length === 2);
      expect(resetCodes).toEqual([1013, 1013]);
      expect([a.state.losses, b.state.losses]).toEqual(before);
      expect(a.state.ready && b.state.ready).toBe(true);
      expect(await sql`SELECT pid FROM pg_stat_activity WHERE application_name = 'paperclip-live-events' ORDER BY pid`).toEqual(backends);
      expect(aa.socket.readyState).not.toBe(WebSocket.OPEN);
      expect(ba.socket.readyState).not.toBe(WebSocket.OPEN);
      aa = await connect(a.state.port, "a"); ba = await connect(b.state.port, "a");
      await command(a.child, { command: "publish", companyId: "a", payload: { marker: "after-oversize" } });
      await until(() => aa.events.length === 1 && ba.events.length === 1);
      const loss = b.state.losses;
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'paperclip-live-events'`;
      await until(() => b.state.losses > loss);
      await until(() => a.state.ready && b.state.ready);
      aa = await connect(a.state.port, "a"); ba = await connect(b.state.port, "a");
      await command(a.child, { command: "publish", companyId: "a", payload: { marker: "after-reconnect" } });
      await until(() => aa.events.length === 1 && ba.events.length === 1);
      // Simulate DB unavailable to application role while keeping the synthetic
      // test controller connected. Restore even when an assertion fails.
      await sql`ALTER ROLE postgres NOLOGIN`;
      try {
        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'paperclip-live-events'`;
        await until(() => !a.state.ready && !b.state.ready);
        await command(a.child, { command: "publish", companyId: "a", payload: { marker: "lost-not-replayed" } });
        await delay(1500);
        expect(a.state.ready).toBe(false); expect(b.state.ready).toBe(false);
        const rejected = new WebSocket(`ws://127.0.0.1:${b.state.port}/api/companies/a/events/ws`);
        sockets.push(rejected);
        const response = await new Promise<number>(resolve => {
          rejected.on("unexpected-response", (_req, res) => { resolve(res.statusCode!); rejected.terminate(); });
          rejected.on("error", () => {});
        });
        expect(response).toBe(503);
      } finally { await sql`ALTER ROLE postgres LOGIN`; }
      await until(() => a.state.ready && b.state.ready);
      aa = await connect(a.state.port, "a"); ba = await connect(b.state.port, "a");
      await command(b.child, { command: "publish", companyId: "a", payload: { marker: "after-db-loss" } });
      await until(() => aa.events.length === 1 && ba.events.length === 1);
      expect(aa.events[0].payload.marker).toBe("after-db-loss");
      await delay(100); expect(aa.events).toHaveLength(1);
      const astats = await command(a.child, { command: "stats" });
      const bstats = await command(b.child, { command: "stats" });
      expect(astats.business).toBe(5); expect(astats.companyObserver).toBe(5);
      expect(bstats.business).toBe(11); expect(bstats.companyObserver).toBe(11);
      const queueLosses = [a.state.losses, b.state.losses];
      const queueBackends = await sql`SELECT pid FROM pg_stat_activity WHERE application_name = 'paperclip-live-events' ORDER BY pid`;
      const queueCodes: number[] = [];
      aa.socket.on("close", code => queueCodes.push(code));
      ba.socket.on("close", code => queueCodes.push(code));
      await command(a.child, { command: "burst" });
      await until(() => queueCodes.length === 2);
      expect(queueCodes).toEqual([1013, 1013]);
      expect([a.state.losses, b.state.losses]).toEqual(queueLosses);
      expect(a.state.ready && b.state.ready).toBe(true);
      expect(await sql`SELECT pid FROM pg_stat_activity WHERE application_name = 'paperclip-live-events' ORDER BY pid`).toEqual(queueBackends);
      expect(aa.socket.readyState).not.toBe(WebSocket.OPEN);
      expect(ba.socket.readyState).not.toBe(WebSocket.OPEN);
      console.log("bounded send queue overflow forces both peers to resync");
      if (process.env.LIVE_EVENTS_TEST_CONTROLLER === "1") {
        // The namespace-owning controller actually destroys/recreates synthetic
        // PostgreSQL, never production. Application processes stay alive.
        await writeFile("/tmp/per282-db-loss.request", "stop synthetic DB");
        await until(() => !a.state.ready && !b.state.ready);
        await command(a.child, { command: "publish", companyId: "a", payload: { marker: "during-actual-db-loss" } });
        await writeFile("/tmp/per282-db-loss.confirmed", "both fail closed");
        await until(() => a.state.ready && b.state.ready, 30000);
        aa = await connect(a.state.port, "a"); ba = await connect(b.state.port, "a");
        await command(a.child, { command: "publish", companyId: "a", payload: { marker: "after-actual-db-restart" } });
        await until(() => aa.events.length === 1 && ba.events.length === 1);
        expect(aa.events[0].payload.marker).toBe("after-actual-db-restart");
        expect(ba.events[0].payload.marker).toBe("after-actual-db-restart");
        console.log("controller destroyed/recreated synthetic DB: fail closed, reconnect, no stale replay verified");
      }
      console.log("two native processes: companies/global/order/dedupe/oversize/reconnect/DB loss/recovery/origin-only business observers verified");
    } finally {
      for (const socket of sockets) socket.terminate();
      for (const child of children) { if (child.connected) child.send({ command: "stop" }); }
      await until(() => children.every(child => child.exitCode !== null), 5000).catch(() => {
        for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
        throw new Error("fixture_graceful_shutdown_failed");
      });
      expect(children.every(child => child.exitCode === 0)).toBe(true);
      await sql.end({ timeout: 0 });
    }
  }, 60000);
});
