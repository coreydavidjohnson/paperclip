import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueRecoveryActions, issues, runLivenessOutbox, type Db } from "@paperclipai/db";
import type { AdapterExecutionResult, ExternalRunHandle, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { terminalizeLegacyExecution } from "../legacy-execution-recovery.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { logger } from "../../middleware/logger.js";
import type { ExternalRunProbe } from "@paperclipai/adapter-utils";

export const EXTERNAL_RUN_PROGRESS_GRACE_MS = 15 * 60_000;
export const EXTERNAL_RUN_GONE_CONFIRM_MS = 2 * 60_000;
export const EXTERNAL_RUN_UNKNOWN_CEILING_MS = 2 * 60 * 60_000;
export const EXTERNAL_RUN_PROBE_TIMEOUT_MS = 10_000;

type DecisionRun = { deadlineAt: Date | null; unknownSince: Date | null; livenessProbe: Record<string, unknown> | null };
type EndCode = "external_session_gone" | "external_liveness_unknown" | "external_deadline_exceeded" | "external_result_unavailable";
export interface ExternalLivenessDecision {
  probe: Record<string, unknown>;
  unknownSince: Date | null;
  alive?: boolean;
  harvest?: boolean;
  end?: EndCode;
}

/** Evidence is persisted with the run version; progress invalidates prior gone evidence. */
export function decideExternalRunLiveness(run: DecisionRun, result: ExternalRunProbe, now: Date): ExternalLivenessDecision {
  const previous = run.livenessProbe ?? {};
  const probe: Record<string, unknown> = { ...result, checkedAt: now.toISOString() };
  const decision: ExternalLivenessDecision = { probe, unknownSince: null };
  if (run.deadlineAt && run.deadlineAt <= now) return { ...decision, end: "external_deadline_exceeded" };
  switch (result.state) {
    case "active": return { ...decision, alive: true };
    case "gone": {
      const first = previous.state === "gone" && typeof previous.firstGoneAt === "string"
        ? new Date(previous.firstGoneAt) : now;
      probe.firstGoneAt = first.toISOString();
      if (result.authoritative || now.getTime() - first.getTime() >= EXTERNAL_RUN_GONE_CONFIRM_MS)
        decision.end = "external_session_gone";
      return decision;
    }
    case "unknown": {
      decision.unknownSince = run.unknownSince ?? now;
      if (now.getTime() - decision.unknownSince.getTime() >= EXTERNAL_RUN_UNKNOWN_CEILING_MS)
        decision.end = "external_liveness_unknown";
      return decision;
    }
    case "settled": {
      const attempts = Number(previous.harvestAttempts ?? 0);
      probe.harvestAttempts = attempts;
      if (!result.result && attempts >= 3) decision.end = "external_result_unavailable";
      else if (!result.result) { probe.harvestAttempts = attempts + 1; decision.harvest = true; }
      return decision;
    }
  }
}


type Run = typeof heartbeatRuns.$inferSelect;
interface Dependencies {
  getAdapter: (type: string) => ServerAdapterModule | undefined;
  onSettled: (run: Run, result: AdapterExecutionResult) => Promise<void>;
  onObserve: (run: Run) => Promise<void>;
  onTerminal: (run: Run) => Promise<void>;
  wake: (run: Run) => Promise<void>;
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("external run operation timed out")); }, EXTERNAL_RUN_PROBE_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer!); controller.abort(); }
}

