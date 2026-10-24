import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, persistentDedicatedDb, type Db } from "@paperclipai/db";
import type { LegacyControllerLeaseLossCause, LegacyControllerLeaseLossTiming } from "./run-cancellation.js";

// A boot UUID has meaning across containers; a numeric PID does not.
export const legacyControllerBootId = randomUUID();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;

type Run = typeof heartbeatRuns.$inferSelect;

/** A lease lost before adapter dispatch: no provider work began, so the
 * continuation is retryable rather than an opaque `setup_failed`. */
export const CONTROLLER_LEASE_LOST_FAILURE_CODE = "controller_lease_lost";

/** Abort reason for a lost lease, so completion can attribute the stop. */
export class LegacyControllerLeaseLostError extends Error {
  constructor(
    readonly leaseLossCause: LegacyControllerLeaseLossCause,
    readonly leaseLossTiming?: LegacyControllerLeaseLossTiming,
  ) {
    super("Legacy controller lease lost");
    this.name = "LegacyControllerLeaseLostError";
  }
}

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
  run: Pick<Run, "id" | "companyId" | "controllerBootId" | "observerEpoch">,
  stage?: "dispatching",
): Promise<boolean> {
  const [renewed] = await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    eq(heartbeatRuns.observerEpoch, run.observerEpoch),
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

export type RevokedLegacyControllerState = Pick<Run, "executionStage" | "processPid" | "processGroupId">;

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent.
 * Returns the stage and process identifiers committed with the revocation, or
 * null when another writer owns the row. They cannot advance afterwards,
 * because renewal requires the replaced boot ID. */
export async function revokeExpiredLegacyControllerWithState(
  db: Db,
  run: Run,
): Promise<RevokedLegacyControllerState | null> {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { executionStage: run.executionStage, processPid: run.processPid, processGroupId: run.processGroupId };
  }
  const [revoked] = await db.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({
    executionStage: heartbeatRuns.executionStage,
    processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId,
  });
  return revoked ?? null;
}

export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  return (await revokeExpiredLegacyControllerWithState(db, run)) !== null;
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
  // Timing evidence for a loss: a renewal still in flight at the deadline
  // points at the database; a late deadline callback points at the event loop.
  let lastRenewedAt = Date.now();
  let renewalCount = 0;
  const renewalsInFlight = new Set<{ startedAt: number }>();
  let deadlineDueAt = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const lost = (cause: LegacyControllerLeaseLossCause) => {
    if (stopped || controller.signal.aborted) return;
    const now = Date.now();
    const oldestRenewal = Math.min(...[...renewalsInFlight].map((renewal) => renewal.startedAt));
    controller.abort(new LegacyControllerLeaseLostError(cause, {
      sinceRenewalMs: now - lastRenewedAt,
      renewalPendingMs: renewalsInFlight.size > 0 ? now - oldestRenewal : null,
      deadlineLateMs: cause === "renewal_deadline" ? Math.max(0, now - deadlineDueAt) : null,
      renewalCount,
    }));
  };
  const deadlinePassed = () => lost("renewal_deadline");
  const armDeadline = (delayMs: number) => {
    clearTimeout(deadline);
    deadlineDueAt = Date.now() + delayMs;
    deadline = setTimeout(deadlinePassed, delayMs);
    deadline.unref();
  };
  const adopted = stopClaimRenewal(run.id);
  armDeadline(Math.max(0, Math.max(run.controllerLeaseExpiresAt?.getTime() ?? 0, adopted?.expiresAt ?? 0) - Date.now()));
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    const renewal = { startedAt };
    renewalsInFlight.add(renewal);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let renewed: boolean;
    try {
      renewed = await Promise.race([renewLegacyControllerLease(db, run, stage), aborted]);
    } finally {
      renewalsInFlight.delete(renewal);
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost("renewal_rejected");
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    if (!stopped) {
      lastRenewedAt = Date.now();
      renewalCount += 1;
      armDeadline(Math.max(0, LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt)));
    }
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch(() => lost("renewal_error")).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() { stopped = true; clearInterval(timer); clearTimeout(deadline); } };
}
