import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isControllerDraining } from "../controller-drain.js";

// Admission is not provider ownership. A suspended observer remains running,
// retains its immutable receipt and issue fence, and may only observe that run.
function suspendedAdmission() {
  return sql`coalesce(
    ${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension'->>'version' = '1'
    and ${heartbeatRuns.runtimeMode} = 'legacy'
    and ${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'omnigent'
    and ${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension'->>'runId' = ${heartbeatRuns.id}::text
    and ${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension'->>'companyId' = ${heartbeatRuns.companyId}::text
    and ${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension'->>'agentId' = ${heartbeatRuns.agentId}::text
    and ${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension'->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
    and ${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension'->>'omnigentSessionId' = ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId'
    and ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'runId' = ${heartbeatRuns.id}::text
    and ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'companyId' = ${heartbeatRuns.companyId}::text
    and ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'agentId' = ${heartbeatRuns.agentId}::text
    and ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'version' = '1'
    and ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'state' in ('intent', 'accepted', 'observed')
    and length(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId') > 0,
    false)`;
}

/** Issue id from a run context as uuid, or null. Comparing issues.id::text
 * defeats the primary-key index and detoasts the run context once per issue
 * of the agent (7 s live, PER-963); a guarded cast keeps the index lookup. */
function contextIssueUuid() {
  return sql`(case when ${heartbeatRuns.contextSnapshot}->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (${heartbeatRuns.contextSnapshot}->>'issueId')::uuid end)`;
}

export async function countAdmittedRunsForAgent(db: Db, agentId: string) {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running"),
      sql`not (${suspendedAdmission()})`));
  return Number(row.count);
}

/** Server-owned suspension, not a terminal outcome or a dispatch retry.
 * Intent can mean POST succeeded but its acknowledgement was lost. Silence,
 * blocked status and a dead controller never authorize cancelling that work.
 * ponytail: one sweep over running legacy observers; index if fleet size demands.
 */
