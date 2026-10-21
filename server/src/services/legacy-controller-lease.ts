import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, persistentDedicatedDb, type Db } from "@paperclipai/db";

// A boot UUID has meaning across containers; a numeric PID does not.
export const legacyControllerBootId = randomUUID();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;

type Run = typeof heartbeatRuns.$inferSelect;

/** Commit these fields in the same UPDATE that claims a queued run. */
export function legacyControllerClaim(runtimeMode: string) {
  if (runtimeMode === "native") return {};
  return {
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
  };
}

export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  const [renewed] = await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(renewed);
}

export async function hasLiveLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return false;
  const [owner] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  ));
  return Boolean(owner);
}

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent. */
export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return true;
  const [revoked] = await db.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(revoked);
}

type ClaimRenewal = { timer: ReturnType<typeof setInterval>; expiresAt: number };
const claimRenewals = new Map<string, ClaimRenewal>();
/** Upper bound for a claim nobody adopts; the run then expires normally. */
export const LEGACY_CLAIM_RENEWAL_MAX_MS = 10 * 60_000;

function stopClaimRenewal(runId: string) {
  const pending = claimRenewals.get(runId);
  if (!pending) return null;
  clearInterval(pending.timer);
  claimRenewals.delete(runId);
  return pending;
}

/** Keep a freshly claimed run's lease alive until executeRun starts its
 * watcher. The claim commits a 60 s lease, but executeRun reads the agent, the
 * run and recovery state on the shared pool first. Under pool starvation that
 * gap exceeded the lease, and the watcher aborted with "lease lost" before its
 * first renewal (PER-963: 22 runs at 12:23-12:35Z on 10-21). Renewal uses the
 * dedicated connection and stops by itself when the run is no longer running
 * under this controller (released, cancelled, revoked or finished). */
export function startClaimedLegacyControllerLease(sharedDb: Db, run: Run) {
  if (run.runtimeMode === "native" || run.controllerBootId !== legacyControllerBootId) return;
  if (claimRenewals.has(run.id)) return;
  const db = persistentDedicatedDb(sharedDb, "paperclip-legacy-controller-lease") ?? sharedDb;
  const startedAt = Date.now();
  let inFlight = false;
  const pending: ClaimRenewal = {
    expiresAt: run.controllerLeaseExpiresAt?.getTime() ?? startedAt + LEGACY_CONTROLLER_LEASE_MS,
    timer: setInterval(() => {
      if (inFlight) return;
      if (Date.now() - startedAt > LEGACY_CLAIM_RENEWAL_MAX_MS) { stopClaimRenewal(run.id); return; }
      inFlight = true;
      const attemptAt = Date.now();
      void renewLegacyControllerLease(db, run).then((renewed) => {
        if (claimRenewals.get(run.id) !== pending) return;
        if (renewed) pending.expiresAt = attemptAt + LEGACY_CONTROLLER_LEASE_MS;
        else stopClaimRenewal(run.id);
      }, () => { /* transient; the next tick retries before the lease ends */ })
        .finally(() => { inFlight = false; });
    }, LEGACY_CONTROLLER_RENEW_MS),
  };
  pending.timer.unref();
  claimRenewals.set(run.id, pending);
}

export function hasClaimedLegacyControllerRenewal(runId: string) {
  return claimRenewals.has(runId);
}

/** Abort the adapter if the controller cannot renew. Bound each check by the
 * lease duration even when the database connection never settles. */
export function watchLegacyControllerLease(sharedDb: Db, run: Run, controller: AbortController) {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { stop() {}, async assertOwned(_stage?: "dispatching") {} };
  }
  // Renewal is a sub-millisecond single-row UPDATE. On the shared pool it can
  // still wait the full lease behind connections blocked on issue-row locks,
  // which turned queueing into "lease lost". Renew on a dedicated connection.
  const db = persistentDedicatedDb(sharedDb, "paperclip-legacy-controller-lease") ?? sharedDb;
  let stopped = false;
  let pending = false;
  const lost = () => { if (!stopped) controller.abort(new Error("Legacy controller lease lost")); };
  // Adopt the claim-time renewal: its last success is newer than the row read.
  const adopted = stopClaimRenewal(run.id);
  let deadline = setTimeout(lost, Math.max(0,
    Math.max(run.controllerLeaseExpiresAt?.getTime() ?? 0, adopted?.expiresAt ?? 0) - Date.now()));
  deadline.unref();
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let renewed: boolean;
    try {
      renewed = await Promise.race([renewLegacyControllerLease(db, run, stage), aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost();
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    if (!stopped) {
      clearTimeout(deadline);
      deadline = setTimeout(lost, Math.max(0, LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt)));
      deadline.unref();
    }
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch(lost).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() { stopped = true; clearInterval(timer); clearTimeout(deadline); } };
}
