import { notifyDeliveryWork, DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { and, eq } from "drizzle-orm";
import {
  issues,
  issueThreadInteractions,
  toolActionRequests,
  toolInvocations,
  toolActionDeliveries,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertChiefRelayRunWriteAllowed } from "../lib/chief-relay-run.js";
import { readChiefRelay, sameChiefRelay, type ChiefRelay } from "./chief-relay-types.js";
import { assertIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";
import { emitConnectionInvoked } from "./connector-telemetry.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

/** The shared transaction for both task and Connections review decisions. */
export async function commitToolActionReview(
  db: Db,
  input: {
    companyId: string;
    actionRequestId: string;
    issueId?: string;
    interactionId?: string;
    decision: "approved" | "rejected";
    rememberAction?: boolean;
    reason?: string;
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null; chiefRelay?: ChiefRelay };
  },
) {
  const relay = readChiefRelay(input.actor.chiefRelay);
  if (input.actor.chiefRelay && (!relay || !input.actor.agentId || input.actor.userId
    || relay.agentId !== input.actor.agentId || relay.companyId !== input.companyId)) {
    throw forbidden("Chief relay does not match the tool review actor or company");
  }
  if (input.actor.agentId && !relay)
    throw forbidden("Only a human can resolve a tool review");
  const userId = relay ? null : input.actor.userId ?? "board";
  const agentId = relay ? relay.agentId : null;
  const runId = relay ? input.actor.runId ?? null : null;
  const [source] = await db
    .select()
    .from(toolActionRequests)
    .where(
      and(
        eq(toolActionRequests.id, input.actionRequestId),
        eq(toolActionRequests.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!source) throw notFound("Tool action request not found");
  if (relay && (!source.issueId || !source.interactionId))
    throw conflict("Chief relay requires a linked tool review interaction");
  if ((input.issueId || input.interactionId) && (!input.issueId || !input.interactionId || source.issueId !== input.issueId || source.interactionId !== input.interactionId)) {
    throw conflict("Tool action request does not belong to this interaction");
  }
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (tx) => {
    const [issue] = source.issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, source.issueId),
              eq(issues.companyId, input.companyId),
            ),
          )
          .for("update")
      : [];
    // Match task mutation lock ordering: issue, then actual submitting run.
    // Stop updates the same run row, so revocation and this decision serialize.
    if (relay) await assertChiefRelayRunWriteAllowed(tx as unknown as Db, relay, runId);
    const [interaction] = source.interactionId
      ? await tx
          .select()
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.id, source.interactionId),
              eq(issueThreadInteractions.companyId, input.companyId),
            ),
          )
          .for("update")
      : [];
    const [current] = await tx
      .select()
      .from(toolActionRequests)
      .where(
        and(
          eq(toolActionRequests.id, source.id),
          eq(toolActionRequests.companyId, input.companyId),
        ),
      )
      .for("update");
    if (!current) throw notFound("Tool action request not found");
    if (current.status !== "pending") {
      if (
        (input.decision === "approved" &&
          ["approved", "executing", "executed", "failed"].includes(
            current.status,
          )) ||
        current.status === input.decision
      ) {
        if (relay && (!interaction || interaction.resolvedByAgentId !== agentId
          || interaction.resolvedByUserId !== null || !sameChiefRelay((interaction.result as unknown as Record<string, unknown> | null)?.chiefRelay, relay))) {
          throw conflict("This review was resolved by a different decision");
        }
        return current;
      }
      throw conflict("This review has already been resolved");
    }
    if (
      source.issueId &&
      (!issue || issue.status === "done" || issue.status === "cancelled")
    )
      throw conflict("This task is closed");
    const [invocation] = await tx
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.id, current.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ),
      )
      .limit(1);
    if (
      !invocation ||
      invocation.issueId !== current.issueId ||
      (current.requestedByAgentId &&
        invocation.agentId !== current.requestedByAgentId)
    )
      throw conflict("Tool invocation context does not match");
    if (current.expiresAt && current.expiresAt <= new Date())
      throw conflict("This review has expired");
    if (current.interactionId) {
      const payload = interaction?.payload as {
        toolAction?: { actionRequestId?: string; invocationId?: string };
      } | null;
      if (
        !interaction ||
        interaction.issueId !== current.issueId ||
        payload?.toolAction?.actionRequestId !== current.id ||
        payload.toolAction.invocationId !== current.invocationId
      )
        throw conflict("Tool review context does not match");
      assertIssueThreadInteractionResolverAudience({
        actor: relay
          ? { type: "chief_relay", agentId: relay.agentId, representedUserId: relay.representedUserId, runId }
          : { type: "user", userId: userId! },
        interaction,
        governedAction: true,
      });
      if (interaction.status !== "pending")
        throw conflict("This review has already been resolved");
    }
    const now = new Date();
    const [updated] = await tx
      .update(toolActionRequests)
      .set({
        status: input.decision,
        resolvedByUserId: userId,
        decidedByUserId: userId,
        decidedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(toolActionRequests.id, current.id))
      .returning();
    if (input.rememberAction) {
      if (input.decision !== "approved")
        throw conflict("Only an approval can remember permission");
      await toolAccessPolicyService(
        tx as unknown as Db,
      ).createTrustRuleFromActionRequest({
        companyId: input.companyId,
        actionRequestId: current.id,
        body: { approvalThreshold: 1, priority: 40, argumentMode: "action" },
        actor: { agentId, userId, ...(relay ? { chiefRelay: relay } : {}) },
      });
    }
    await tx
      .update(toolInvocations)
      .set({
        approvalState: input.decision,
        ...(input.decision === "rejected"
          ? {
              status: "denied" as const,
              completedAt: now,
              errorCode: "action_declined",
              errorMessage: relay ? "Chief relayed the instruction to decline this action." : "The human declined this action.",
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(toolInvocations.id, current.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ),
      );
    if (interaction && issue) {
      await tx
        .update(issueThreadInteractions)
        .set({
          status: input.decision === "approved" ? "accepted" : "rejected",
          resolvedByAgentId: agentId,
          resolvedByRunId: runId,
          resolvedByUserId: userId,
          resolvedAt: now,
          updatedAt: now,
          result:
            input.decision === "approved"
              ? {
                  version: 1,
                  outcome: "accepted",
                  ...(relay ? { chiefRelay: relay } : {}),
                  toolAction: {
                    version: 1,
                    status: "approved",
                    rememberedAction: input.rememberAction === true,
                    updatedAt: now.toISOString(),
                  },
                }
              : { version: 1, outcome: "rejected", reason: input.reason, ...(relay ? { chiefRelay: relay } : {}) },
        })
        .where(eq(issueThreadInteractions.id, interaction.id));
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.toolAction);
      await tx
        .insert(toolActionDeliveries)
        .values({
          companyId: input.companyId,
          actionRequestId: current.id,
          issueId: issue.id,
          interactionId: interaction.id,
        })
        .onConflictDoNothing();
      await logActivity(
        tx as unknown as Db,
        {
          companyId: input.companyId,
          actorType: relay ? "agent" : "user",
          actorId: agentId ?? userId!,
          agentId,
          runId,
          action:
            input.decision === "approved"
              ? "issue.thread_interaction_accepted"
              : "issue.thread_interaction_rejected",
          entityType: "issue",
          entityId: issue.id,
          details: {
            interactionId: interaction.id,
            actionRequestId: current.id,
            rememberAction: input.rememberAction === true,
          },
        },
        publications,
      );
    }
    return updated;
  });
  // A rejection writes the invocation's terminal `denied` status inside the
  // transaction above; emit only after that commit. Approvals stay in-flight
  // and reach their terminal status in the gateway execution paths.
  if (input.decision === "rejected")
    void emitConnectionInvoked(db, source.invocationId);
  for (const publication of publications) publishActivity(publication);
  return result;
}
