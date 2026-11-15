import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, authUsers, companyMemberships, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { assertSimpleTestCard, digest, parseAnswer, present, requireEnrollment, verify,
  ApprovalProofError, designationQuestion, requireHuman, type ChatApprovalConfig, type Enrollment, type HumanSession } from "./chat-approval-proof.js";

type Issue = typeof issues.$inferSelect;
type Card = typeof issueThreadInteractions.$inferSelect;
export function approvalSnapshot(issue: Issue, card: Card) {
  return {
    card: { id: card.id, companyId: card.companyId, issueId: card.issueId, kind: card.kind, payload: card.payload,
      requestedResolverPolicy: card.requestedResolverPolicy, effectiveResolverPolicy: card.effectiveResolverPolicy,
      resolverPolicyProvenance: card.resolverPolicyProvenance, createdByAgentId: card.createdByAgentId,
      createdByUserId: card.createdByUserId, sourceRunId: card.sourceRunId,
      addresseeAgentId: card.addresseeAgentId, addresseeUserId: card.addresseeUserId, updatedAt: card.updatedAt },
    target: { id: issue.id, title: issue.title, description: issue.description, status: issue.status,
      updatedAt: issue.updatedAt, assigneeAgentId: issue.assigneeAgentId,
      conversationSessionGeneration: issue.conversationSessionGeneration, conversationBoundaryCommentId: issue.conversationBoundaryCommentId },
  };
}
async function locked(db: Db, e: Enrollment) {
  // Same order as native mutation/Stop/reset. Also serializes revocation and replay.
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, e.issueId), eq(issues.companyId, e.companyId))).for("update");
  if (!issue) throw notFound("Issue not found");
  const [card] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, e.interactionId),
    eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.companyId, e.companyId))).for("update");
  if (!card) throw notFound("Interaction not found");
  return { issue, card };
}
// The operator pins this snapshot only after checking the platform-verified
// humanResponses record. A database user label alone is not that evidence.
export function designationSnapshot(card: Card) {
  return { id: card.id, companyId: card.companyId, issueId: card.issueId, kind: card.kind,
    status: card.status, payload: card.payload, result: card.result,
    requestedResolverPolicy: card.requestedResolverPolicy, effectiveResolverPolicy: card.effectiveResolverPolicy,
    addresseeUserId: card.addresseeUserId, resolvedByUserId: card.resolvedByUserId,
    resolvedByAgentId: card.resolvedByAgentId, resolvedByRunId: card.resolvedByRunId,
    resolvedAt: card.resolvedAt, updatedAt: card.updatedAt };
}
async function assertDesignation(db: Db, e: Enrollment) {
  // Same issue-first lock as native answer, cancellation and revocation paths.
  const [card] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, e.designationId), eq(issueThreadInteractions.issueId, e.issueId),
    eq(issueThreadInteractions.companyId, e.companyId))).for("update");
  const expiry = Date.parse(e.expiresAt);
  const result = card?.result as { version?: number; answers?: Array<{ questionId?: string; optionIds?: string[]; otherText?: string }> } | null;
  const answer = result?.answers?.[0];
  const payload = card?.payload as { questions?: Array<Record<string, unknown>> } | null;
  const question = payload?.questions?.[0], expected = designationQuestion(e);
  if (!card || card.id === e.interactionId || card.kind !== "ask_user_questions" || card.status !== "answered"
    || card.requestedResolverPolicy !== "human_only" || card.effectiveResolverPolicy !== "human_only"
    || card.addresseeUserId !== e.userId || card.resolvedByUserId !== e.userId
    || card.resolvedByAgentId || card.resolvedByRunId || !card.resolvedAt
    || digest(designationSnapshot(card)) !== e.designationHash
    || payload?.questions?.length !== 1 || !question || question.id !== expected.id
    || question.prompt !== expected.prompt || question.helpText !== expected.helpText
    || question.selectionMode !== "single" || question.required !== true || question.allowOther !== false
    || digest(question.options) !== digest(expected.options)
    || result?.version !== 1 || result.answers?.length !== 1 || answer?.questionId !== "designate-test-account"
    || answer.optionIds?.length !== 1 || answer.optionIds[0] !== "bind-this-account" || answer.otherText !== e.loginAccountId
    || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > card.resolvedAt.getTime() + 86_400_000) {
    throw forbidden("A current human designation for this exact test account is required");
  }
}
async function nativeApprovalIdentity(db: Db, e: Enrollment, actor?: HumanSession) {
  // Lock existing native rights through the answer commit. A completed revocation
  // must win over an earlier route-local alias. No instance-admin bypass here.
  const [user] = await db.select().from(authUsers).where(eq(authUsers.id, e.userId)).for("update");
  const [membership] = await db.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships).where(and(eq(companyMemberships.companyId, e.companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, e.userId),
      eq(companyMemberships.status, "active"))).for("update");
  if (!user || !membership) throw forbidden("The designated human has no current company access");
  if (actor && !actor.memberships?.some(row => row.companyId === e.companyId
    && row.status === "active" && row.membershipRole === membership.membershipRole)) {
    throw forbidden("The designated human's company rights changed. Open a new prompt");
  }
  return { user, membership };
}
export async function designatedChatApprovalActor(db: Db, e: Enrollment, actor: Request["actor"]): Promise<Request["actor"]> {
  try { requireHuman(actor); } catch { throw forbidden("A separate human login session is required"); }
  if (actor.userId !== e.loginAccountId || actor.chatApprovalAccountId) throw forbidden("This login account is not designated for this card");
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const { card } = await locked(tx, e);
    assertSimpleTestCard(e, card);
    await assertDesignation(tx, e);
    await assertNotRevoked(tx, e);
    const { user, membership } = await nativeApprovalIdentity(tx, e);
    // Route-local only. Use existing native rights; never manufacture memberships,
    // roles, an implicit-local bypass, or a replacement BetterAuth identity.
    return { ...actor, userId: e.userId, chatApprovalAccountId: actor.userId,
      userName: user.name, userEmail: user.email, companyIds: [membership.companyId],
      memberships: [membership], isInstanceAdmin: false };
  }).catch(error => {
    if (error instanceof ApprovalProofError) throw forbidden(error.message);
    throw error;
  });
}

