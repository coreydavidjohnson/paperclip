import { and, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";

/** Keep the effective-issue expression identical to the heartbeat history index.
 * A completed, exact idempotent successor is an acknowledgement, not a new wake.
 * Null legacy resolution boundaries cannot prove supersession.
 */
export function supersededRecoveryContinuationPredicate() {
  return sql`exists (
    select 1 from heartbeat_runs recovery_success
    where recovery_success.company_id = ${issueRecoveryActions.companyId}
      and coalesce(recovery_success.native_issue_id::text, recovery_success.context_snapshot->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text
      and recovery_success.status = 'succeeded'
      and recovery_success.finished_at > ${issueRecoveryActions.resolvedAt}
      and not exists (
        select 1 from agent_wakeup_requests recovery_ack
        where recovery_ack.company_id = ${issueRecoveryActions.companyId}
          and recovery_ack.agent_id = ${issueRecoveryActions.returnOwnerAgentId}
          and recovery_ack.idempotency_key = 'execution-reconciliation:' || ${issueRecoveryActions.id}::text
          and recovery_ack.run_id = recovery_success.id
          and recovery_ack.status <> 'skipped'
          and recovery_ack.requested_by_actor_type = 'system'
          and recovery_ack.requested_by_actor_id = 'execution-recovery'
          and recovery_ack.payload->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text
          and recovery_ack.payload->>'recoveryActionId' = ${issueRecoveryActions.id}::text
          and recovery_success.context_snapshot->>'recoveryActionId' = ${issueRecoveryActions.id}::text
          and recovery_success.context_snapshot->>'previousRunId' = ${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId'
      )
  )`;
}

/** Caller owns the transaction (and the issue/action locks during admission).
 * Sweep before the delivery limit, so old pending records cannot starve cleanup.
 * Preserve delivered history, original evidence, decisions and continuation IDs.
 */
export async function invalidateSupersededRecoveryContinuations(
  db: Db,
  action?: { companyId: string; id: string },
) {
  const now = new Date();
  const invalidated = await db.update(issueRecoveryActions).set({
    updatedAt: now,
    evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      continuationDelivery: "invalidated",
      continuationInvalidationReason: "newer_successful_run",
      continuationInvalidatedAt: now.toISOString(),
    })}::jsonb`,
  }).where(and(
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    action ? and(eq(issueRecoveryActions.companyId, action.companyId), eq(issueRecoveryActions.id, action.id)) : undefined,
    supersededRecoveryContinuationPredicate(),
  )).returning({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId, issueId: issueRecoveryActions.sourceIssueId });
  for (const row of invalidated) {
    await persistActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "execution-recovery",
      action: "issue.recovery_continuation_invalidated", entityType: "issue", entityId: row.issueId,
      details: { recoveryActionId: row.id, reason: "newer_successful_run" },
    });
  }
  return invalidated.length;
}
