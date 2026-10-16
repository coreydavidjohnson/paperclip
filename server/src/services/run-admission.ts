import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
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
    sql`${heartbeatRuns.runnerProfileJson}->'omnigentAdmissionSuspension' is null`));
  const suspended: Array<typeof heartbeatRuns.$inferSelect> = [];
  for (const candidate of candidates) {
    const quiet = Math.max(candidate.startedAt?.getTime() ?? Date.now(), candidate.lastOutputAt?.getTime() ?? 0) <= Date.now() - 7200000;
    const reason = quiet ? await probe(candidate).catch(() => null) : null;
    const saved = await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ||
      jsonb_build_object('omnigentAdmissionSuspension', jsonb_build_object(
        'version', 1, 'runId', ${heartbeatRuns.id}, 'companyId', ${heartbeatRuns.companyId},
        'agentId', ${heartbeatRuns.agentId}, 'issueId', ${heartbeatRuns.contextSnapshot}->>'issueId',
        'omnigentSessionId', ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId',
        'suspendedAt', clock_timestamp(), 'reason', ${reason ?? 'bounded_external_observation'}))`,
  }).where(and(
    eq(heartbeatRuns.id, candidate.id),
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
    sql`exists (select 1 from ${issues} where ${issues.id}::text = ${heartbeatRuns.contextSnapshot}->>'issueId'
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
