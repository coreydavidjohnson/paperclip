import { apiMetrics } from "../api-metrics.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { hasLiveLegacyController, legacyControllerBootId, legacyControllerClaim,
  renewLegacyControllerLease, revokeExpiredLegacyController, watchLegacyControllerLease,
  startClaimedLegacyControllerLease, hasClaimedLegacyControllerRenewal, LEGACY_CONTROLLER_LEASE_MS, LEGACY_CONTROLLER_RENEW_MS, LegacyControllerLeaseLostError, revokeExpiredLegacyControllerWithState } from "./legacy-controller-lease.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable legacy controller ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-controller-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Controller test", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "claude_local", status: "idle" });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", ...legacyControllerClaim("legacy") })
      .where(eq(heartbeatRuns.id, queued.id)).returning();
    return run;
  }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, id));
  }
  it("commits ownership with the queued claim before provisioning or logs exist", async () => {
    const run = await seed();
    expect(run).toMatchObject({ status: "running", controllerBootId: legacyControllerBootId, executionStage: "preparing", processPid: null });
    expect(await hasLiveLegacyController(db, run)).toBe(true);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("another deployment's startup reaper preserves an unexpired controller", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
    expect(saved.errorCode).toBeNull();
  });
  it.each([false, true])("shutdown preserves a foreign controller (expired: %s)", async expired => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    if (expired) await expire(run.id);
    const result = await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    expect(result.interruptedRunIds).toEqual([]);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
  });
  it("a current controller renews and records the dispatch boundary", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(true);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.executionStage).toBe("dispatching");
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("the lease owner consumes saved Stop intent once without blocking renewal", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, run.id));
    let release!: () => void;
    const stopping = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.fn(async () => { await stopping; });
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller, stop);
    try {
      await watch.assertOwned();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      await Promise.all([watch.assertOwned(), watch.assertOwned()]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(controller.signal.aborted).toBe(false);
    } finally { watch.stop(); release(); }
  });

  it("a replaced observer cannot consume a saved Stop intent", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ observerEpoch: run.observerEpoch + 1,
      resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, run.id));
    const stop = vi.fn(async () => undefined);
    const watch = watchLegacyControllerLease(db, run, new AbortController(), stop);
    try {
      await expect(watch.assertOwned()).rejects.toThrow("lease lost");
      expect(stop).not.toHaveBeenCalled();
    } finally { watch.stop(); }
  });

  it("a replaced observer cannot renew the same controller boot lease", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ observerEpoch: run.observerEpoch + 1 }).where(eq(heartbeatRuns.id, run.id));
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
  });

  it("an expired controller cannot renew or dispatch even before a reaper claims it", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(false);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    const count = () => Number(apiMetrics.render().match(/paperclip_control_failures_total[{]reason="lease_loss"[}] ([0-9]+)/)![1]);
    const before = count();
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(count()).toBe(before + 1);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(LegacyControllerLeaseLostError);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_rejected");
    } finally { watch.stop(); }
  });
  it("only one competing recovery revokes the observed expired owner", async () => {
    const run = await seed();
    await expire(run.id);
    const attempts = await Promise.all([revokeExpiredLegacyController(db, run), revokeExpiredLegacyController(db, run)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
  });
  it("revocation reports the committed dispatch boundary instead of the caller's stale snapshot", async () => {
    const stale = await seed();
    expect(await renewLegacyControllerLease(db, stale, "dispatching")).toBe(true);
    await expire(stale.id);
    expect(stale.executionStage).toBe("preparing");
    expect(await revokeExpiredLegacyControllerWithState(db, stale)).toEqual({
      executionStage: "dispatching", processPid: null, processGroupId: null,
    });
    expect(await revokeExpiredLegacyControllerWithState(db, stale)).toBeNull();
  });
  it("a crash after revocation permits a later recovery claim", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await hasLiveLegacyController(db, claimed)).toBe(true);
    expect(await revokeExpiredLegacyController(db, claimed)).toBe(false);
    await expire(run.id);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await revokeExpiredLegacyController(db, saved)).toBe(true);
  });
  it("rejects foreign company renewal and revocation", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, { ...run, companyId: randomUUID() })).toBe(false);
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, { ...run, companyId: randomUUID() })).toBe(false);
  });
  it("never turns a terminal run back into owned execution", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("rejects dispatch at the lease deadline even if the database query never settles", async () => {
    const run = await seed();
    const hungDb = { update: () => ({ set: () => ({ where: () => ({ returning: () => new Promise(() => {}) }) }) }) } as unknown as typeof db;
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(hungDb, { ...run, controllerLeaseExpiresAt: new Date(Date.now() + 100) }, controller);
    try {
      const checked = expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      await vi.advanceTimersByTimeAsync(101);
      await checked;
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("renews on its own connection while every shared pool connection is blocked", async () => {
    const run = await seed();
    const pooled = createDb(database.connectionString, { maxConnections: 1 });
    const holder = createDb(database.connectionString);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holding = holder.transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id = ${run.companyId} for update`);
      locked();
      await released;
    });
    await isLocked;
    // The only pool connection now waits on a row lock, as in a lock convoy.
    // Drizzle queries are lazy: Promise.resolve() sends this one now.
    const starved = Promise.resolve(pooled.execute(sql`select id from companies where id = ${run.companyId} for update`));
    for (let i = 0; i < 100; i += 1) {
      const waiting = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%from companies where id =%for update%'`);
      if ((waiting as unknown as unknown[]).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(pooled, run, controller);
    try {
      const startedAt = Date.now();
      await Promise.race([watch.assertOwned("dispatching"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("renewal queued behind the blocked pool")), 5_000))]);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(controller.signal.aborted).toBe(false);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(saved.executionStage).toBe("dispatching");
    } finally {
      watch.stop();
      release();
      await holding;
      await starved;
      await holder.$client.end({ timeout: 1 });
      await pooled.$client.end({ timeout: 1 });
    }
  }, 20_000);

  it("keeps a claimed lease alive until the watcher starts, then hands over", async () => {
    const run = await seed();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      startClaimedLegacyControllerLease(db, run);
      expect(hasClaimedLegacyControllerRenewal(run.id)).toBe(true);
      // Executor setup is starved for longer than the original 60 s claim lease:
      // shift the row's clock forward each tick so expiry is real, not faked.
      for (let i = 0; i < 9; i += 1) {
        await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() + interval '5 seconds'` })
          .where(eq(heartbeatRuns.id, run.id));
        const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS);
        await vi.waitFor(async () => {
          const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
          expect(row.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(before.controllerLeaseExpiresAt!.getTime() + 30_000);
        });
      }
      // The watcher is created from the stale claim-time row; it must adopt, not abort.
      const controller = new AbortController();
      const watch = watchLegacyControllerLease(db, { ...run, controllerLeaseExpiresAt: new Date(Date.now() - 1) }, controller);
      expect(hasClaimedLegacyControllerRenewal(run.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(controller.signal.aborted).toBe(false);
      watch.stop();
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it("stops claim-time renewal once the run is no longer owned", async () => {
    const run = await seed();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      startClaimedLegacyControllerLease(db, run);
      await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, run.id));
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS);
      await vi.waitFor(() => expect(hasClaimedLegacyControllerRenewal(run.id)).toBe(false));
    } finally { vi.useRealTimers(); }
  });

  it("leaves native controller ownership to the native coordinator", () => {
    expect(legacyControllerClaim("native")).toEqual({});
  });
});

describe("legacy controller lease loss attribution", () => {
  it("attributes a failing renewal query to renewal_error", async () => {
    type WatchArgs = Parameters<typeof watchLegacyControllerLease>;
    const failingDb = { update: () => ({ set: () => ({ where: () => ({
      returning: () => Promise.reject(new Error("connection reset")) }) }) }) } as unknown as WatchArgs[0];
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = { id: randomUUID(), companyId: randomUUID(), runtimeMode: "legacy", controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } as WatchArgs[1];
    const watch = watchLegacyControllerLease(failingDb, run, controller);
    try {
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS + 1);
      expect(controller.signal.reason).toBeInstanceOf(LegacyControllerLeaseLostError);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_error");
      expect(controller.signal.reason.leaseLossTiming).toMatchObject({ renewalPendingMs: null, deadlineLateMs: null, renewalCount: 0 });
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  type WatchArgs = Parameters<typeof watchLegacyControllerLease>;
  const watchedRun = (leaseMs: number) => ({ id: randomUUID(), companyId: randomUUID(), runtimeMode: "legacy",
    controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + leaseMs) }) as WatchArgs[1];

  it("records a renewal still in flight when a stalled query reaches the deadline", async () => {
    let calls = 0;
    const stallingDb = { update: () => ({ set: () => ({ where: () => ({ returning: () => {
      calls += 1;
      return calls <= 2 ? Promise.resolve([{ id: "run" }]) : new Promise(() => {});
    } }) }) }) } as unknown as WatchArgs[0];
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(stallingDb, watchedRun(LEGACY_CONTROLLER_LEASE_MS), controller);
    try {
      await vi.advanceTimersByTimeAsync(2 * LEGACY_CONTROLLER_RENEW_MS);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_LEASE_MS + 1);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
      expect(controller.signal.reason.leaseLossTiming).toEqual({ sinceRenewalMs: LEGACY_CONTROLLER_LEASE_MS,
        renewalPendingMs: LEGACY_CONTROLLER_LEASE_MS - LEGACY_CONTROLLER_RENEW_MS, deadlineLateMs: 0, renewalCount: 2 });
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("records how late the deadline ran when the event loop was blocked", async () => {
    const idleDb = { update: () => ({ set: () => ({ where: () => ({ returning: () => new Promise(() => {}) }) }) }) } as unknown as WatchArgs[0];
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(idleDb, watchedRun(10), controller);
    try {
      const blockedUntil = Date.now() + 80;
      while (Date.now() < blockedUntil) { /* hold the event loop past the deadline */ }
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
      expect(controller.signal.reason.leaseLossTiming.deadlineLateMs).toBeGreaterThanOrEqual(60);
      expect(controller.signal.reason.leaseLossTiming.renewalPendingMs).toBeNull();
    } finally { watch.stop(); }
  });
});
