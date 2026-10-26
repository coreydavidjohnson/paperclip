import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  completionContracts,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  type Db,
} from "@paperclipai/db";
import { isUuidLike, type IssueRecoveryAction } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
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

type BoardTodoHandbackIssue = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "lastStatusDecisionId"
  | "unblockDescriptor"
>;

type BoardTodoHandbackAction = Pick<
  IssueRecoveryAction,
  | "id"
  | "companyId"
  | "sourceIssueId"
  | "kind"
  | "ownerType"
  | "ownerAgentId"
  | "ownerUserId"
  | "previousOwnerAgentId"
  | "returnOwnerAgentId"
  | "cause"
  | "fingerprint"
  | "evidence"
  | "nextAction"
  | "wakePolicy"
>;

/**
 * Check only source provenance. The route owns action state, snapshot freshness,
 * and hand-back gates, so a settled action remains replay-verifiable here.
 */
export async function isSupportedBoardTodoHandback(
  tx: Pick<Db, "select">,
  issue: BoardTodoHandbackIssue,
  action: BoardTodoHandbackAction,
): Promise<boolean> {
  const ownerAgentId = issue.assigneeAgentId;
  const evidence = action.evidence;
  const wakePolicy = parseObject(action.wakePolicy);
  const descriptor = issue.unblockDescriptor;
  if (
    issue.status !== "todo" ||
    !ownerAgentId ||
    issue.assigneeUserId ||
    action.companyId !== issue.companyId ||
    action.sourceIssueId !== issue.id ||
    action.kind !== "deliberate_wait_without_target" ||
    action.cause !== "deliberate_wait_without_target" ||
    action.ownerType !== "board" ||
    action.ownerAgentId !== null ||
    action.ownerUserId !== null ||
    action.previousOwnerAgentId !== ownerAgentId ||
    action.returnOwnerAgentId !== ownerAgentId ||
    wakePolicy.type !== "board_escalation" ||
    wakePolicy.preservesSourceAssignee !== true ||
    evidence.terminalReason === "unchanged_source_state_exhausted"
  ) {
    return false;
  }

  const descriptorMatches =
    descriptor?.owner === "board" && descriptor.action === action.nextAction;
  const runId = evidence.runId;
  const decisionId = evidence.decisionId;
  if (
    descriptorMatches &&
    issue.lastStatusDecisionId === decisionId &&
    typeof runId === "string" && isUuidLike(runId) &&
    typeof decisionId === "string" && isUuidLike(decisionId) &&
    action.fingerprint === `native-blocked:${issue.companyId}:${issue.id}:${runId}`
  ) {
    const [proof] = await tx
      .select({ decisionJson: statusDecisions.decisionJson })
      .from(statusDecisionEffects)
      .innerJoin(statusDecisions, and(
        eq(statusDecisions.id, statusDecisionEffects.decisionId),
        eq(statusDecisions.companyId, statusDecisionEffects.companyId),
        eq(statusDecisions.issueId, statusDecisionEffects.issueId),
      ))
      .innerJoin(heartbeatRuns, and(
        eq(heartbeatRuns.id, statusDecisions.runId),
        eq(heartbeatRuns.companyId, statusDecisions.companyId),
        eq(heartbeatRuns.nativeIssueId, issue.id),
        eq(heartbeatRuns.agentId, ownerAgentId),
        eq(heartbeatRuns.runtimeMode, "native"),
      ))
      .where(and(
        eq(statusDecisionEffects.companyId, issue.companyId),
        eq(statusDecisionEffects.issueId, issue.id),
        eq(statusDecisionEffects.decisionId, decisionId),
        eq(statusDecisionEffects.effectKind, "bind_blocker"),
        eq(statusDecisionEffects.targetType, "issue_recovery_action"),
        eq(statusDecisionEffects.targetId, action.id),
        eq(statusDecisionEffects.deliveryState, "delivered"),
        eq(statusDecisions.runId, runId),
        eq(statusDecisions.applicationState, "applied"),
        eq(statusDecisions.toStatus, "todo"),
      ))
      .limit(1);
    if (proof) {
      const decision = parseObject(proof.decisionJson);
      const decisionDescriptor = parseObject(decision.unblockDescriptor);
      const recoveryHoldEffect = Array.isArray(decision.effects) && decision.effects.some((value) => {
        const effect = parseObject(value);
        return effect.kind === "bind_blocker" && effect.recoveryHold === true &&
          effect.owner === "board" && effect.action === action.nextAction;
      });
      if (
        decision.toStatus === "todo" &&
        decisionDescriptor.owner === "board" &&
        decisionDescriptor.action === action.nextAction &&
        recoveryHoldEffect
      ) {
        return true;
      }
    }
  }

  const latestRunId = evidence.latestRunId;
  const nativeResultId = evidence.nativeResultId;
  const completionContractId = evidence.completionContractId;
  if (
    descriptorMatches &&
    typeof latestRunId === "string" && isUuidLike(latestRunId) &&
    typeof nativeResultId === "string" && isUuidLike(nativeResultId) &&
    typeof completionContractId === "string" && isUuidLike(completionContractId) &&
    action.fingerprint === `native-blocked:${issue.companyId}:${issue.id}:${nativeResultId}`
  ) {
    const [proof] = await tx
      .select({
        resultJson: nativeRunResults.resultJson,
        decisionId: nativeRunFinalizations.decisionId,
        assessmentId: nativeRunFinalizations.assessmentId,
      })
      .from(nativeRunResults)
      .innerJoin(nativeRunFinalizations, and(
        eq(nativeRunFinalizations.resultId, nativeRunResults.id),
        eq(nativeRunFinalizations.companyId, nativeRunResults.companyId),
        eq(nativeRunFinalizations.issueId, nativeRunResults.issueId),
        eq(nativeRunFinalizations.runId, nativeRunResults.runId),
      ))
      .innerJoin(heartbeatRuns, and(
        eq(heartbeatRuns.id, nativeRunResults.runId),
        eq(heartbeatRuns.companyId, nativeRunResults.companyId),
        eq(heartbeatRuns.nativeIssueId, nativeRunResults.issueId),
        eq(heartbeatRuns.completionContractId, nativeRunResults.completionContractId),
        eq(heartbeatRuns.agentId, ownerAgentId),
        eq(heartbeatRuns.runtimeMode, "native"),
        eq(heartbeatRuns.status, "succeeded"),
      ))
      .innerJoin(completionContracts, and(
        eq(completionContracts.id, nativeRunResults.completionContractId),
        eq(completionContracts.companyId, nativeRunResults.companyId),
        eq(completionContracts.issueId, nativeRunResults.issueId),
      ))
      .innerJoin(statusDecisions, and(
        eq(statusDecisions.id, nativeRunFinalizations.decisionId),
        eq(statusDecisions.assessmentId, nativeRunFinalizations.assessmentId),
        eq(statusDecisions.companyId, nativeRunFinalizations.companyId),
        eq(statusDecisions.issueId, nativeRunFinalizations.issueId),
        eq(statusDecisions.runId, nativeRunFinalizations.runId),
        eq(statusDecisions.applicationState, "applied"),
      ))
      .where(and(
        eq(nativeRunResults.id, nativeResultId),
        eq(nativeRunResults.companyId, issue.companyId),
        eq(nativeRunResults.issueId, issue.id),
        eq(nativeRunResults.runId, latestRunId),
        eq(nativeRunResults.completionContractId, completionContractId),
        eq(nativeRunResults.schemaStatus, "accepted"),
        eq(nativeRunFinalizations.phase, "committed"),
      ))
      .limit(1);
    if (!proof || issue.lastStatusDecisionId !== proof.decisionId) return false;
    if (proof.assessmentId) {
      const [assessment] = await tx.select({ triggerKind: workAssessments.triggerKind }).from(workAssessments).where(and(
        eq(workAssessments.id, proof.assessmentId), eq(workAssessments.companyId, issue.companyId),
        eq(workAssessments.issueId, issue.id), eq(workAssessments.runId, latestRunId),
        eq(workAssessments.resultId, nativeResultId), eq(workAssessments.contractId, completionContractId),
      )).limit(1);
      if (assessment?.triggerKind !== "native_result") return false;
    }

    const envelope = parseObject(proof.resultJson);
    const result = parseObject(envelope.result);
    const terminal = parseObject(envelope.terminal);
    const blocker = parseObject(result.blocker);
    return result.schema === "paperclip.run_result.v1" &&
      result.reportedWorkDisposition === "blocked" &&
      terminal.runTerminalState === "succeeded" &&
      terminal.reportedWorkDisposition === "blocked" &&
      ["current_track", "task_wide"].includes(String(blocker.scope)) &&
      typeof blocker.unblockAction === "string" &&
      blocker.unblockAction === action.nextAction;
  }

  // Bounded-owner terminal reasons do not yet have an independent source
  // proof in this helper. Keep them out rather than infer authority from prose.
  return false;
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
    inArray(issueRecoveryActions.kind, ["deliberate_wait_without_target", "missing_disposition", "workspace_validation"]),
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
      // Converge a committed admission before asking for any new authority.
      // A newer pause, owner decision, or recovery hold must not cause a
      // second turn or prevent acknowledgement of the already committed one.
      const [admitted] = await db.select({ id: heartbeatRuns.id })
        .from(agentWakeupRequests)
        .innerJoin(heartbeatRuns, and(
          eq(heartbeatRuns.id, agentWakeupRequests.runId),
          eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id),
          eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
          eq(heartbeatRuns.agentId, agentWakeupRequests.agentId),
        ))
        .where(and(
          eq(agentWakeupRequests.companyId, action.companyId),
          eq(agentWakeupRequests.agentId, action.returnOwnerAgentId),
          eq(agentWakeupRequests.idempotencyKey, `guarded-status-repair:${action.id}`),
          eq(agentWakeupRequests.requestedByActorType, "user"),
          eq(agentWakeupRequests.requestedByActorId, receipt.actorId),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${action.sourceIssueId}`,
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${action.sourceIssueId}`,
          sql`${heartbeatRuns.contextSnapshot}->>'guardedStatusRepairId' = ${action.id}`,
        )).limit(1);
      const run = admitted ?? await wake(action.returnOwnerAgentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        idempotencyKey: `guarded-status-repair:${action.id}`,
        payload: { issueId: action.sourceIssueId, mutation: "comment" },
        requestedByActorType: "user", requestedByActorId: receipt.actorId,
        contextSnapshot: {
          issueId: action.sourceIssueId, taskId: action.sourceIssueId,
          guardedStatusRepairId: action.id,
          wakeReason: "issue_commented", source: "issue.comment",
          paperclipAgentMessage: { text: typeof receipt.continuationNote === "string" ? receipt.continuationNote : action.resolutionNote, source: "board" },
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
