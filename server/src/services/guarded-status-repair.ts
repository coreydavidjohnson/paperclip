import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";
import { logger } from "../middleware/logger.js";

/** Call only inside the caller's transaction. Source -> action lock order is
 * shared by ordinary writes and the exact board repair. No public bypass. */
export async function assertRecoveryStatusWriteAllowed(tx: Pick<Db, "select">, companyId: string, issueId: string) {
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
  const [action] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    eq(issueRecoveryActions.kind, "deliberate_wait_without_target"), eq(issueRecoveryActions.ownerType, "board"),
    sql`${issueRecoveryActions.wakePolicy}->>'type' = 'board_escalation'`,
    sql`${issueRecoveryActions.evidence}->>'terminalReason' = 'unchanged_source_state_exhausted'`,
  )).for("update");
  if (action) throw conflict("Resolve this exact recovery escalation before changing the task status.", {
    code: "recovery_status_repair_required", recoveryActionId: action.id,
  });
}

/** The repair transaction owns intent; ordinary heartbeat admission owns execution.
 * No recovery action ID enters the wake projection and no session reset is requested. */
export async function deliverGuardedStatusRepairs(
  db: Db,
  wake: (agentId: string, options: WakeupOptions) => Promise<{ id: string } | null>,
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
