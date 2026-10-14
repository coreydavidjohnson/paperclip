import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { postgres } from "@paperclipai/db";
import { WebSocket } from "ws";

const url = process.env.LIVE_EVENTS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("fault_fixture_timeout"); await delay(20); }
}

suite("real TCP blackhole / paused WebSocket reader (synthetic DB only)", () => {
  it("fails readiness within probe deadline, resyncs without replay, bounds reader queues and stops before DB", async () => {
    if (!url!.includes("synthetic-per282")) throw new Error("synthetic_database_required");
    const target = new URL(url!);
    const sql = postgres(url!, { max: 1 });
    let blackhole = false;
    const tcp = new Set<Socket>();
    const proxy = createServer(client => {
      const upstream = tcpConnect(Number(target.port || 5432), target.hostname);
      tcp.add(client); tcp.add(upstream);
      // Consume/drop packets without FIN/RST: neither endpoint knows it is broken.
      client.on("data", data => { if (!blackhole) upstream.write(data); });
      upstream.on("data", data => { if (!blackhole) client.write(data); });
      client.on("error", () => {}); upstream.on("error", () => {});
      client.on("close", () => { tcp.delete(client); upstream.destroy(); });
      upstream.on("close", () => { tcp.delete(upstream); client.destroy(); });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = new URL(url!);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String((proxy.address() as { port: number }).port);
    const children: ChildProcess[] = [], sockets: WebSocket[] = [];
    let request = 0;
    const spawn = (databaseUrl: string) => {
      const child = fork(fileURLToPath(new URL("./live-events-process-fixture.ts", import.meta.url)), [], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, LIVE_EVENTS_TEST_DATABASE_URL: databaseUrl },
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
    const ws = async (port: number) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/a/events/ws`);
      sockets.push(socket);
      const events: any[] = [];
      socket.on("message", raw => events.push(JSON.parse(raw.toString())));
      await once(socket, "open");
      return { socket, events };
    };
    const status = async (port: number) => (await fetch(`http://127.0.0.1:${port}/ready`)).status;
    try {
      const a = spawn(proxyUrl.toString()), b = spawn(url!);
      await until(() => a.state.ready && b.state.ready && !!a.state.port && !!b.state.port);
      let aa = await ws(a.state.port);
      const bb = await ws(b.state.port);
      expect(await status(a.state.port)).toBe(200);
      const initialLoss = a.state.losses;
      const started = Date.now(); blackhole = true;
      // No socket close and no publish: the idle LISTEN probe must detect it.
      await until(() => a.state.losses > initialLoss, 5000);
      expect(Date.now() - started).toBeLessThan(4500);
      expect(a.state.ready).toBe(false); expect(b.state.ready).toBe(true);
      expect(await status(a.state.port)).toBe(503);
      await until(() => aa.socket.readyState !== WebSocket.OPEN);
      const rejected = new WebSocket(`ws://127.0.0.1:${a.state.port}/api/companies/a/events/ws`);
      sockets.push(rejected);
      rejected.on("error", () => {});
      const rejectedStatus = await new Promise<number>(resolve => rejected.on("unexpected-response", (_req, res) => { resolve(res.statusCode!); rejected.terminate(); }));
      expect(rejectedStatus).toBe(503);
      await command(a.child, { command: "publish", companyId: "a", payload: { marker: "blackholed-not-replayed" } });
      blackhole = false;
      await until(() => a.state.ready);
      aa = await ws(a.state.port);
      await command(b.child, { command: "publish", companyId: "a", payload: { marker: "after-blackhole" } });
      await until(() => aa.events.length === 1 && bb.events.length === 1);
      expect(aa.events[0].payload.marker).toBe("after-blackhole");
      await delay(200); expect(aa.events).toHaveLength(1);
      console.log("TCP blackhole deadline, readiness 503, websocket resync, epoch recovery and no replay verified");

      // Pausing the actual client TCP socket eventually fills real server-side ws buffers.
      (aa.socket as unknown as { _socket: Socket })._socket.pause();
      let removed = false, highWater = 0;
      for (let round = 0; round < 160; round++) {
        const before = bb.events.length;
        await command(a.child, { command: "pressure" });
        await until(() => bb.events.length === before + 100);
        const stats = await command(a.child, { command: "socket-stats" });
        highWater = Math.max(highWater, ...stats.buffered);
        expect(stats.buffered.every((value: number) => value <= 1024 * 1024)).toBe(true);
        if (stats.clients === 0) { removed = true; break; }
      }
      expect(removed).toBe(true);
      expect(a.state.ready).toBe(true); expect(b.state.ready).toBe(true);
      (aa.socket as unknown as { _socket: Socket })._socket.resume();
      await until(() => aa.socket.readyState !== WebSocket.OPEN);
      const count = bb.events.length;
      await command(a.child, { command: "publish", companyId: "a", payload: { marker: "healthy-reader-continues" } });
      await until(() => bb.events.length === count + 1);
      expect(bb.events.at(-1).payload.marker).toBe("healthy-reader-continues");
      expect((await command(b.child, { command: "stats" })).business).toBe(1);
      console.log(`real paused reader terminated; buffered high-water=${highWater}; healthy peer continued without duplicate observers`);

      const closing = await ws(b.state.port);
      expect((await command(b.child, { command: "transport-stop" })).ready).toBe(false);
      expect(await status(b.state.port)).toBe(503);
      await until(() => closing.socket.readyState !== WebSocket.OPEN);
      // stop is idempotent; DB is still usable after transport stop.
      await command(b.child, { command: "transport-stop" });
      expect((await sql`select 1 as alive`)[0].alive).toBe(1);

      // Startup-error cleanup while LISTEN is still blackholed/in flight.
      blackhole = true;
      const c = spawn(proxyUrl.toString());
      await until(() => !!c.state.port);
      expect(await status(c.state.port)).toBe(503);
      const cleanupStarted = Date.now();
      const exited = once(c.child, "exit");
      c.child.send({ command: "stop" });
      expect((await exited)[0]).toBe(0);
      expect(Date.now() - cleanupStarted).toBeLessThan(2000);
      await delay(4200); // Late connect/probe deadlines must not revive a stopped epoch.
      expect(c.state.ready).toBe(false);
      console.log("startup-in-flight cleanup, stop idempotence, fail-closed HTTP/websocket shutdown verified");
    } finally {
      blackhole = false;
      for (const socket of sockets) socket.terminate();
      for (const child of children) if (child.connected) child.send({ command: "stop" });
      await until(() => children.every(child => child.exitCode !== null), 5000).catch(() => {
        for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
        throw new Error("fixture_graceful_shutdown_failed");
      });
      expect(children.every(child => child.exitCode === 0)).toBe(true);
      for (const socket of tcp) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      expect((await sql`select count(*)::int as count from pg_stat_activity where application_name = 'paperclip-live-events'`)[0].count).toBe(0);
      await sql.end({ timeout: 0 });
    }
  }, 120000);
});
