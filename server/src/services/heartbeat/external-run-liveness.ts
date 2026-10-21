import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, runLivenessOutbox, type Db } from "@paperclipai/db";
import type { AdapterExecutionResult, ExternalRunHandle, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { terminalizeLegacyExecution } from "../legacy-execution-recovery.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { logger } from "../../middleware/logger.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { readRunCancellation } from "../run-cancellation.js";
import { recordedExternalRunConfiguration } from "./external-run-state.js";
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
  const probe: Record<string, unknown> = { ...result, checkedAt: now.toISOString(),
    ...(previous.harvestAttempts !== undefined ? { harvestAttempts: previous.harvestAttempts } : {}),
  };
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
      else if (!result.result) decision.harvest = true;
      return decision;
    }
  }
}


function externalProbeDue() {
  return or(sql`coalesce(${heartbeatRuns.lastProgressAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= clock_timestamp() - interval '15 minutes'`,
          sql`(${heartbeatRuns.externalRunHandle}->>'dispatch') in ('prepared', 'submission_unknown') and coalesce(${heartbeatRuns.lastProgressAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= clock_timestamp() - interval '10 minutes'`,
          sql`${heartbeatRuns.deadlineAt} <= clock_timestamp()`,
          sql`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`);
}

type Run = typeof heartbeatRuns.$inferSelect;
interface Dependencies {
  getAdapter: (type: string) => ServerAdapterModule | undefined;
  resolveConfig: (companyId: string, config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onSettled: (run: Run, result: AdapterExecutionResult) => Promise<void>;
  onObserve: (run: Run) => Promise<void>;
  onTerminal: (run: Run) => Promise<void>;
  wake: (run: Run) => Promise<void>;
}

export async function boundedExternalRunOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
        reconcileIfNeeded: true, writeConditions: [eq(heartbeatRuns.livenessVersion, run.livenessVersion), eq(heartbeatRuns.observerEpoch, run.observerEpoch),
          ...(code === "external_result_unavailable"
            ? [or(sql`${heartbeatRuns.controllerLeaseExpiresAt} is null`, sql`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`)!] : [])],
      });
      if (!updated) return;
      if (redispatch) await recordConfirmedStop(tx as unknown as Db, updated, decision.probe);
      await tx.insert(runLivenessOutbox).values({ companyId: run.companyId, runId: run.id, action: "finalize_external_run",
        dedupeKey: `liveness:${run.id}`, payload: { redispatch } }).onConflictDoNothing();
      await event(tx as unknown as Db, run, code, decision.probe);
      counters[code] = (counters[code] ?? 0) + 1;
    });
  }
  function operatorStopped(run: Run) {
    const cancellation = readRunCancellation(run.resultJson);
    return run.status === "cancelled" && cancellation?.source === "operator" && cancellation.expected;
  }

  // Caller owns the issue/run locks. Never retire another run's or workspace's hold.
  async function recordConfirmedStop(tx: Db, run: Run, probe: Record<string, unknown>) {
    probe = { ...probe, handle: run.externalRunHandle };
    const reconciliation = { runId: run.id, providerStopped: true, actionOutcome: "mixed",
      probe, outcomeEvidence: JSON.stringify(probe), actorId: "external-liveness", recordedAt: new Date().toISOString() };
    const [updated] = await tx.update(heartbeatRuns).set({
      resultJson: { ...run.resultJson, executionReconciliation: reconciliation },
    }).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).returning();
    const issueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId;
    const holds = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId),
      typeof issueId === "string" ? eq(issueRecoveryActions.sourceIssueId, issueId) : sql`false`,
      eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
      eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`not (${issueRecoveryActions.evidence} ? 'workspaceRestoreFailure')`,
      sql`not (${issueRecoveryActions.evidence} ? 'workspaceRestoreRecovery')`,
    )).for("update");
    for (const hold of holds) await tx.update(issueRecoveryActions).set({
      status: "resolved", outcome: "recovered", resolvedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      wakePolicy: null, monitorPolicy: null,
      evidence: { ...hold.evidence, automaticRecovery: undefined, continuationDelivery: "not_requested", executionReconciliation: reconciliation },
    }).where(eq(issueRecoveryActions.id, hold.id));
    return updated;
  }

  async function reconcileOperatorStop(run: Run, result: ExternalRunProbe) {
    const issueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId;
    return db.transaction(async tx => {
      // Same lock order as terminalizeLegacyExecution and the normal release path.
      if (typeof issueId === "string") await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, run.companyId), eq(issues.id, issueId),
      )).for("update");
      const [current] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.livenessVersion, run.livenessVersion), eq(heartbeatRuns.observerEpoch, run.observerEpoch),
      )).for("update");
      if (!current || !operatorStopped(current) || current.runtimeMode !== "legacy") throw new Error("external stop evidence superseded");
      const probe = { ...result, checkedAt: new Date().toISOString(), handle: current.externalRunHandle, operatorStop: readRunCancellation(current.resultJson) };
      await tx.update(heartbeatRuns).set({ livenessProbe: probe, livenessVersion: sql`${heartbeatRuns.livenessVersion} + 1` })
        .where(eq(heartbeatRuns.id, current.id));
      if (result.state !== "gone" && result.state !== "settled") return false;
      await recordConfirmedStop(tx as unknown as Db, current, probe);
      const [parked] = typeof issueId === "string" ? await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.runId} is null`, sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      )).limit(1) : [];
      await tx.insert(runLivenessOutbox).values({ companyId: run.companyId, runId: run.id, action: "finalize_external_run",
        dedupeKey: `liveness:${run.id}`, payload: { redispatch: Boolean(parked) } }).onConflictDoNothing();
      await event(tx as unknown as Db, current, "provider_stopped", probe);
      return true;
    });
  }

  async function inspect(candidate: Run) {
    const [run] = await db.update(heartbeatRuns).set({ livenessClaimedUntil: sql`clock_timestamp() + interval '30 seconds'`,
      deadlineAt: sql`coalesce(${heartbeatRuns.deadlineAt}, coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) + interval '12 hours')` }).where(and(
      eq(heartbeatRuns.id, candidate.id), eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.livenessVersion, candidate.livenessVersion),
      or(sql`${heartbeatRuns.livenessClaimedUntil} is null`, sql`${heartbeatRuns.livenessClaimedUntil} <= clock_timestamp()`),
    )).returning();
    if (!run) return;
    const [{ now }] = await db.select({ now: sql<Date>`clock_timestamp()`.mapWith(heartbeatRuns.createdAt) }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    // Deadline enforcement must not depend on adapter discovery, credentials or provider availability.
    if (run.deadlineAt && run.deadlineAt <= now) {
      await finish(run, decideExternalRunLiveness(run, { state: "unknown", reason: "dispatch deadline elapsed" }, now));
      return;
    }
    let adapter: ServerAdapterModule | undefined;
    let result: ExternalRunProbe;
    let key: string | undefined;
    try {
      const saved = recordedExternalRunConfiguration(run);
      adapter = dependencies.getAdapter(saved.adapterType);
      if (!adapter?.probeRun) throw new Error("external_run_probe_unavailable");
      const config = await boundedExternalRunOperation(() => dependencies.resolveConfig(run.companyId, saved.config));
      key = `${adapter.type}:${String(config.baseUrl ?? config.apiUrl ?? config.gatewayUrl ?? "")}`;
      const breaker = breakers.get(key);
      if (breaker && breaker.until > now.getTime()) return;
      result = await boundedExternalRunOperation(signal => adapter!.probeRun!({ config, handle: run.externalRunHandle as ExternalRunHandle, signal }));
    } catch (error) {
      result = { state: "unknown", reason: error instanceof Error ? error.message : "probe failed" };
    }
    if (key) {
      if (result.state === "unknown") {
        const failures = (breakers.get(key)?.failures ?? 0) + 1;
        breakers.set(key, { failures, until: failures >= 5 ? now.getTime() + 60_000 : 0 });
      } else breakers.delete(key);
    }
    const decision = decideExternalRunLiveness(run, result, now);
    if (decision.harvest && !adapter?.observeRun) decision.end = "external_result_unavailable";
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
    const settledResult = result.state === "settled" ? result.result : undefined;
    if (settledResult || decision.alive || decision.harvest) {
      if (!settledResult && !adapter?.observeRun) return;
      const [claimed] = await db.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId,
        controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, observerEpoch: sql`${heartbeatRuns.observerEpoch} + 1`,
        livenessVersion: sql`${heartbeatRuns.livenessVersion} + 1`,
        ...(decision.harvest ? { livenessProbe: sql`jsonb_set(coalesce(${heartbeatRuns.livenessProbe}, '{}'::jsonb), '{harvestAttempts}', to_jsonb(coalesce((${heartbeatRuns.livenessProbe}->>'harvestAttempts')::int, 0) + 1))` } : {}),
      }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.livenessVersion, updated.livenessVersion),
        or(sql`${heartbeatRuns.controllerLeaseExpiresAt} is null`,sql`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`),
      )).returning();
      if (claimed) {
        if (settledResult) await dependencies.onSettled(claimed, settledResult);
        else await dependencies.onObserve(claimed);
      }
    }
  }
  async function sweep() {
    const candidates = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "legacy"), isNotNull(heartbeatRuns.externalRunHandle),
        or(sql`${heartbeatRuns.livenessClaimedUntil} is null`,sql`${heartbeatRuns.livenessClaimedUntil} <= clock_timestamp()`),
        externalProbeDue(),
      )).orderBy(sql`${heartbeatRuns.livenessClaimedUntil} asc nulls first`, asc(heartbeatRuns.createdAt)).limit(25);
    for (let i = 0; i < candidates.length; i += 4) await Promise.all(candidates.slice(i, i+4).map(async candidate => {
      try {
        await inspect(candidate);
      } catch (err) { logger.warn({ err, runId: candidate.id }, "External liveness remains retryable"); }
    }));
  }
  /** One bounded, company-scoped cutover page. Dry run never mutates or stops a provider.
   * The cursor advances past unprovable wakes, so they cannot starve later pages. */
  async function sweepParkedWakes(options: { companyId: string; afterWakeId?: string; apply?: boolean }) {
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, options.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      sql`${agentWakeupRequests.runId} is null`,
      options.afterWakeId ? sql`${agentWakeupRequests.id} > ${options.afterWakeId}::uuid` : undefined,
    )).orderBy(asc(agentWakeupRequests.id)).limit(25);
    const entries: Array<{ wakeId: string; issueId: string | null; runId: string | null; state: string; applied: boolean }> = [];
    const inspected = new Map<string, { state: string; applied: boolean }>();
    for (const wake of wakes) {
      const issueId = typeof wake.payload?.issueId === "string" ? wake.payload.issueId : null;
      const entry = { wakeId: wake.id, issueId, runId: null as string | null, state: "no_probeable_execution_hold", applied: false };
      entries.push(entry);
      if (!issueId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) continue;
      const hold = await getExecutionBlocker(db, options.companyId, issueId);
      const [task] = !hold?.runId ? await db.select({ executionRunId: issues.executionRunId }).from(issues).where(and(
        eq(issues.companyId, options.companyId), eq(issues.id, issueId),
      )) : [];
      entry.runId = hold?.runId ?? task?.executionRunId ?? null;
      if (!entry.runId) continue;
      if (inspected.has(entry.runId)) { Object.assign(entry, inspected.get(entry.runId)); continue; }
      try {
        const [run] = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, options.companyId), eq(heartbeatRuns.id, entry.runId),
        ));
        if (!run?.externalRunHandle || run.runtimeMode !== "legacy") { entry.state = "missing_durable_handle"; continue; }
        if (run.status !== "running" && !operatorStopped(run)) { entry.state = "manual_reconciliation_required"; continue; }
        if (run.status === "running") {
          const [due] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), externalProbeDue()));
          if (!due) { entry.state = "progress_grace"; continue; }
        }
        const saved = recordedExternalRunConfiguration(run), adapter = dependencies.getAdapter(saved.adapterType);
        if (!adapter?.probeRun) { entry.state = "probe_unavailable"; continue; }
        const config = await boundedExternalRunOperation(() => dependencies.resolveConfig(run.companyId, saved.config));
        const result = await boundedExternalRunOperation(signal => adapter.probeRun!({ config, handle: run.externalRunHandle as ExternalRunHandle, signal }));
        entry.state = result.state;
        if (operatorStopped(run)) {
          if (options.apply && (result.state === "gone" || result.state === "settled")) entry.applied = await reconcileOperatorStop(run, result);
        } else {
          const [{ now }] = await db.select({ now: sql<Date>`clock_timestamp()`.mapWith(heartbeatRuns.createdAt) }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
          const decision = decideExternalRunLiveness(run, result, now);
          if (decision.end === "external_session_gone") {
            if (options.apply) { await finish(run, decision); entry.applied = (await db.select({ code: heartbeatRuns.errorCode }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]?.code === "external_session_gone"; }
          } else if (result.state === "gone") entry.state = "gone_not_confirmed";
        }
      } catch (error) { entry.state = "probe_unprovable"; }
      finally { inspected.set(entry.runId, { state: entry.state, applied: entry.applied }); }
    }
    return { dryRun: !options.apply, entries, nextCursor: wakes.length === 25 ? wakes.at(-1)!.id : null };
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
        const [run] = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id,row.runId!),eq(heartbeatRuns.companyId,row.companyId!)));
        if (!run) throw new Error("external run outbox source missing");
        if (["running","queued"].includes(run.status)) throw new Error("external run is not terminal");
        const reconciliation = run.resultJson?.executionReconciliation as Record<string, unknown> | undefined;
        const stopped = operatorStopped(run) && reconciliation?.runId === run.id &&
          reconciliation.actorId === "external-liveness" && reconciliation.providerStopped === true &&
          ["gone", "settled"].includes(String(run.livenessProbe?.state)) &&
          isDeepStrictEqual(reconciliation.probe, run.livenessProbe) &&
          isDeepStrictEqual(run.livenessProbe?.handle, run.externalRunHandle) &&
          isDeepStrictEqual(run.livenessProbe?.operatorStop, readRunCancellation(run.resultJson));
        if (row.action === "stop_provider_session" && !stopped) {
          const saved=recordedExternalRunConfiguration(run);
          const adapter=dependencies.getAdapter(saved.adapterType);
          if (!adapter?.stopRun) throw new Error("adapter stopRun unavailable");
          const config=await boundedExternalRunOperation(() => dependencies.resolveConfig(run.companyId,saved.config));
          await boundedExternalRunOperation(signal=>adapter.stopRun!({config,handle:run.externalRunHandle as ExternalRunHandle,signal}));
          if (operatorStopped(run) && run.runtimeMode === "legacy") {
            if (!adapter.probeRun) throw new Error("adapter probeRun unavailable after operator stop");
            const probe = await boundedExternalRunOperation(signal => adapter.probeRun!({ config, handle: run.externalRunHandle as ExternalRunHandle, signal }));
            if (!await reconcileOperatorStop(run, probe)) throw new Error(`operator stop not confirmed: ${probe.state}`);
          }
        } else if (row.action === "stop_provider_session" && stopped) {
          // The stop proof committed before a lost ACK. Never stop the reused session again.
        } else if (row.action === "finalize_external_run") {
          // Persist/admit the recovery contract before releasing queued human
          // input. Otherwise terminal cleanup can promote an unsafe plain wake.
          if (row.payload.redispatch === true) await dependencies.wake(run);
          await dependencies.onTerminal(run);
        } else throw new Error("unknown external liveness outbox action");
        await db.update(runLivenessOutbox).set({status:"done",doneAt:sql`clock_timestamp()`,lastError:null}).where(fence);
      } catch(error) {
        await db.update(runLivenessOutbox).set({ lastError:error instanceof Error?error.message:"outbox delivery failed",
          nextAttemptAt:sql`clock_timestamp() + ${Math.min(300, 2 ** Math.min(claim.attempts,8))} * interval '1 second'` }).where(fence);
      }
    }
  }
  return { sweep, consumeOutbox, sweepParkedWakes, metrics: () => ({ ...counters }) };
}
