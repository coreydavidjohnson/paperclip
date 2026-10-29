import { activityLog, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { logActivity, type ActivityPublication } from "../activity-log.js";
import { assertRecoveryStatusWriteAllowed } from "../guarded-status-repair.js";

export async function enforceIssueRunBudget(
  db: Db,
  companyId: string,
  issueId: string,
  publications: ActivityPublication[],
  excludeRunId?: string,
) {
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).for("update");
  if (!issue || ["done", "cancelled"].includes(issue.status)) return null;
  const [release] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated"), eq(activityLog.actorType, "user"),
    sql`coalesce(${activityLog.details}->'_previous'->>'status', ${activityLog.details}->>'previousStatus') = 'blocked'`,
    sql`${activityLog.details}->>'status' in ('todo', 'in_progress')`,
  )).orderBy(desc(activityLog.createdAt)).limit(1);
  const epochStart = release ? sql`(select created_at from activity_log
    where company_id = ${companyId} and id = ${release.id})` : null;
  const [usage] = await db.select({
    observed: sql<number>`count(*)::int`,
    running: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')::int`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`,
    epochStart ? sql`greatest(${heartbeatRuns.createdAt}, ${heartbeatRuns.startedAt}) >= ${epochStart}` : undefined,
    excludeRunId ? ne(heartbeatRuns.id, excludeRunId) : undefined,
  ));
  if (usage.observed < 10) return null;
  const block = { reason: "issue.run_budget_exhausted", observed: usage.observed, limit: 10,
    message: `needs judging: ${usage.observed} runs. A person or board sweep must release this issue from blocked to todo or in_progress to reset its run budget.` };
  if (usage.running > 0) return block;
  const [notice] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
    eq(activityLog.action, "issue.updated"), eq(activityLog.actorType, "system"),
    sql`${activityLog.details}->>'reason' = 'issue.run_budget_exhausted'`,
    epochStart ? sql`${activityLog.createdAt} >= ${epochStart}` : undefined,
  )).limit(1);
  const statusChanged = issue.status !== "blocked" || issue.monitorNextCheckAt !== null || issue.monitorWakeRequestedAt !== null;
  if (statusChanged || !notice) await assertRecoveryStatusWriteAllowed(db, companyId, issueId);
  if (statusChanged) {
    await db.update(issues).set({ status: "blocked", monitorNextCheckAt: null,
      monitorWakeRequestedAt: null, updatedAt: new Date() }).where(and(
        eq(issues.companyId, companyId), eq(issues.id, issueId),
      ));
  }
  if (!notice) {
    await db.insert(issueComments).values({ companyId, issueId, authorType: "system", body: block.message });
    await logActivity(db, { companyId, actorType: "system", actorId: "issue-run-budget",
      action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { status: "blocked", _previous: { status: issue.status }, reason: block.reason,
        runCount: block.observed, limit: block.limit } }, publications);
  }
  return block;
}
