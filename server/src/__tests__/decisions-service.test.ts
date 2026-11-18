import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  decisionEffectExecutions,
  decisionRetention,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import type { ChiefRelay } from "../services/chief-relay-types.js";
import { decisionService } from "../services/decisions.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import type { AttentionArchiveManifestEntry, AttentionArchiveTargetSnapshot } from "@paperclipai/shared";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("decisionService", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let originIssueId: string;
  let targetIssueId: string;
  let runId: string;
  let originResponsibleUserId: string;
  let decidedByUserId: string;
  let wakes: Array<Record<string, unknown>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decisions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID(); agentId = randomUUID(); originIssueId = randomUUID(); targetIssueId = randomUUID(); runId = randomUUID();
    originResponsibleUserId = `origin-${randomUUID()}`; decidedByUserId = `decider-${randomUUID()}`; wakes = [];
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Decisions", issuePrefix: `D${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values([
      { id: originResponsibleUserId, name: "Origin", email: `${originResponsibleUserId}@example.test`, createdAt: now, updatedAt: now },
      { id: decidedByUserId, name: "Decider", email: `${decidedByUserId}@example.test`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: originResponsibleUserId, status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: decidedByUserId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: originIssueId, companyId, title: "Origin", status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: originResponsibleUserId },
      { id: targetIssueId, companyId, title: "Target", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: originResponsibleUserId, contextSnapshot: { issueId: originIssueId } });
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
    delete process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions); await db.delete(decisionRetention); await db.delete(activityLog);
    await db.delete(issueComments); await db.delete(issueRelations); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  const agentActor = () => ({ type: "agent" as const, companyId, agentId, runId, source: "agent_jwt" as const,
    onBehalfOfUserId: originResponsibleUserId, onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const boardActor = () => ({ type: "board" as const, userId: decidedByUserId, companyIds: [companyId], source: "session" as const,
    memberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const service = () => decisionService(db, { wakeOriginAgent: async (input) => { wakes.push(input); } });
  const createCommentDecision = (staleness: "strict" | "lenient" = "lenient", extra: Record<string, unknown> = {}) => service().create({
    companyId, actor: agentActor(), agentId, runId, title: "Comment?", body: "Body", continuationPolicy: "wake_origin_agent",
    options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness, bodyMarkdown: "hello" }] }],
    ...extra,
  });
  // Make an existing decision TTL-expired for the next sweep. Creating a
  // decision that is already expired is impossible (create rejects a past
  // expiresAt), and creating one that expires a few milliseconds later races
  // the service's own clock read — under CI load the create itself can fail
  // with "expiresAt must be within 30 days". Create with a comfortable future
  // expiry instead, then move expiresAt into the past directly in the store.
  const nearFutureExpiry = () => new Date(Date.now() + 60_000);
  const expireDecisionNow = (id: string) =>
    db.update(decisions).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, id));

  it("returns the existing decision for concurrent idempotent creates", async () => {
    const input = {
      companyId, actor: agentActor(), agentId, runId, title: "Same?", body: "Body", idempotencyKey: "concurrent-create",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue" as const, targetIssueId, staleness: "lenient" as const, bodyMarkdown: "hello" }] }],
    };
    const [first, second] = await Promise.all([service().create(input), service().create(input)]);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(decisions).where(eq(decisions.idempotencyKey, "concurrent-create"))).toHaveLength(1);
  });

  it("executes once, replays stored outcome, and attributes executor audit to the decider", async () => {
    const created = await createCommentDecision();
    const first = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "decide-1", decidedByUserId, userActor: boardActor() });
    const replay = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "decide-1", decidedByUserId, userActor: boardActor() });
    expect(first.executionStatus).toBe("succeeded"); expect(replay.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_executed"));
    expect(audit[0]?.responsibleUserId).toBe(decidedByUserId);
    expect(audit[0]?.details).toMatchObject({ decidedByUserId, originResponsibleUserId });
    expect(first.executions[0]?.activityLogId).toBe(audit[0]?.id);
    expect(wakes).toHaveLength(1);
  });

  async function relayContext(): Promise<{ chiefRelay: ChiefRelay; actor: ReturnType<typeof agentActor> }> {
    const chiefId = randomUUID();
    const chiefRunId = randomUUID();
    await db.insert(agents).values({ id: chiefId, companyId, name: "Chief", role: "ceo", status: "active" });
    await db.insert(heartbeatRuns).values({ id: chiefRunId, companyId, agentId: chiefId, status: "running", responsibleUserId: originResponsibleUserId, contextSnapshot: { issueId: originIssueId } });
    return {
      chiefRelay: { agentId: chiefId, companyId, representedUserId: "local-board", sourceSessionId: "source-session", sourceMessageId: "source-message",
        exactQuote: "Choose yes on this card.", scope: "This exact decision", idempotencyKey: "relay-1", requestFingerprint: "fingerprint-1" },
      actor: { ...agentActor(), agentId: chiefId, runId: chiefRunId },
    };
  }

  it("executes relayed choices once with actual agent comments, audit and continuation attribution", async () => {
    const created = await createCommentDecision();
    const { chiefRelay, actor } = await relayContext();
    const input = { id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay };
    const first = await service().decide(input);
    expect(first).toMatchObject({ status: "decided", executionStatus: "succeeded", decidedByUserId: null, metadata: { chiefRelay } });
    await service().decide(input);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorAgentId: chiefRelay.agentId, authorUserId: null });
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_executed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: chiefRelay.agentId, agentId: chiefRelay.agentId,
      runId: actor.runId, responsibleUserId: null, details: { decidedByUserId: null, chiefRelay } });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ requestedByActorType: "agent", requestedByActorId: chiefRelay.agentId });
  });

  it("preserves native status effects and attributes their comments to Chief", async () => {
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, targetIssueId));
    const created = await service().create({ companyId, actor: agentActor(), agentId, runId, title: "Start?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress", comment: "Start work" }] }] });
    const { chiefRelay, actor } = await relayContext();
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay });
    expect(result.executionStatus, JSON.stringify(result.executions)).toBe("succeeded");
    expect((await db.select().from(issues).where(eq(issues.id, targetIssueId)))[0]).toMatchObject({ status: "in_progress", startedAt: expect.any(Date) });
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId)))[0]).toMatchObject({ authorAgentId: chiefRelay.agentId, authorUserId: null, body: "Start work" });
  });

  it("creates a native child issue with the relay agent as creator, not the represented user", async () => {
    const created = await service().create({ companyId, actor: agentActor(), agentId, runId, title: "Create?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "create_issue", targetIssueId, staleness: "lenient", draft: { title: "Chief relayed child" } }] }] });
    const { chiefRelay, actor } = await relayContext();
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay });
    expect(result.executionStatus).toBe("succeeded");
    const children = await db.select().from(issues).where(eq(issues.parentId, targetIssueId));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ createdByAgentId: chiefRelay.agentId, createdByUserId: null });
  });

  it("rejects altered relay proof, choice, or values on replay without new effects", async () => {
    const created = await createCommentDecision();
    const { chiefRelay, actor } = await relayContext();
    const input = { id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay };
    await service().decide(input);
    for (const key of ["sourceSessionId", "sourceMessageId", "exactQuote", "scope", "idempotencyKey", "requestFingerprint", "representedUserId"] as const) {
      await expect(service().decide({ ...input, chiefRelay: { ...chiefRelay, [key]: "changed" } })).rejects.toThrow("chief_relay_replay_mismatch");
    }
    await expect(service().decide({ ...input, optionId: "other" })).rejects.toThrow("chief_relay_replay_mismatch");
    await expect(service().decide({ ...input, inputValues: { answer: "changed" } })).rejects.toThrow("chief_relay_replay_mismatch");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("keeps one CAS winner when relayed choices race", async () => {
    const created = await createCommentDecision("lenient", { options: [
      { id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "hello" }] },
      { id: "no", label: "No", effects: [] },
    ] });
    const { chiefRelay, actor } = await relayContext();
    const input = { id: created.id, decidedByUserId: null, userActor: actor, chiefRelay };
    const results = await Promise.allSettled([service().decide({ ...input, optionId: "yes" }), service().decide({ ...input, optionId: "no" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.decided"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: chiefRelay.agentId });
  });

  it.each([true, false])("dismisses and replays with honest relay attribution (empty option %s)", async (emptyOption) => {
    const created = await createCommentDecision("lenient", emptyOption ? { options: [{ id: "skip", label: "Skip", effects: [] }] } : {});
    const { chiefRelay, actor } = await relayContext();
    const first = await service().dismiss(created.id, null, actor, "Not needed", chiefRelay);
    const replay = await service().dismiss(created.id, null, actor, "Not needed", chiefRelay);
    expect(first.id).toBe(replay.id);
    expect(replay).toMatchObject({ decidedByUserId: null, status: "decided", metadata: { chiefRelay, dismissed: true } });
    await expect(service().dismiss(created.id, null, actor, "Different", chiefRelay)).rejects.toThrow("chief_relay_replay_mismatch");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    expect(wakes).toHaveLength(1);
  });

  it("recovers unfinished relayed effects without requiring a fabricated user ID", async () => {
    const created = await createCommentDecision();
    const { chiefRelay } = await relayContext();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId: null,
      decidedAt: new Date(), updatedAt: new Date(Date.now() - 120_000), metadata: { ...created.metadata, chiefRelay } }).where(eq(decisions.id, created.id));
    expect(await service().sweepExpired()).toMatchObject({ resumed: 1 });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId));
    expect(comments[0]).toMatchObject({ authorAgentId: chiefRelay.agentId, authorUserId: null });
  });

  it("does not let decision creators plant server-owned relay proof", async () => {
    const { chiefRelay } = await relayContext();
    await expect(createCommentDecision("lenient", { metadata: { chiefRelay } })).rejects.toThrow("chiefRelay metadata is server-owned");
  });

  it.each(["choose", "dismiss"] as const)("prevents a cancelled real run from submitting a relay %s", async action => {
    const created = await createCommentDecision();
    const { chiefRelay, actor } = await relayContext();
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, actor.runId));
    const result = action === "choose"
      ? service().decide({ id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay })
      : service().dismiss(created.id, null, actor, "Skip", chiefRelay);
    await expect(result).rejects.toThrow("This run was cancelled");
    expect(await service().get(created.id)).toMatchObject({ status: "open", decidedAt: null });
    expect(wakes).toHaveLength(0);
  });

  it("serializes a relay outcome behind a concurrent Stop transaction", async () => {
    const created = await createCommentDecision();
    const { chiefRelay, actor } = await relayContext();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const stop = db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, actor.runId));
      ready();
      await held;
    });
    await locked;
    let settled = false;
    const result = service().decide({ id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay })
      .then(value => ({ value, error: null }), error => ({ value: null, error })).finally(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(settled).toBe(false);
    } finally { release(); }
    await stop;
    expect((await result).error).toMatchObject({ message: "This run was cancelled" });
    expect(await service().get(created.id)).toMatchObject({ status: "open", decidedAt: null });
  });

  it("rejects a relay submitter from another company before claiming the decision", async () => {
    const created = await createCommentDecision();
    const { chiefRelay, actor } = await relayContext();
    await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId: null,
      userActor: { ...actor, companyId: randomUUID() }, chiefRelay })).rejects.toThrow("Chief relay submitter or company mismatch");
    expect(await service().get(created.id)).toMatchObject({ status: "open", decidedAt: null });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("retains the origin-agent permission intersection for authenticated relay effects", async () => {
    const created = await service().create({ companyId, actor: agentActor(), agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" }] }] });
    const { chiefRelay, actor } = await relayContext();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId: null, userActor: actor, chiefRelay });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("allows one double-decide winner and rejects the loser", async () => {
    // Repeating the same option is a valid replay if the first request already
    // won. Distinct choices exercise contention regardless of query scheduling.
    const created = await createCommentDecision("lenient", { options: [
      { id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "hello" }] },
      { id: "alternative", label: "Alternative", effects: [{ type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "alternative" }] },
    ] });
    const outcomes = await Promise.allSettled([
      service().decide({ id: created.id, optionId: "yes", idempotencyKey: "race-a", decidedByUserId, userActor: boardActor() }),
      service().decide({ id: created.id, optionId: "alternative", idempotencyKey: "race-b", decidedByUserId, userActor: boardActor() }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("binds bulk archive acceptance to the exact signed, versioned manifest", async () => {
    const extraIssueId = randomUUID();
    const unreviewedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: extraIssueId, companyId, title: "Second aging item", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
      { id: unreviewedIssueId, companyId, title: "Not reviewed", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
    ]);
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(decisionRetention).values([targetIssueId, extraIssueId, unreviewedIssueId].map((sourceId) => ({
      companyId,
      sourceKind: "review",
      sourceId,
      sourceActivityAt: activityAt,
    })));
    const manifest: AttentionArchiveManifestEntry[] = [targetIssueId, extraIssueId].map((sourceId) => ({
      companyId,
      sourceKind: "review",
      sourceId,
      expectedVersion: 1,
      activityAt: activityAt.toISOString(),
      reason: `Archive ${sourceId}`,
    }));
    const snapshots = Object.fromEntries(manifest.map((entry) => [
      `attention:${entry.sourceKind}:${entry.sourceId}`,
      {
        status: "attention",
        assigneeAgentId: null,
        assigneeUserId: null,
        updatedAt: entry.activityAt,
        attentionArchive: entry,
      } satisfies AttentionArchiveTargetSnapshot,
    ]));
    const created = await service().create({
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Archive two?",
      body: "Reviewed exact set",
      options: [
        { id: "archive", label: "Archive", style: "destructive", effects: [] },
        { id: "keep", label: "Keep", effects: [] },
      ],
      metadata: { kind: "attention_archive_proposal", manifestHash: hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: snapshots,
    });
    const result = await service().decide({
      id: created.id,
      optionId: "archive",
      decidedByUserId,
      userActor: boardActor(),
    });
    expect(result.executionStatus).toBe("succeeded");
    const states = await db.select().from(decisionRetention);
    expect(states.filter((row) => row.archivedAt).map((row) => row.sourceId).sort()).toEqual([extraIssueId, targetIssueId].sort());
    expect(states.find((row) => row.sourceId === unreviewedIssueId)?.archivedAt).toBeNull();
  });

  it("skips strict stale targets and fails closed on intersection denial", async () => {
    const stale = await createCommentDecision("strict");
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, targetIssueId));
    const staleResult = await service().decide({ id: stale.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(staleResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });

    const denied = await createCommentDecision("lenient", { idempotencyKey: "denied" });
    const deniedResult = await service().decide({ id: denied.id, optionId: "yes", decidedByUserId, userActor: { type: "none", source: "none" } });
    expect(deniedResult.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
    const failedAudit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_failed"));
    expect(failedAudit.at(-1)?.details).toMatchObject({ reason: "deny_decision_intersection" });
  });

  it("fails closed when the origin actor retains read access but loses mutation access", async () => {
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" }] }],
    });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("removes inbound blockers without replacing them with outgoing relations", async () => {
    const removedBlockerId = randomUUID();
    const retainedBlockerId = randomUUID();
    const downstreamId = randomUUID();
    await db.insert(issues).values([
      { id: removedBlockerId, companyId, title: "Removed blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
      { id: retainedBlockerId, companyId, title: "Retained blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
      { id: downstreamId, companyId, title: "Downstream", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: removedBlockerId, relatedIssueId: targetIssueId, type: "blocks" },
      { companyId, issueId: retainedBlockerId, relatedIssueId: targetIssueId, type: "blocks" },
      { companyId, issueId: targetIssueId, relatedIssueId: downstreamId, type: "blocks" },
    ]);
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Resolve blocker?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "resolve_blocker", targetIssueId, staleness: "lenient",
        removeBlockedByIssueIds: [removedBlockerId] }] }],
    });

    await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    const relations = await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId));
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: retainedBlockerId, relatedIssueId: targetIssueId, type: "blocks" }),
      expect.objectContaining({ issueId: targetIssueId, relatedIssueId: downstreamId, type: "blocks" }),
    ]));
    expect(relations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: removedBlockerId, relatedIssueId: targetIssueId, type: "blocks" }),
    ]));
  });

  it("rejects mutation proposals from an origin actor with read-only access", async () => {
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const readOnlyActor = { ...agentActor(),
      onBehalfOfMemberships: [{ companyId, membershipRole: "viewer" as const, status: "active" as const }] };

    await expect(service().create({
      companyId, actor: readOnlyActor, agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{
        type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress",
      }] }],
    })).rejects.toThrow("Decision effect exceeds the origin authority boundary");
  });

  it("expires a decision atomically instead of executing after its deadline", async () => {
    const created = await createCommentDecision("lenient");
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(decisions.id, created.id));
    await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("decision_expired");
    expect((await service().get(created.id))?.status).toBe("expired");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("rejects strict effects when secondary targets or cancellation scope change", async () => {
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId });
    const createDecision = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Create?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "create_issue", targetIssueId, staleness: "strict", draft: { title: "Follow-up", blockedByIssueIds: [blockerId] } }] }],
    });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, blockerId));
    const createResult = await service().decide({ id: createDecision.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(createResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });

    const cancelDecision = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "cancel_issue_tree", targetIssueId, staleness: "strict", reasonComment: "cleanup" }] }],
    });
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId, title: "New child", status: "todo", priority: "medium", parentId: targetIssueId, responsibleUserId: decidedByUserId });
    const cancelResult = await service().decide({ id: cancelDecision.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(cancelResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });
    expect((await db.select().from(issues).where(eq(issues.id, childId)))[0]?.status).toBe("todo");
  });

  it("never expands a lenient cancellation beyond the signed descendant scope", async () => {
    const reviewedChildId = randomUUID();
    await db.insert(issues).values({ id: reviewedChildId, companyId, title: "Reviewed child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{
        type: "cancel_issue_tree", targetIssueId, staleness: "lenient", reasonComment: "cleanup",
      }] }],
    });
    const unreviewedChildId = randomUUID();
    await db.insert(issues).values({ id: unreviewedChildId, companyId, title: "Unreviewed child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });

    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    expect(result.executions[0]).toMatchObject({ status: "executed",
      result: { cancelledIssueIds: [reviewedChildId, targetIssueId] } });
    expect((await db.select().from(issues).where(eq(issues.id, unreviewedChildId)))[0]?.status).toBe("todo");
  });

  it("bounds cyclic issue traversal for snapshots and cancel-tree execution", async () => {
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId, title: "Cycle child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });
    await db.update(issues).set({ parentId: childId }).where(eq(issues.id, targetIssueId));
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel cycle?", body: "Body",
      options: [{ id: "cancel", label: "Cancel", style: "destructive", effects: [{
        type: "cancel_issue_tree", targetIssueId, staleness: "strict", reasonComment: "cleanup",
      }] }],
    });

    expect((created.targetSnapshots as Record<string, { descendantCount: number }>)[targetIssueId]?.descendantCount).toBe(1);
    const result = await service().decide({ id: created.id, optionId: "cancel", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "executed", result: { cancelledIssueIds: [childId, targetIssueId] } });
    expect(await db.select({ id: issues.id, status: issues.status }).from(issues).where(eq(issues.companyId, companyId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: targetIssueId, status: "cancelled" }),
        expect.objectContaining({ id: childId, status: "cancelled" }),
      ]));
  });

  it("fails closed when the deciding user lacks assignment capability", async () => {
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Assign?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "assign_issue", targetIssueId, staleness: "lenient", assigneeAgentId }] }],
    });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, decidedByUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("fails closed when the origin responsible user loses visibility", async () => {
    const created = await createCommentDecision();
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
    expect(result.executions[0]?.result).toMatchObject({ originReason: "deny_missing_membership" });
  });

  it("fails closed when the configured signing secret is removed after proposal", async () => {
    const created = await createCommentDecision();
    const originalHome = process.env.PAPERCLIP_HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-rotate-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-jwt-secret-must-not-sign-decisions";
    try {
      await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
        .rejects.toThrow("Decision signature verification failed");
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("signs and verifies with an auto-generated key when no secret is configured", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-generated-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const created = await createCommentDecision();
      const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
      expect(result.executionStatus).toBe("succeeded");
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("records a failed effect and continues independent later effects", async () => {
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Continue?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [
        { type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" },
        { type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "still runs" },
      ] }],
    });
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executionStatus).toBe("partial");
    expect(result.executions).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectIndex: 0, status: "failed", error: "effect_execution_failed" }),
      expect.objectContaining({ effectIndex: 1, status: "executed" }),
    ]));
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("resumes claimed effects exactly once after a simulated crash without a client idempotency key", async () => {
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {} }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue", targetIssueId, status: "claimed" });
    const resumed = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(resumed.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("recovers stale running decisions from the bounded server sweep", async () => {
    process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS = "0";
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {}, updatedAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue",
      targetIssueId, status: "claimed" });

    expect(await service().sweepExpired()).toEqual({ expired: 0, resumed: 1 });
    expect((await service().get(created.id))?.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });

  it("retries a terminal continuation after a crash between effects and wake delivery", async () => {
    const created = await createCommentDecision();
    const crashingService = decisionService(db, { wakeOriginAgent: async () => {
      throw new Error("simulated post-execution crash");
    } });

    await expect(crashingService.decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("simulated post-execution crash");
    expect((await service().get(created.id))?.executionStatus).toBe("succeeded");
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: true });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);

    await service().sweepExpired();

    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: false });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("delivers the continuation when the origin agent cancels a decision", async () => {
    const created = await createCommentDecision();

    const cancelled = await service().cancel(created.id, { actorType: "agent", actorId: agentId, runId });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.metadata).toMatchObject({ continuationPending: false });
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "cancelled" }]);
  });

  it("adds open decisions to the attention feed and badge count", async () => {
    const created = await createCommentDecision();
    const feed = await attentionService(db).list(companyId, { userId: decidedByUserId });
    expect(feed.countsBySourceKind.decision).toBe(1);
    expect(feed.items).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceKind: "decision",
      subject: expect.objectContaining({ id: created.id, kind: "decision" }),
    })]));
  });

  it("batches effect executions into terminal decision lists", async () => {
    const created = await createCommentDecision();
    await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    const listed = await service().list(companyId, { status: "decided" });

    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({
      id: created.id,
      executions: [expect.objectContaining({ effectIndex: 0, status: "executed" })],
    })]));
  });

  it("bounds the open-decision slice of the attention feed", async () => {
    const older = await createCommentDecision("lenient", { idempotencyKey: "attention-older" });
    const newer = await createCommentDecision("lenient", { idempotencyKey: "attention-newer" });
    await db.update(decisions).set({ updatedAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, older.id));

    const feed = await attentionService(db, { openDecisionLimit: 1 }).list(companyId, { userId: decidedByUserId });

    expect(feed.countsBySourceKind.decision).toBe(1);
    expect(feed.items.filter((item) => item.sourceKind === "decision").map((item) => item.subject.id)).toEqual([newer.id]);
  });

  it("loads target staleness in a bounded query for the open-decision list", async () => {
    const first = await createCommentDecision("lenient", { idempotencyKey: "list-query-1" });
    const second = await createCommentDecision("lenient", { idempotencyKey: "list-query-2" });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, targetIssueId));

    const selectSpy = vi.spyOn(db, "select");
    try {
      const listed = await service().list(companyId, { status: "open" });
      expect(selectSpy).toHaveBeenCalledTimes(2);
      expect(listed.filter((decision) => decision.id === first.id || decision.id === second.id))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id, targetChanged: { [targetIssueId]: true } }),
          expect.objectContaining({ id: second.id, targetChanged: { [targetIssueId]: true } }),
        ]));
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("bounds expiration work to the configured batch size", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "1";
    const first = await createCommentDecision("lenient", { idempotencyKey: "batch-1", expiresAt: nearFutureExpiry() });
    const second = await createCommentDecision("lenient", { idempotencyKey: "batch-2", expiresAt: nearFutureExpiry() });
    await expireDecisionNow(first.id);
    await expireDecisionNow(second.id);
    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().sweepExpired()).expired).toBe(1);
  });

  it("falls back to the default sweep batch size for invalid configuration", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "not-a-number";
    const first = await createCommentDecision("lenient", { idempotencyKey: "invalid-batch-1", expiresAt: nearFutureExpiry() });
    const second = await createCommentDecision("lenient", { idempotencyKey: "invalid-batch-2", expiresAt: nearFutureExpiry() });
    await expireDecisionNow(first.id);
    await expireDecisionNow(second.id);

    await expect(service().sweepExpired()).resolves.toMatchObject({ expired: 2 });
  });

  it("expires TTL and target-gone decisions and wakes the origin agent", async () => {
    const ttl = await createCommentDecision("lenient", { expiresAt: nearFutureExpiry() });
    const gone = await createCommentDecision("strict", { idempotencyKey: "gone" });
    await db.update(decisions).set({ expiresAt: new Date(0) }).where(eq(decisions.id, ttl.id));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, targetIssueId));
    await expireDecisionNow(ttl.id);
    expect((await service().sweepExpired()).expired).toBe(2);
    const rows = await db.select().from(decisions);
    expect(rows.find((row) => row.id === ttl.id)?.metadata).toMatchObject({ expiredReason: "ttl" });
    expect(rows.find((row) => row.id === gone.id)?.metadata).toMatchObject({ expiredReason: "target_gone" });
    expect(wakes).toHaveLength(2);
  });

  it("expires strict decisions whose targets completed after they were proposed", async () => {
    const completed = await createCommentDecision("strict", { idempotencyKey: "target-completed" });
    const lenient = await createCommentDecision("lenient", { idempotencyKey: "lenient-survives" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));

    expect((await service().sweepExpired()).expired).toBe(1);

    expect((await service().get(completed.id))?.metadata).toMatchObject({ expiredReason: "target_completed" });
    expect((await service().get(lenient.id))?.status).toBe("open");
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: completed.id, outcome: "expired" }]);
  });

  it("keeps strict decisions that intentionally target an already-done issue", async () => {
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));
    const reopen = await createCommentDecision("strict", { idempotencyKey: "already-done" });

    expect((await service().sweepExpired()).expired).toBe(0);
    expect((await service().get(reopen.id))?.status).toBe("open");
  });

  it("expires when a strict secondary target completes after proposal", async () => {
    const blockerId = randomUUID();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Secondary blocker",
      status: "todo",
      priority: "medium",
      responsibleUserId: decidedByUserId,
    });
    const created = await service().create({
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Create follow-up?",
      body: "Body",
      options: [{
        id: "yes",
        label: "Yes",
        effects: [{
          type: "create_issue",
          targetIssueId,
          staleness: "strict",
          draft: { title: "Follow-up", blockedByIssueIds: [blockerId] },
        }],
      }],
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));

    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().get(created.id))?.metadata).toMatchObject({ expiredReason: "target_completed" });
  });

  it("groups rule-key stats and separates explicit dismissals from expiry", async () => {
    const accepted = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const rejected = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign another?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const acceptedAgain = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign again?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const stale = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "cleanup.stale", title: "Clean up?", body: "Body",
      options: [{ id: "clean", label: "Clean", effects: [] }], expiresAt: nearFutureExpiry(),
    });
    await service().decide({ id: accepted.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().decide({ id: acceptedAgain.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().dismiss(rejected.id, decidedByUserId, boardActor(), "Not this time");
    await expireDecisionNow(stale.id);
    await service().sweepExpired();

    const stats = await service().stats(companyId, { originAgentId: agentId });
    expect(stats.filters).toEqual({ originAgentId: agentId, since: null });
    expect(stats.totals).toEqual({ proposed: 4, accepted: 2, rejected: 1, expired: 1 });
    expect(stats.groups).toEqual([
      { ruleKey: "cleanup.stale", proposed: 1, accepted: 0, rejected: 0, expired: 1, chosenOptions: [] },
      { ruleKey: "routing.assign", proposed: 3, accepted: 2, rejected: 1, expired: 0,
        chosenOptions: [{ optionId: "assign", count: 2 }] },
    ]);
    expect((await service().outcome(rejected.id)).metadata).toMatchObject({ dismissed: true, dismissReason: "Not this time" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed")))
      .toEqual([expect.objectContaining({ entityId: rejected.id, responsibleUserId: decidedByUserId })]);
  });

  it("rejects a direct dismissal when the signed decision spec was tampered with", async () => {
    const created = await createCommentDecision();
    await db.update(decisions).set({ options: [{ id: "tampered", label: "Tampered", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "tampered",
    }] }] }).where(eq(decisions.id, created.id));

    await expect(service().dismiss(created.id, decidedByUserId, boardActor(), "No"))
      .rejects.toThrow("Decision signature verification failed");
    expect((await service().get(created.id))?.status).toBe("open");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed"))).toHaveLength(0);
  });

  it("wakes the origin agent after a direct dismissal", async () => {
    const created = await createCommentDecision();
    const result = await service().dismiss(created.id, decidedByUserId, boardActor(), "No");

    expect(result).toMatchObject({ status: "decided", chosenOptionId: "dismissed" });
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });
});