export async function suspendOmnigentAdmissions(db: Db,
  probe: (run: typeof heartbeatRuns.$inferSelect) => Promise<"not_found" | "runner_offline" | null> = async () => null) {
  const candidates = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "legacy"),
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'omnigent'`,
    sql`${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension' is null`,
    // Filter before issuing one UPDATE per observer. Keep the write predicates
    // below as the authoritative race check; this read grants no new authority.
    sql`${heartbeatRuns.executionStage} in ('dispatching', 'external_attached', 'awaiting_external_evidence')`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'version' = '1'`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'runId' = ${heartbeatRuns.id}::text`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'companyId' = ${heartbeatRuns.companyId}::text`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'agentId' = ${heartbeatRuns.agentId}::text`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'state' in ('intent', 'accepted', 'observed')`,
    sql`length(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId') > 0`,
    sql`exists (select 1 from ${issues} where ${issues.id} = ${contextIssueUuid()}
      and ${issues.companyId} = ${heartbeatRuns.companyId} and ${issues.assigneeAgentId} = ${heartbeatRuns.agentId}
      and ${issues.status} != 'cancelled'
      and (greatest(${heartbeatRuns.startedAt}, ${heartbeatRuns.lastOutputAt}) <= clock_timestamp() - interval '2 hours'
        or (${issues.status} in ('blocked', 'in_review', 'done')
          and ${issues.updatedAt} < clock_timestamp() - interval '30 seconds'
          and ${heartbeatRuns.startedAt} < clock_timestamp() - interval '30 seconds')))`,
  ));
  const suspended: Array<typeof heartbeatRuns.$inferSelect> = [];
  for (const candidate of candidates) {
    const quiet = Math.max(candidate.startedAt?.getTime() ?? Date.now(), candidate.lastOutputAt?.getTime() ?? 0) <= Date.now() - 7200000;
    const reason = quiet ? await probe(candidate).catch(() => null) : null;
    // Without a probe reason only a finishing issue can qualify. Check that
    // cheaply first: the guarded UPDATE below detoasts run JSON and ran for
    // every observer on every tick while matching ~1 % of them (PER-963).
    // The UPDATE predicate stays authoritative.
    if (!reason) {
      const [issue] = await db.select({ status: issues.status }).from(issues).where(and(
        sql`${issues.id}::text = ${String(candidate.contextSnapshot?.issueId ?? "")}`,
        eq(issues.companyId, candidate.companyId)));
      if (!issue || !["blocked", "in_review", "done"].includes(issue.status)) continue;
    }
    const saved = await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ||
      jsonb_build_object('omnigentAdmissionSuspension', jsonb_build_object(
        'version', 1, 'runId', ${heartbeatRuns.id}, 'companyId', ${heartbeatRuns.companyId},
        'agentId', ${heartbeatRuns.agentId}, 'issueId', ${heartbeatRuns.contextSnapshot}->>'issueId',
        'omnigentSessionId', ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId',
        'suspendedAt', clock_timestamp(), 'reason', ${reason ?? 'bounded_external_observation'}::text))`,
  }).where(and(
    eq(heartbeatRuns.id, candidate.id),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${String(candidate.contextSnapshot?.issueId ?? "")}`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt' = ${JSON.stringify(candidate.resultJson?.omnigentDispatchReceipt ?? null)}::jsonb`,
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "legacy"),
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'omnigent'`,
    sql`${heartbeatRuns.executionStage} in ('dispatching', 'external_attached', 'awaiting_external_evidence')`,
    sql`${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension' is null`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'version' = '1'`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'runId' = ${heartbeatRuns.id}::text`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'companyId' = ${heartbeatRuns.companyId}::text`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'agentId' = ${heartbeatRuns.agentId}::text`,
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'state' in ('intent', 'accepted', 'observed')`,
    sql`length(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId') > 0`,
    sql`exists (select 1 from ${issues} where ${issues.id} = ${contextIssueUuid()}
      and ${issues.companyId} = ${heartbeatRuns.companyId} and ${issues.assigneeAgentId} = ${heartbeatRuns.agentId}
      and ${issues.status} != 'cancelled'
      and ((${Boolean(reason)} and greatest(${heartbeatRuns.startedAt}, ${heartbeatRuns.lastOutputAt}) <= clock_timestamp() - interval '2 hours')
        or (${issues.status} in ('blocked', 'in_review', 'done')
          and ${issues.updatedAt} < clock_timestamp() - interval '30 seconds'
          and ${heartbeatRuns.startedAt} < clock_timestamp() - interval '30 seconds')))`,
  )).returning();
    suspended.push(...saved);
  }
  return suspended;
}

/** Retire only the observer, not the provider work or its unknown effects.
 * A new durable wake owns continuation. Fresh negative evidence is mandatory;
 * bounded finishing suspension by itself is never takeover authority.
 */
