import { and, asc, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** The repair transaction owns intent; ordinary heartbeat admission owns execution.
 * No recovery action ID enters the wake projection and no session reset is requested. */
export async function deliverGuardedStatusRepairs(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
  actionId?: string,
) {
  const pending = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.status, "resolved"),
    eq(issueRecoveryActions.kind, "deliberate_wait_without_target"),
    actionId ? eq(issueRecoveryActions.id, actionId) : undefined,
    sql`${issueRecoveryActions.evidence}->'guardedStatusRepair'->>'delivery' = 'pending'`,
  )).orderBy(asc(issueRecoveryActions.updatedAt), asc(issueRecoveryActions.id)).limit(25);
  for (const action of pending) {
    const receipt = action.evidence.guardedStatusRepair as Record<string, unknown>;
    // Rotate attempted rows so a blocked batch cannot starve younger intent.
    // Keep the action snapshot and evidence intact; only delivery scheduling moves.
    await db.update(issueRecoveryActions).set({ updatedAt: new Date() }).where(and(
      eq(issueRecoveryActions.id, action.id), eq(issueRecoveryActions.companyId, action.companyId),
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->'guardedStatusRepair' = ${JSON.stringify(receipt)}::jsonb`,
    ));
    if (!action.returnOwnerAgentId || receipt.actorType !== "user" || typeof receipt.actorId !== "string") continue;
    try {
      const run = await wake(action.returnOwnerAgentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        idempotencyKey: `guarded-status-repair:${action.id}`,
        payload: { issueId: action.sourceIssueId, mutation: "comment" },
        requestedByActorType: "user", requestedByActorId: receipt.actorId,
        contextSnapshot: {
          issueId: action.sourceIssueId, taskId: action.sourceIssueId,
          guardedStatusRepairId: action.id,
          wakeReason: "issue_commented", source: "issue.comment",
          paperclipAgentMessage: { text: action.resolutionNote, source: "board" },
        },
      });
      if (run) await db.update(issueRecoveryActions).set({
        evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{guardedStatusRepair,delivery}', '"delivered"'::jsonb)`,
      }).where(and(eq(issueRecoveryActions.id, action.id), eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->'guardedStatusRepair' = ${JSON.stringify(receipt)}::jsonb`));
    } catch (err) {
      logger.warn({ err, recoveryActionId: action.id }, "Guarded repair continuation remains pending");
    }
  }
}
