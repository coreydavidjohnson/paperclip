import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { createHash } from "node:crypto";
import type { RequestHandler, Request } from "express";
import { and, eq } from "drizzle-orm";
import { agents, approvals, decisions, issueApprovals, issueThreadInteractions, issues, heartbeatRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { sameChiefRelay, type ChiefRelay } from "../services/chief-relay-types.js";

// This is an explicit delegated-authority path. It authenticates the submitting
// agent, not the author of the quoted chat. No human session or actor is minted.
export const chiefRelayInputSchema = z.object({
  sourceKind: z.enum(["decision", "approval", "issue_thread_interaction"]),
  sourceId: z.string().uuid(),
  issueId: z.string().uuid().optional(),
  action: z.enum(["choose", "dismiss", "approve", "reject", "accept", "respond", "verdicts", "skip"]),
  input: z.record(z.string(), z.unknown()).default({}),
  sourceSessionId: z.string().trim().min(1).max(160),
  sourceMessageId: z.string().trim().min(1).max(160),
  exactQuote: z.string().min(1).max(20000).refine(value => value.trim().length > 0),
  scope: z.string().trim().min(1).max(4000),
  idempotencyKey: z.string().trim().min(1).max(160),
}).strict();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function chiefRelayFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function authenticateChiefRelay(actor: Request["actor"], input: z.infer<typeof chiefRelayInputSchema>,
  env: NodeJS.ProcessEnv = process.env): ChiefRelay {
  const agentId = env.PAPERCLIP_CHIEF_RELAY_AGENT_ID?.trim();
  const companyId = env.PAPERCLIP_CHIEF_RELAY_COMPANY_ID?.trim();
  const representedUserId = env.PAPERCLIP_CHIEF_RELAY_USER_ID?.trim();
  const sourceSessionId = env.PAPERCLIP_CHIEF_RELAY_SOURCE_SESSION_ID?.trim();
  if (!agentId || !companyId || !representedUserId || !sourceSessionId
    || actor.type !== "agent" || actor.agentId !== agentId || actor.companyId !== companyId
    || input.sourceSessionId !== sourceSessionId) throw forbidden("Chief relay is not authorized for this actor or source chat");
  return { agentId, companyId, representedUserId, sourceSessionId: input.sourceSessionId,
    sourceMessageId: input.sourceMessageId, exactQuote: input.exactQuote, scope: input.scope,
    idempotencyKey: input.idempotencyKey, requestFingerprint: chiefRelayFingerprint(input) };
}

export function chiefRelayCardSnapshot(record: Record<string, unknown>) {
  const payload = (record.payload && typeof record.payload === "object" ? record.payload : {}) as Record<string, unknown>;
  // Never copy signed arguments, credential proposals, raw connection payloads
  // or signing material into an activity/comment. Native rows remain the source.
  return { id: record.id, kind: record.kind, type: record.type, title: record.title,
    body: record.body, prompt: payload.prompt, questions: payload.questions,
    options: record.options ?? payload.options, items: payload.items, target: payload.target };
}

export function chiefRelayNativePath(input: z.infer<typeof chiefRelayInputSchema>) {
  if (input.sourceKind === "decision" && ["choose", "dismiss"].includes(input.action))
    return `/decisions/${input.sourceId}/${input.action === "choose" ? "decide" : "dismiss"}`;
  if (input.sourceKind === "approval" && ["approve", "reject"].includes(input.action))
    return `/approvals/${input.sourceId}/${input.action}`;
  if (input.sourceKind === "issue_thread_interaction" && input.issueId
    && ["accept", "reject", "respond", "verdicts", "skip"].includes(input.action))
    return `/issues/${input.issueId}/interactions/${input.sourceId}/${input.action}`;
  throw unprocessable("This action is not valid for this card type");
}

/** Reuse the native validators, CAS, lifecycle effects and wake/outbox paths.
 * Only this authenticated entry point can set server-owned Request.chiefRelay.
 * Ordinary endpoints cannot opt into delegation through a body field/header.
 */
export function chiefRelayMiddleware(db: Db): RequestHandler {
  return async (req, res, next) => {
    if (req.method !== "POST" || req.path !== "/chief-relay/answers") return next();
    try {
      const parsed = chiefRelayInputSchema.safeParse(req.body);
      if (!parsed.success) throw unprocessable("Invalid Chief relay request", { issues: parsed.error.issues });
      const input = parsed.data;
      const relay = authenticateChiefRelay(req.actor, input);
      assertCompanyAccess(req, relay.companyId);
      const agent = await db.select({ status: agents.status }).from(agents)
        .where(and(eq(agents.id, relay.agentId), eq(agents.companyId, relay.companyId))).then(rows => rows[0]);
      if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status))
        throw forbidden("Chief relay requires an active authorized agent");
      if (req.actor.runId) {
        const run = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, req.actor.runId),
          eq(heartbeatRuns.agentId, relay.agentId), eq(heartbeatRuns.companyId, relay.companyId))).then(rows => rows[0]);
        if (!run || run.status !== "running" || agentRunWritesRevoked(run))
          throw forbidden("Chief relay run is not active or was cancelled");
      }
      const path = chiefRelayNativePath(input);
      let record: Record<string, unknown> | undefined;
      let issueId = input.issueId;
      if (input.sourceKind === "issue_thread_interaction") {
        record = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, input.sourceId),
          eq(issueThreadInteractions.companyId, relay.companyId), eq(issueThreadInteractions.issueId, input.issueId!))).then(rows => rows[0]);
      } else if (input.sourceKind === "decision") {
        record = await db.select().from(decisions).where(and(eq(decisions.id, input.sourceId),
          eq(decisions.companyId, relay.companyId))).then(rows => rows[0]);
        if (issueId && record?.originIssueId !== issueId) throw notFound("Card not found on this issue");
        issueId = record?.originIssueId as string | undefined;
      } else {
        record = await db.select().from(approvals).where(and(eq(approvals.id, input.sourceId),
          eq(approvals.companyId, relay.companyId))).then(rows => rows[0]);
        const links = await db.select({ issueId: issueApprovals.issueId }).from(issueApprovals)
          .where(and(eq(issueApprovals.approvalId, input.sourceId), eq(issueApprovals.companyId, relay.companyId)));
        if (issueId && !links.some(link => link.issueId === issueId)) throw notFound("Card not found on this issue");
        issueId ??= links[0]?.issueId;
      }
      if (!record) throw notFound("Card not found");
      if (issueId) {
        const issue = await db.select().from(issues).where(and(eq(issues.id, issueId),
          eq(issues.companyId, relay.companyId))).then(rows => rows[0]);
        if (!issue) throw notFound("Linked issue not found");
        for (const action of ["issue:read", "issue:comment", "issue:mutate"] as const) {
          const decision = await accessService(db).decide({ actor: req.actor, action,
            resource: { type: "issue", companyId: issue.companyId, issueId: issue.id,
              projectId: issue.projectId, parentIssueId: issue.parentId,
              assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status },
            scope: { issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
              assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId } });
          if (!decision.allowed) throw forbidden("Chief relay is outside the agent's authorized issue scope");
        }
      }
      // Exact proof is stored with the native winner. A completed interaction
      // can be replayed only by the same relay, never by matching prose alone.
      const result = record.result as { chiefRelay?: ChiefRelay;
        items?: Array<{ chiefRelay?: ChiefRelay; resolvedByAgentId?: string | null }> } | null;
      const receipts = [
        { proof: result?.chiefRelay, actualAgentId: record.resolvedByAgentId },
        ...(result?.items ?? []).map(item => ({ proof: item.chiefRelay, actualAgentId: item.resolvedByAgentId })),
      ];
      const priors = receipts.filter(receipt => receipt.proof?.idempotencyKey === relay.idempotencyKey);
      if (priors.length > 0) {
        if (priors.some(receipt => !sameChiefRelay(receipt.proof, relay)))
          throw conflict("Relay key already used for a different answer");
        // Partial verdicts retain each individual winner after later replies.
        // Compare the whole server proof, including represented user, and its
        // actual persisted resolver before treating any retry as committed.
        if (priors.some(receipt => receipt.actualAgentId === relay.agentId)) {
          const resolved = await issueThreadInteractionService(db).getById(input.sourceId);
          if (!resolved) throw notFound("Card not found");
          res.json(resolved); return;
        }
      }
      if (input.sourceKind === "issue_thread_interaction" && record.status !== "pending")
        throw conflict("This card already has a different outcome");
      const cardSnapshot = chiefRelayCardSnapshot(record);
      await logActivity(db, { companyId: relay.companyId, actorType: "agent", actorId: relay.agentId,
        agentId: relay.agentId, runId: req.actor.runId, agentApiKeyId: req.actor.keyId,
        action: "chief_relay.submitted", entityType: input.sourceKind, entityId: input.sourceId,
        issueId, details: { chiefRelay: relay, action: input.action, choice: input.input,
          card: cardSnapshot, authority: "Corey instruction attested verbatim by Chief of Staff; not a verified human turn" } });
      if (issueId) await issueService(db).addComment(issueId,
        `Chief of Staff relays Corey's instruction for ${input.sourceKind}:${input.sourceId}.

` +
        `Card question and choices: ${JSON.stringify(cardSnapshot)}

` +
        `Exact words: ${relay.exactQuote}

Scope: ${relay.scope}

` +
        `Source chat: ${relay.sourceSessionId}; message: ${relay.sourceMessageId}.

` +
        `Requested answer: ${input.action} ${JSON.stringify(input.input)}. Submitted by Chief of Staff as an agent, not as Corey. ` +
        `This records the relay request; the native card outcome records whether it succeeded.`,
        { agentId: relay.agentId, runId: req.actor.runId });
      req.chiefRelay = relay;
      req.body = input.input;
      // Original URL remains in request telemetry. Native route middleware still
      // validates the exact action and owns all permissions/effects downstream.
      req.url = path;
      next();
    } catch (error) { next(error); }
  };
}