/** Bounded, claimed sweeps. Durable versions fence results after output or takeover. */
export function createExternalRunLivenessWorker(db: Db, dependencies: Dependencies) {
  const breakers = new Map<string, { failures: number; until: number }>();
  const counters: Record<string, number> = {};
  async function event(tx: Db, run: Run, state: string, probe: Record<string, unknown>) {
    if (run.livenessProbe?.state === state) return;
    await appendHeartbeatRunEvent(tx, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: "external.liveness", stream: "system", level: "info", message: `External run is ${state}`, payload: probe });
  }
  async function finish(run: Run, decision: ExternalLivenessDecision) {
    const code = decision.end!;
    return db.transaction(async tx => {
      const redispatch = code === "external_session_gone";
      const resultJson = { ...run.resultJson,
        executionRecovery: { kind: "external_liveness", providerStopped: redispatch, actionOutcome: "mixed", probe: decision.probe },
        recovery: { redispatch, reconcileOnly: !redispatch, outcomesUnknown: true },
      };
      const updated = await terminalizeLegacyExecution({ db: tx as unknown as Db, run, status: "failed", fromStatuses: ["running"],
        patch: { errorCode: code, error: code.replaceAll("_", " "), finishedAt: sql`clock_timestamp()` as unknown as Date,
          observerEpoch: run.observerEpoch + 1, livenessVersion: run.livenessVersion + 1, livenessProbe: decision.probe,
          unknownSince: decision.unknownSince, livenessClaimedUntil: null, controllerLeaseExpiresAt: null, resultJson },
        reconcileIfNeeded: true, writeConditions: [eq(heartbeatRuns.livenessVersion, run.livenessVersion), eq(heartbeatRuns.observerEpoch, run.observerEpoch)],
      });
      if (!updated) return;
      // Stop evidence closes only this run's liveness hold, never workspace, approvals or dependencies.
      if (redispatch) {
        const holds = await tx.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
          sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
          sql`not (${issueRecoveryActions.evidence} ? 'workspaceRestoreFailure')`,
          sql`not (${issueRecoveryActions.evidence} ? 'workspaceRestoreRecovery')`,
        )).for("update");
        for (const hold of holds) await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "recovered", resolvedAt: sql`clock_timestamp()`,
          evidence: { ...hold.evidence, automaticRecovery: undefined, continuationDelivery: "not_requested",
            executionReconciliation: { runId: run.id, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: JSON.stringify(decision.probe), actorId: "external-liveness" } },
        }).where(eq(issueRecoveryActions.id, hold.id));
      }
      await tx.insert(runLivenessOutbox).values({ companyId: run.companyId, runId: run.id, action: "finalize_external_run",
        dedupeKey: `liveness:${run.id}`, payload: { redispatch } }).onConflictDoNothing();
      await event(tx as unknown as Db, run, code, decision.probe);
      counters[code] = (counters[code] ?? 0) + 1;
    });
  }
  async function inspect(candidate: Run, adapter: ServerAdapterModule, config: Record<string, unknown>) {
    const [run] = await db.update(heartbeatRuns).set({ livenessClaimedUntil: sql`clock_timestamp() + interval '30 seconds'` }).where(and(
      eq(heartbeatRuns.id, candidate.id), eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.livenessVersion, candidate.livenessVersion),
      or(sql`${heartbeatRuns.livenessClaimedUntil} is null`, sql`${heartbeatRuns.livenessClaimedUntil} <= clock_timestamp()`),
    )).returning();
    if (!run) return;
    const [{ now }] = await db.select({ now: sql<Date>`clock_timestamp()`.mapWith(heartbeatRuns.createdAt) }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const key = `${adapter.type}:${String(config.baseUrl ?? config.apiUrl ?? config.gatewayUrl ?? "")}`;
    const breaker = breakers.get(key);
    if (breaker && breaker.until > now.getTime() && (!run.deadlineAt || run.deadlineAt > now)) return;
    let result: ExternalRunProbe;
    try { result = await bounded(signal => adapter.probeRun!({ config, handle: run.externalRunHandle as ExternalRunHandle, signal })); }
    catch (error) { result = { state: "unknown", reason: error instanceof Error ? error.message : "probe failed" }; }
    if (result.state === "unknown") {
      const failures = (breaker?.failures ?? 0) + 1;
      breakers.set(key, { failures, until: failures >= 5 ? now.getTime() + 60_000 : 0 });
    } else breakers.delete(key);
    const decision = decideExternalRunLiveness(run, result, now);
    if (decision.end) { await finish(run, decision); return; }
    const updated = await db.transaction(async tx => {
      const [updated] = await tx.update(heartbeatRuns).set({
        livenessProbe: decision.probe, unknownSince: decision.unknownSince,
        ...(decision.alive ? { lastAliveAt: sql`clock_timestamp()` } : {}),
        livenessVersion: sql`${heartbeatRuns.livenessVersion} + 1`,
        // A two-minute probe cadence avoids repeatedly probing a still-quiet active turn.
        livenessClaimedUntil: sql`clock_timestamp() + interval '2 minutes'`,
      }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.livenessVersion, run.livenessVersion),
        eq(heartbeatRuns.observerEpoch, run.observerEpoch))).returning();
      if (updated) await event(tx as unknown as Db, run, result.state, decision.probe);
      return updated;
    });
    if (!updated) return;
    counters[result.state] = (counters[result.state] ?? 0) + 1;
    if (result.state === "settled" && result.result) { await dependencies.onSettled(updated, result.result); return; }
    if (decision.alive || decision.harvest) {
      if (!adapter.observeRun) return;
      const [claimed] = await db.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId,
        controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, observerEpoch: sql`${heartbeatRuns.observerEpoch} + 1`,
        livenessVersion: sql`${heartbeatRuns.livenessVersion} + 1`,
      }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.livenessVersion, updated.livenessVersion),
        or(sql`${heartbeatRuns.controllerLeaseExpiresAt} is null`,sql`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`),
      )).returning();
      if (claimed) await dependencies.onObserve(claimed);
    }
  }
  async function sweep() {
    const candidates = await db.select({ run: heartbeatRuns, adapterType: agents.adapterType, config: agents.adapterConfig }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
      .where(and(eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "legacy"), isNotNull(heartbeatRuns.externalRunHandle),
        or(sql`${heartbeatRuns.livenessClaimedUntil} is null`,sql`${heartbeatRuns.livenessClaimedUntil} <= clock_timestamp()`),
        or(sql`coalesce(${heartbeatRuns.lastProgressAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= clock_timestamp() - interval '15 minutes'`,
          sql`(${heartbeatRuns.externalRunHandle}->>'dispatch') in ('prepared', 'submission_unknown') and coalesce(${heartbeatRuns.lastProgressAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= clock_timestamp() - interval '10 minutes'`,
          sql`${heartbeatRuns.deadlineAt} <= clock_timestamp()`,
          sql`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`),
      )).orderBy(asc(heartbeatRuns.livenessClaimedUntil), asc(heartbeatRuns.createdAt)).limit(25);
    for (let i = 0; i < candidates.length; i += 4) await Promise.all(candidates.slice(i, i+4).map(async candidate => {
      const adapter = dependencies.getAdapter(candidate.adapterType);
      if (!adapter?.probeRun) return;
      try { await inspect(candidate.run, adapter, candidate.config ?? {}); }
      catch (err) { logger.warn({ err, runId: candidate.run.id }, "External liveness remains retryable"); }
    }));
  }
  async function consumeOutbox() {
    const pending = await db.select().from(runLivenessOutbox).where(and(eq(runLivenessOutbox.status, "pending"),
      sql`${runLivenessOutbox.nextAttemptAt} <= clock_timestamp()`)).orderBy(asc(runLivenessOutbox.nextAttemptAt)).limit(25);
    for (const row of pending) {
      const [claim] = await db.update(runLivenessOutbox).set({ attempts: sql`${runLivenessOutbox.attempts} + 1`,
        nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'` }).where(and(eq(runLivenessOutbox.id,row.id),
        eq(runLivenessOutbox.status,"pending"), eq(runLivenessOutbox.attempts,row.attempts),
        sql`${runLivenessOutbox.nextAttemptAt} <= clock_timestamp()`)).returning();
      if (!claim) continue;
      const fence = and(eq(runLivenessOutbox.id,row.id),eq(runLivenessOutbox.status,"pending"),eq(runLivenessOutbox.attempts,claim.attempts));
      try {
        const [entry] = await db.select({run:heartbeatRuns,agent:agents}).from(heartbeatRuns).innerJoin(agents,and(
          eq(agents.id,heartbeatRuns.agentId),eq(agents.companyId,heartbeatRuns.companyId))).where(and(
            eq(heartbeatRuns.id,row.runId!),eq(heartbeatRuns.companyId,row.companyId!)));
        if (!entry) throw new Error("external run outbox source missing");
        const {run,agent}=entry;
        if (["running","queued"].includes(run.status)) throw new Error("external run is not terminal");
        if (row.action === "stop_provider_session") {
          const adapter=dependencies.getAdapter(agent.adapterType);
          if (!adapter?.stopRun) throw new Error("adapter stopRun unavailable");
          await bounded(signal=>adapter.stopRun!({config:agent.adapterConfig ?? {},handle:run.externalRunHandle as ExternalRunHandle,signal}));
        } else if (row.action === "finalize_external_run") {
          await dependencies.onTerminal(run);
          if (row.payload.redispatch === true) await dependencies.wake(run);
        } else throw new Error("unknown external liveness outbox action");
        await db.update(runLivenessOutbox).set({status:"done",doneAt:sql`clock_timestamp()`,lastError:null}).where(fence);
      } catch(error) {
        await db.update(runLivenessOutbox).set({ lastError:error instanceof Error?error.message:"outbox delivery failed",
          nextAttemptAt:sql`clock_timestamp() + ${Math.min(300, 2 ** Math.min(claim.attempts,8))} * interval '1 second'` }).where(fence);
      }
    }
  }
  return { sweep, consumeOutbox, metrics: () => ({ ...counters }) };
}
