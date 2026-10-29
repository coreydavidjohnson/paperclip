import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";

export async function legacyExecutionWasReleased(
  db: Db,
  task: typeof issues.$inferSelect,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || !run.finishedAt ||
      !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status) ||
      task.companyId !== run.companyId || task.assigneeAgentId !== run.agentId ||
      (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== task.id ||
      !["todo", "in_progress"].includes(task.status) || task.updatedAt <= run.finishedAt) return false;
  const [release] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, task.companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.updated"),
    sql`coalesce(${activityLog.details}->'_previous'->>'status', ${activityLog.details}->>'previousStatus') = 'blocked'`,
    sql`${activityLog.details}->>'status' in ('todo', 'in_progress')`,
    gt(activityLog.createdAt, run.finishedAt),
  )).limit(1);
  if (release) return true;
  const [settledBlock] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
    eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
    gte(issueRecoveryActions.resolvedAt, run.finishedAt), lte(issueRecoveryActions.resolvedAt, task.updatedAt),
  )).limit(1);
  return Boolean(settledBlock);
}
