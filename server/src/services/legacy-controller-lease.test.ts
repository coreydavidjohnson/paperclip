import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { hasLiveLegacyController, legacyControllerBootId, legacyControllerClaim,
  renewLegacyControllerLease, revokeExpiredLegacyController, watchLegacyControllerLease,
  startClaimedLegacyControllerLease, hasClaimedLegacyControllerRenewal, LEGACY_CONTROLLER_RENEW_MS } from "./legacy-controller-lease.js";

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
  it("an expired controller cannot renew or dispatch even before a reaper claims it", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(false);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(controller.signal.aborted).toBe(true);
    } finally { watch.stop(); }
  });
  it("only one competing recovery revokes the observed expired owner", async () => {
    const run = await seed();
    await expire(run.id);
    const attempts = await Promise.all([revokeExpiredLegacyController(db, run), revokeExpiredLegacyController(db, run)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
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