export async function retireSuspendedOmnigentObservers(db: Db,
  probe: (run: typeof heartbeatRuns.$inferSelect) => Promise<"not_found" | "runner_offline" | null>) {
  const candidates = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.status, "running"), suspendedAdmission(),
    sql`greatest(${heartbeatRuns.startedAt}, ${heartbeatRuns.lastOutputAt}) < clock_timestamp() - interval '2 hours'`,
    sql`exists (select 1 from ${agentWakeupRequests} where
      ${agentWakeupRequests.companyId} = ${heartbeatRuns.companyId}
      and ${agentWakeupRequests.agentId} = ${heartbeatRuns.agentId}
      and ${agentWakeupRequests.payload}->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
      and ${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution'))`));
  const retired: Array<typeof heartbeatRuns.$inferSelect> = [];
  for (const candidate of candidates) {
    const reason = await probe(candidate).catch(() => null);
    if (!reason) continue;
    const issueId = String(candidate.contextSnapshot?.issueId ?? '');
    await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, issueId), eq(issues.companyId, candidate.companyId))).for('update');
      if (!issue || issue.assigneeAgentId !== candidate.agentId || ['done','cancelled'].includes(issue.status) ||
          (issue.executionRunId && issue.executionRunId !== candidate.id) ||
          (issue.checkoutRunId && issue.checkoutRunId !== candidate.id)) return;
      const [saved] = await tx.update(heartbeatRuns).set({
        status: 'interrupted', errorCode: 'omnigent_observer_retired',
        error: 'Offline observer retired for queued continuation; earlier action outcomes remain unknown.',
        finishedAt: sql`clock_timestamp()`, controllerLeaseExpiresAt: sql`clock_timestamp()`,
        controllerBootId: sql`gen_random_uuid()`,
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
          jsonb_build_object('omnigentObserverRetirement', jsonb_build_object(
            'version',1,'runId',${heartbeatRuns.id},'companyId',${heartbeatRuns.companyId},
            'agentId',${heartbeatRuns.agentId},'issueId',${issueId}::text,
            'omnigentSessionId',${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId',
            'retiredAt',clock_timestamp(),'reason',${reason}::text,
            'actionOutcomes','unknown','providerStopped',false),
            'summary','An offline observer was retired for a new wake. Prior action outcomes are unknown. Inspect retained evidence and actual targets before repeating any mutation.')`,
        updatedAt: new Date(),
      }).where(and(eq(heartbeatRuns.id,candidate.id),eq(heartbeatRuns.status,'running'),
        suspendedAdmission(),
        sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt' = ${JSON.stringify(candidate.resultJson?.omnigentDispatchReceipt)}::jsonb`,
        sql`greatest(${heartbeatRuns.startedAt}, ${heartbeatRuns.lastOutputAt}) < clock_timestamp() - interval '2 hours'`,
        sql`exists (select 1 from ${agentWakeupRequests} where
          ${agentWakeupRequests.companyId} = ${candidate.companyId} and ${agentWakeupRequests.agentId} = ${candidate.agentId}
          and ${agentWakeupRequests.payload}->>'issueId' = ${issueId}
          and ${agentWakeupRequests.status} in ('queued','deferred_issue_execution'))`,
      )).returning();
      if (saved) {
        if (saved.wakeupRequestId) await tx.update(agentWakeupRequests).set({
          status:'failed',finishedAt:new Date(),error:'Observer retired; original action outcomes unknown.',updatedAt:new Date(),
        }).where(and(eq(agentWakeupRequests.id,saved.wakeupRequestId),eq(agentWakeupRequests.companyId,saved.companyId)));
        retired.push(saved);
      }
    });
  }
  return retired;
}

/** Inside the SAME transaction as every queued -> running claim, after the
 * company-scoped issue row lock. Nonblocking agent locking avoids inversions.
 * ponytail: hash collisions conservatively defer unrelated agents.
 */
export async function admitAgentRun(tx: Db, companyId: string, agentId: string, maxConcurrentRuns: number,
  candidate: { id: string; issueId: string | null }) {
  if (isControllerDraining()) return false;
  const key = `paperclip:agent-admission:${companyId}:${agentId}`;
  const result = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as admitted`);
  if (!(result as unknown as Array<{ admitted: boolean }>)[0]?.admitted) return false;
  if (candidate.issueId) {
    const issueKey = `paperclip:issue-admission:${companyId}:${candidate.issueId}`;
    const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${issueKey}, 0)) as admitted`);
    if (!(locked as unknown as Array<{ admitted: boolean }>)[0]?.admitted) return false;
    // The old row is the fence even if issue locks were cleared, reassigned or
    // a different agent gets a review wake. Do not dispatch a second prompt.
    const [owner] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"),
      sql`${heartbeatRuns.id} != ${candidate.id}::uuid`,
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${candidate.issueId}`,
    )).limit(1);
    if (owner) return false;
  }
  return !isControllerDraining() && await countAdmittedRunsForAgent(tx, agentId) < maxConcurrentRuns;
}
