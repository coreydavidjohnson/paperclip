import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as state from "./external-run-state.js";
import { createHeartbeatRunOutput } from "./run-output.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { subscribeCompanyLiveEvents } from "../live-events.js";
vi.mock("./run-lifecycle.js", async original => ({ ...await original<typeof import("./run-lifecycle.js")>(), isHeartbeatRunRuntimeStatusActive: () => true, publishHeartbeatRunRuntimeProgress: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("external run observer state", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("external-state-"); db = createDb(temporary.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Observer", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Observer" }).returning();
    return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", observerEpoch: 7, unknownSince: new Date(0), livenessProbe: { state: "gone", goneCount: 1 } }).returning())[0]!;
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  it("persists handles and progress with database time and clears stale gone evidence", async () => {
    const run = await seed(), handle = { sessionId: "session", turnRef: "turn", dispatch: "accepted" as const };
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2099-01-01"));
    try {
      expect(await state.persistExternalRunHandle(db, run, handle)).toBeTruthy();
      const persisted = await read(run.id);
      expect(persisted).toMatchObject({ externalRunHandle: handle, livenessVersion: 1, unknownSince: null, livenessProbe: null });
      expect(persisted.lastProgressAt!.getUTCFullYear()).not.toBe(2099);
      expect(await state.recordExternalRunProgress(db, run)).toBeTruthy();
      expect((await read(run.id)).livenessVersion).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it.each(["epoch", "company", "id", "terminal"])("rejects mismatched %s", async mismatch => {
    const run = await seed(), observer = { ...run };
    if (mismatch === "epoch") observer.observerEpoch--;
    if (mismatch === "company") observer.companyId = randomUUID();
    if (mismatch === "id") observer.id = randomUUID();
    if (mismatch === "terminal") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    const before = await read(run.id);
    expect(await state.persistExternalRunHandle(db, observer, { sessionId: "stale", dispatch: "accepted" })).toBeFalsy();
    expect(await state.recordExternalRunProgress(db, observer)).toBeFalsy();
    expect(await read(run.id)).toEqual(before);
    expect(await db.select().from(heartbeatRuns).where(state.externalObserverCondition(observer))).toEqual([]);
  });
  it("starts a twelve-hour database deadline once", async () => {
    const run = await seed();
    const [{ at }] = await db.execute<{ at: string }>(sql`select clock_timestamp() as at`);
    expect(await state.persistExternalRunDispatchDeadline(db, run)).toBeTruthy();
    const first = await read(run.id);
    expect(first.deadlineAt!.getTime() - new Date(at).getTime()).toBeGreaterThanOrEqual(43200000);
    expect(first.deadlineAt!.getTime() - new Date(at).getTime()).toBeLessThan(43202000);
    await state.persistExternalRunDispatchDeadline(db, run);
    expect((await read(run.id)).deadlineAt).toEqual(first.deadlineAt);
    expect(await state.persistExternalRunDispatchDeadline(db, { ...run, observerEpoch: 6 })).toBeFalsy();
  });
  async function output(run: Awaited<ReturnType<typeof seed>>, append = vi.fn(async () => 5)) {
    const store = { begin: vi.fn(async () => ({ store: "local_file" as const, logRef: "fixture" })), append };
    const live: any[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(run.companyId, event => live.push(event));
    const recorder = createHeartbeatRunOutput(db, { run, runId: run.id, issueId: null, runLogStore: store,
      identityRedactor: createAgentIdentityRedactor(), secretKeys: new Set(["TOKEN"]), appendRunEvent: vi.fn(),
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    return { store, recorder, callbacks: await recorder.begin(run), live, unsubscribe };
  }
  it("fences logs, metadata, events, pending flushes, and excerpts after takeover", async () => {
    const run = await seed(), o = await output(run);
    try {
      await o.callbacks.onLog("stdout", "current");
      expect((await read(run.id)).livenessVersion).toBeGreaterThan(0);
      await db.update(heartbeatRuns).set({ observerEpoch: 8 }).where(eq(heartbeatRuns.id, run.id));
      const taken = await read(run.id), count = o.live.length;
      await o.callbacks.onLog("stdout", "stale");
      await o.callbacks.onAdapterMeta({ adapterType: "test", command: "stale" });
      await o.callbacks.onAdapterEvent({ eventType: "stale", message: "stale" });
      await o.recorder.flushOutputProgress({ force: true });
      expect(o.store.append).toHaveBeenCalledTimes(1);
      expect(o.recorder.stdoutExcerpt).toBe("current");
      expect(await read(run.id)).toEqual(taken);
      expect(o.live).toHaveLength(count);
    } finally { o.unsubscribe(); }
  });
  it("holds authority until an in-flight append and its live publication finish", async () => {
    const run = await seed();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const append = vi.fn(async () => { entered(); await blocked; return 5; });
    const o = await output(run, append);
    try {
      const writing = o.callbacks.onLog("stdout", "owned");
      await started;
      let tookOver = false;
      const takeover = db.update(heartbeatRuns).set({ observerEpoch: 8 }).where(eq(heartbeatRuns.id, run.id)).then(() => { tookOver = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(tookOver).toBe(false);
      release(); await writing; await takeover;
      const count = o.live.length;
      await o.callbacks.onLog("stdout", "late");
      expect(append).toHaveBeenCalledTimes(1);
      expect(o.live).toHaveLength(count);
    } finally { release(); o.unsubscribe(); }
  });
  it("does not create a log store after takeover, even if begin receives a refreshed row", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ observerEpoch: 8 }).where(eq(heartbeatRuns.id, run.id));
    const store = { begin: vi.fn(async () => ({ store: "local_file" as const, logRef: "stale" })), append: vi.fn(async () => 0) };
    const recorder = createHeartbeatRunOutput(db, { run, runId: run.id, issueId: null, runLogStore: store,
      identityRedactor: createAgentIdentityRedactor(), secretKeys: new Set(), appendRunEvent: vi.fn(),
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    await recorder.begin(await read(run.id));
    expect(store.begin).not.toHaveBeenCalled();
    expect((await read(run.id)).logRef).toBeNull();
  });
  it("persists current structured events and publishes only fenced, redacted payloads", async () => {
    const run = await seed(), o = await output(run);
    try {
      await o.callbacks.onAdapterMeta({ adapterType: "test", command: "fixture", env: { TOKEN: "sensitive" } });
      await o.callbacks.onAdapterEvent({ eventType: " progress ", message: "working", payload: { step: 1 } });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(events.map(e => e.eventType)).toEqual(["adapter.invoke", "progress"]);
      expect(JSON.stringify(events)).not.toContain("sensitive");
      expect(o.live.filter(e => e.type === "heartbeat.run.event")).toHaveLength(2);
      expect((await read(run.id)).livenessVersion).toBe(2);
    } finally { o.unsubscribe(); }
  });
});