async function assertNotRevoked(db: Db, e: Enrollment) {
  const [revoked] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, e.companyId), eq(activityLog.entityId, e.issueId), eq(activityLog.action, "issue.chat_approval_revoked"),
    sql`${activityLog.details}->>'interactionId' = ${e.interactionId}`,
  )).limit(1);
  if (revoked) throw forbidden("Chat approval was revoked. Use the original card");
}
export async function chatApprovalReceipt(db: Db, e: Enrollment) {
  const [event] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, e.companyId),
    eq(activityLog.entityId, e.issueId), eq(activityLog.action, "issue.chat_approval_answered"),
    sql`${activityLog.details}->>'interactionId' = ${e.interactionId}`,
  )).limit(1);
  return event?.details ?? null;
}
export async function presentChatApproval(db: Db, config: ChatApprovalConfig, e: Enrollment, actor: HumanSession) {
  requireEnrollment(config, e.issueId, e.interactionId, actor);
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const { issue, card } = await locked(tx, e);
    assertSimpleTestCard(e, card);
    await assertDesignation(tx, e);
    await nativeApprovalIdentity(tx, e, actor);
    await assertNotRevoked(tx, e);
    if (card.status !== "pending") throw conflict("This card already has an answer");
    if (["done", "cancelled"].includes(issue.status)) throw conflict("This issue is closed");
    return { card, ...present(config, e, actor, approvalSnapshot(issue, card)) };
  });
}
export async function resolveChatApproval(db: Db, args: {
  config: ChatApprovalConfig; enrollment: Enrollment; actor: HumanSession;
  proof: unknown; origin: unknown; choice: unknown; answer: unknown;
  resolverPolicyRestriction?: Parameters<ReturnType<typeof issueThreadInteractionService>["acceptInteraction"]>[3]["resolverPolicyRestriction"];
}) {
  const e = requireEnrollment(args.config, args.enrollment.issueId, args.enrollment.interactionId, args.actor);
  if (digest(e) !== digest(args.enrollment)) throw forbidden("Enrollment changed");
  const proof = verify(args.config, e, args.actor, args.proof, args.origin);
  const answer = parseAnswer(args.choice, args.answer);
  let publication: ActivityPublication | null = null;
  const effects: Array<(committedDb: Db) => Promise<void>> = [];
  const result = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const { issue, card } = await locked(tx, e);
    assertSimpleTestCard(e, card);
    await assertDesignation(tx, e);
    await nativeApprovalIdentity(tx, e, args.actor);
    await assertNotRevoked(tx, e);
    if (card.status !== "pending") {
      const receipt = await chatApprovalReceipt(tx, e);
      if (receipt?.responseId !== proof.responseId || receipt?.decision !== answer.decision || receipt?.exactAnswer !== answer.exactAnswer
        || card.resolvedByUserId !== args.actor.userId) throw conflict("This card already has a different answer");
      return { interaction: await issueThreadInteractionService(tx).getForIssue(issue, card.id), receipt, deduplicated: true };
    }
    const snapshot = approvalSnapshot(issue, card);
    if (proof.snapshotHash !== digest(snapshot)) throw conflict("The question or target changed. Open a new prompt");
    const svc = issueThreadInteractionService(tx);
    if (answer.decision === "revoke") {
      publication = (await persistActivity(tx, { companyId: e.companyId, actorType: "user", actorId: args.actor.userId!,
        action: "issue.chat_approval_revoked", entityType: "issue", entityId: e.issueId,
        details: { interactionId: e.interactionId, enrollmentHash: digest(e), source: "chat_approval_prompt", responseId: proof.responseId,
          humanUserId: args.actor.userId, loginAccountId: args.actor.chatApprovalAccountId, designationId: e.designationId, designationHash: e.designationHash },
      })).publication;
      return { interaction: await svc.getForIssue(issue, card.id), receipt: null, deduplicated: false };
    }
    // Native services recheck company review, audience, target, lifecycle and workspace gates.
    const actor = { userId: args.actor.userId, resolverPolicyRestriction: args.resolverPolicyRestriction };
    const mutationOptions = { deferConfirmationCommitEffects: (effect: (committedDb: Db) => Promise<void>) => { effects.push(effect); } };
    const interaction = answer.decision === "accept"
      ? (await svc.acceptInteraction(issue, card.id, {}, actor, mutationOptions)).interaction
      : await svc.rejectInteraction(issue, card.id, { reason: "Deny" }, actor, mutationOptions);
    if (interaction.status !== (answer.decision === "accept" ? "accepted" : "rejected")) throw conflict("Native resolution did not record this answer");
    const receipt = { version: 1, source: "chat_approval_prompt", responseId: proof.responseId,
      interactionId: card.id, companyId: e.companyId, issueId: e.issueId, chatId: e.chatId,
      humanUserId: args.actor.userId, loginAccountId: args.actor.chatApprovalAccountId,
      designationId: e.designationId, designationHash: e.designationHash, enrollmentExpiresAt: e.expiresAt, submittingAgentId: e.submittingAgentId, policyRevision: e.revision,
      enrollmentHash: digest(e), snapshotHash: proof.snapshotHash, snapshot,
      question: (card.payload as { prompt: string }).prompt, decision: answer.decision,
      selectedOptionLabel: answer.decision === "accept" ? "Approve" : "Deny", exactAnswer: answer.exactAnswer,
      presentedAt: new Date(proof.issuedAt).toISOString(), answeredAt: new Date().toISOString(),
    };
    publication = (await persistActivity(tx, { companyId: e.companyId, actorType: "user", actorId: args.actor.userId!,
      action: "issue.chat_approval_answered", entityType: "issue", entityId: e.issueId, details: receipt,
    })).publication;
    // Never claim exact evidence if the normal log sanitizer changed it. Roll back both writes.
    if (digest(publication.payload.details) !== digest(receipt)) throw conflict("The exact approval evidence cannot be retained safely");
    return { interaction, receipt, deduplicated: false };
  });
  if (publication) publishActivity(publication);
  for (const effect of effects) await effect(db);
  return result;
}
