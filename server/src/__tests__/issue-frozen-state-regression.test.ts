import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueRelations, issues, issueThreadInteractions, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Incident failures: a newer comment discarded a non-superseding setup card;
// a rejected cross-task repair claimed checkout; atomic blocker removal read
// the old blocker set. These are persisted HTTP contracts, not source mirrors.
const questions = [{ id: "setup", prompt: "Is setup complete?", selectionMode: "single", options: [{ id: "ready", label: "Ready" }] }];
const answers = [{ questionId: "setup", optionIds: ["ready"] }];
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("frozen issue repair contracts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("frozen-issue-repair-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(status: string = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Repair", issuePrefix: `F${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Repair owner", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved work", status, assigneeAgentId: agentId });
    return { companyId, agentId, issueId };
  }
  function app(actor: Express.Request["actor"]) {
    const result = express(); result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor; next(); });
    result.use("/api", issueRoutes(db, {} as any)); result.use(errorHandler); return result;
  }
  const board: Express.Request["actor"] = { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit", companyIds: [] };

  it.each([false, true, undefined, null])("respects supersedeOnUserComment=%s when blocking on an existing card", async supersedeOnUserComment => {
    const f = await fixture();
    const [card] = await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee",
      createdByAgentId: f.agentId, addresseeUserId: "local-board", effectiveResolverPolicy: "anyone",
      title: "Private setup result", payload: { version: 1, ...(supersedeOnUserComment === undefined ? {} : { supersedeOnUserComment }), questions },
      createdAt: new Date("2026-11-15T23:41:00Z"),
    }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: "local-board", authorType: "user", body: "Status check, not a setup answer", createdAt: new Date("2026-11-15T23:50:00Z") });
    const response = await request(app(board)).patch(`/api/issues/${f.issueId}`).send({ status: "blocked" });
    expect(response.status, JSON.stringify(response.body)).toBe(supersedeOnUserComment === false ? 200 : 422);
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
    expect(saved.status).toBe("pending"); expect(saved.result).toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe(supersedeOnUserComment === false ? "blocked" : "in_progress");
  });

  async function waitForBlockedBackend(blockerPid: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`select exists (
        select 1 from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))
      ) as waiting`);
      if (rows[0]?.waiting === true) return;
      // Poll for the database lock relationship, not elapsed time as evidence.
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error("Expected a real PostgreSQL lock wait before releasing the writer");
  }

  it.each(["missingTask", "foreignCompany", "foreignAgent"])("denies checkout adoption with %s ownership", async ownership => {
    const f = await fixture();
    const foreign = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: ownership === "foreignCompany" ? foreign.companyId : f.companyId,
      agentId: ownership === "foreignAgent" ? foreign.agentId : f.agentId,
      status: "running", runtimeMode: "legacy",
      contextSnapshot: ownership === "missingTask" ? {} : { issueId: f.issueId },
    }).returning();
    await expect(issueService(db).assertCheckoutOwner(f.issueId, f.agentId, run.id)).rejects.toMatchObject({ status: 409 });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.checkoutRunId).toBeNull(); expect(saved.executionRunId).toBeNull(); expect(saved.executionLockedAt).toBeNull();
  });

  it("fails closed when the actor run is rebound while adoption waits on its row lock", async () => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "New run owner" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId },
    }).returning();
    const locked = deferred<number>(), release = deferred<void>();
    const rebinding = db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
      locked.resolve(Number(rows[0].pid));
      await release.promise;
      await tx.update(heartbeatRuns).set({ contextSnapshot: { issueId: other.id } }).where(eq(heartbeatRuns.id, run.id));
    });
    let adoption: Promise<any> | undefined;
    try {
      const blockerPid = await locked.promise;
      adoption = issueService(db).assertCheckoutOwner(f.issueId, f.agentId, run.id)
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBackend(blockerPid);
      release.resolve(); await rebinding;
      expect((await adoption).error).toMatchObject({ status: 409 });
      const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(saved.checkoutRunId).toBeNull(); expect(saved.executionRunId).toBeNull(); expect(saved.executionLockedAt).toBeNull();
    } finally {
      release.resolve(); await Promise.allSettled([rebinding, ...(adoption ? [adoption] : [])]);
    }
  });

  it("keeps a non-superseding card answerable across a concurrent genuine comment", async () => {
    const f = await fixture("blocked");
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee",
      createdByAgentId: f.agentId, effectiveResolverPolicy: "anyone", title: "Setup answer",
      payload: { version: 1, supersedeOnUserComment: false, questions },
    }).returning();
    const interactionSvc = issueThreadInteractionService(db);
    const locked = deferred<number>(), release = deferred<void>();
    const answering = interactionSvc.answerQuestions({ id: f.issueId, companyId: f.companyId }, card.id,
      { answers, summaryMarkdown: "Explicit setup answer" }, { userId: "local-board" }, {
        beforeResolveInTransaction: async tx => {
          const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
          locked.resolve(Number(rows[0].pid)); await release.promise;
        },
      }).then(value => ({ value }), error => ({ error }));
    let commenting: Promise<any> | undefined;
    try {
      const blockerPid = await Promise.race([locked.promise, answering.then(result => {
        throw result.error ?? new Error("Answer completed before its lock barrier");
      })]);
      commenting = (async () => {
        const comment = await issueService(db).addComment(f.issueId, "Not an answer", { userId: "local-board" });
        return interactionSvc.expireRequestConfirmationsSupersededByComment({ id: f.issueId, companyId: f.companyId }, comment, { userId: "local-board" });
      })().then(value => ({ value }), error => ({ error }));
      await waitForBlockedBackend(blockerPid);
      release.resolve();
      const answer = await answering; expect(answer.error).toBeUndefined();
      expect((await commenting).value).toEqual([]);
      const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(saved.status).toBe("answered");
      expect(saved.result).toMatchObject({ summaryMarkdown: "Explicit setup answer" });
      const deliveries = await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, card.id));
      expect(deliveries).toHaveLength(1);
      await expect(interactionSvc.answerQuestions({ id: f.issueId, companyId: f.companyId }, card.id,
        { answers }, { userId: "local-board" })).rejects.toMatchObject({ status: 409 });
    } finally {
      release.resolve(); await Promise.allSettled([answering, ...(commenting ? [commenting] : [])]);
    }
  });

  it("rolls back blocked and its triggering comment if that comment supersedes its only card", async () => {
    const f = await fixture();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee", title: "Old question",
      payload: { version: 1, supersedeOnUserComment: true, questions }, createdAt: new Date("2026-11-15T23:00:00Z"),
    }).returning();
    const response = await request(app(board)).patch(`/api/issues/${f.issueId}`)
      .send({ status: "blocked", comment: "This supersedes the old question" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toEqual([]);
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId)); expect(saved.status).toBe("in_progress");
    const [savedCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)); expect(savedCard.status).toBe("pending");
  });

  it("evaluates supersession per card rather than discarding a whole task's pending cards", async () => {
    const f = await fixture();
    const cards = await db.insert(issueThreadInteractions).values([false, true].map(supersedeOnUserComment => ({
      companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending",
      continuationPolicy: "wake_assignee", title: "Independent question",
      payload: { version: 1, supersedeOnUserComment, questions }, createdAt: new Date("2026-11-15T23:00:00Z"),
    }))).returning();
    const comment = await issueService(db).addComment(f.issueId, "New direction", { userId: "local-board" });
    const expired = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      { id: f.issueId, companyId: f.companyId }, comment, { userId: "local-board" });
    // addComment already ran expiry inside its transaction; a second pass is
    // idempotent and cannot touch the independently retained card.
    expect(expired).toEqual([]);
    const [superseded] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cards[1].id));
    expect(superseded.status).toBe("expired");
    const response = await request(app(board)).patch(`/api/issues/${f.issueId}`).send({ status: "blocked" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [retained] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cards[0].id));
    expect(retained.status).toBe("pending"); expect(retained.result).toBeNull();
  });

  it("rechecks blocker readiness under lock and rolls back a concurrent replacement", async () => {
    const f = await fixture("blocked");
    const [old, replacement] = await db.insert(issues).values([
      { companyId: f.companyId, title: "Old prerequisite", status: "blocked" },
      { companyId: f.companyId, title: "Was ready", status: "done" },
    ]).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: old.id, relatedIssueId: f.issueId, type: "blocks" });
    const locked = deferred<number>(), release = deferred<void>();
    const changingBlocker = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, replacement.id)).for("update");
      const rows = await tx.execute(sql`select pg_backend_pid() as pid`); locked.resolve(Number(rows[0].pid));
      await release.promise;
      await tx.update(issues).set({ status: "blocked" }).where(eq(issues.id, replacement.id));
    });
    let resuming: Promise<any> | undefined;
    try {
      const blockerPid = await locked.promise;
      resuming = issueService(db).update(f.issueId, { status: "in_progress", blockedByIssueIds: [replacement.id] })
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBackend(blockerPid);
      release.resolve(); await changingBlocker;
      expect((await resuming).error).toMatchObject({ status: 422, details: { unresolvedBlockerIssueIds: [replacement.id] } });
      const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId)); expect(saved.status).toBe("blocked");
      const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
      expect(relations.map(row => row.issueId)).toEqual([old.id]);
    } finally {
      release.resolve(); await Promise.allSettled([changingBlocker, ...(resuming ? [resuming] : [])]);
    }
  });

  it.each(["contextIssue", "contextTask", "nativeIssueId", "issueId"])("does not claim another task's checkout through %s on a rejected same-agent repair", async binding => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Actual run task", assigneeAgentId: f.agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "legacy",
      ...(binding === "contextIssue" ? { contextSnapshot: { issueId: other.id } } :
        binding === "contextTask" ? { contextSnapshot: { taskId: other.id } } :
        binding === "nativeIssueId" ? { nativeIssueId: other.id } : { issueId: other.id }),
    }).returning();
    const response = await request(app({ type: "agent", agentId: f.agentId, companyId: f.companyId, runId: run.id, source: "agent_jwt" })).patch(`/api/issues/${f.issueId}`).send({ status: "blocked" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.checkoutRunId).toBeNull(); expect(saved.executionRunId).toBeNull(); expect(saved.executionLockedAt).toBeNull();
  });

  it("removes the last stale blocker and resumes in one request", async () => {
    const f = await fixture("blocked");
    const [old] = await db.insert(issues).values({ companyId: f.companyId, title: "No longer a prerequisite", status: "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: old.id, relatedIssueId: f.issueId, type: "blocks" });
    const response = await request(app(board)).patch(`/api/issues/${f.issueId}`).send({ status: "in_progress", blockedByIssueIds: [], resume: true, comment: "The recorded prerequisite no longer applies; continue the saved work." });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.status).toBe("in_progress");
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId))).toEqual([]);
  });

  it.each(["blocked", "cancelled", "pending_finalize"])("does not resume past a replacement %s blocker or partially replace relations", async blockerState => {
    const f = await fixture("blocked");
    const [old] = await db.insert(issues).values({ companyId: f.companyId, title: "Previous prerequisite", status: "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: old.id, relatedIssueId: f.issueId, type: "blocks" });
    const [replacement] = await db.insert(issues).values({ companyId: f.companyId, title: "Real prerequisite", status: blockerState === "pending_finalize" ? "done" : blockerState }).returning();
    if (blockerState === "pending_finalize") {
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Unfinalized workspace", mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, replacement.id));
      await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: replacement.id, executionWorkspaceId: workspace.id, phase: "worktree_prepare", status: "succeeded" });
    }
    const response = await request(app(board)).patch(`/api/issues/${f.issueId}`).send({ status: "in_progress", blockedByIssueIds: [replacement.id], resume: true, comment: "Continue only if the replacement prerequisite is ready." });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details.unresolvedBlockerIssueIds).toEqual([replacement.id]);
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.status).toBe("blocked");
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
    expect(relations.map(row => row.issueId)).toEqual([old.id]);
  });
});
