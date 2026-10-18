import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, runLivenessOutbox, approvals, issueApprovals, issueThreadInteractions, issueRelations, issueRecoveryActions, issueComments } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { heartbeatService } from "../services/heartbeat.js";
const { execute, observe, probe } = vi.hoisted(() => ({ execute: vi.fn(), observe: vi.fn(), probe: vi.fn() }));
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(), getServerAdapter: vi.fn(() => ({ type: "test_external", execute, observeRun: observe, probeRun: probe })) }));
const support = await getEmbeddedPostgresTestSupport(); console.log("POSTGRES_SUPPORT", support);
if (!support.supported) throw new Error(`Embedded PostgreSQL required: ${JSON.stringify(support)}`);
describe("route liveness recovery", () => {
 let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, heartbeat: ReturnType<typeof heartbeatService>;
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("route-liveness-"); db = createDb(temp.connectionString); heartbeat = heartbeatService(db); }, 120000);
 afterAll(async () => { await heartbeat?.drainActiveRunExecutions(); await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
 async function fixture() {
  const {getServerAdapter}=await import("../adapters/index.js");
  vi.mocked(getServerAdapter).mockReset().mockReturnValue({type:"test_external",execute,observeRun:observe,probeRun:probe} as never);
  execute.mockReset(); observe.mockReset(); probe.mockReset();
  const [company] = await db.insert(companies).values({ name: "Observer", issuePrefix: crypto.randomUUID().slice(0, 8) }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Observer", adapterType: "test_external", status: "running" }).returning();
  return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, runtimeMode: "legacy", status: "running", runnerProfileJson: { externalObservation: { adapterType: "test_external", config: {} } }, startedAt: new Date(Date.now()-3600000), externalRunHandle: { sessionId: "existing", turnRef: "turn", dispatch: "accepted" } }).returning())[0];
 }
 it.each(["clear", "concurrent", "question", "dependency", "no-replay", "stop", "queued-input"])("real approval route preserves recovery with %s", async gate => {
  const run = await fixture();
  const [task] = await db.insert(issues).values({ companyId: run.companyId, title: "[test] approval recovery", status: "in_progress", assigneeAgentId: run.agentId, responsibleUserId: "board-user", executionRunId: run.id }).returning();
  await db.update(companies).set({ defaultResponsibleUserId: "board-user" }).where(eq(companies.id, run.companyId));
  await db.update(heartbeatRuns).set({ issueId: task.id, contextSnapshot: { issueId: task.id } }).where(eq(heartbeatRuns.id, run.id));
  const [approval] = await db.insert(approvals).values({ companyId: run.companyId, type: "request_board_approval", status: "pending", requestedByAgentId: run.agentId, payload: { title: "[test] resume" } }).returning();
  await db.insert(issueApprovals).values({ companyId: run.companyId, issueId: task.id, approvalId: approval.id });
  let blockerId: string | undefined;
  if (gate === "question") await db.insert(issueThreadInteractions).values({ companyId: run.companyId, issueId: task.id, kind: "ask_user_questions", status: "pending", payload: {} });
  if (gate === "dependency") {
   const [blocker] = await db.insert(issues).values({ companyId: run.companyId, title: "[test] prerequisite", status: "todo" }).returning();
   blockerId = blocker.id;
   await db.insert(issueRelations).values({ companyId: run.companyId, issueId: blocker.id, relatedIssueId: task.id, type: "blocks" });
  }
  probe.mockResolvedValue({ state: "gone", authoritative: true });
  execute.mockImplementation(async () => { await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, task.id)); return { exitCode: 0, signal: null, timedOut: false, resultJson: {} }; });
  let releaseExecution: (() => void) | undefined;
  if (gate === "concurrent") {
   const hold = new Promise<void>(resolve => { releaseExecution = resolve; });
   execute.mockImplementation(async () => {
    await hold;
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, task.id));
    return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
   });
  }
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox();
  expect(execute).not.toHaveBeenCalled();
  if (gate === "no-replay") await db.insert(issueRecoveryActions).values({ companyId: run.companyId, sourceIssueId: task.id, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `test:${run.id}`, status: "resolved", nextAction: "Inspect prior effects", evidence: { runId: run.id, automaticRecovery: { replay: "blocked" } } });
  if (gate === "stop") await db.insert(heartbeatRuns).values({ companyId: run.companyId, agentId: run.agentId, issueId: task.id, runtimeMode: "legacy", status: "cancelled", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: task.id }, resultJson: { cancellation: { source: "user", reason: "Stop" } } });
  let queuedCommentId: string | undefined;
  if (gate === "queued-input") {
   const [comment] = await db.insert(issueComments).values({ companyId: run.companyId, issueId: task.id, authorUserId: "board-user", authorType: "user", body: "Keep this new instruction." }).returning();
   queuedCommentId = comment.id;
   await db.insert(agentWakeupRequests).values({ companyId: run.companyId, agentId: run.agentId, source: "automation", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "board-user", status: "deferred_issue_execution", payload: { issueId: task.id, wakeCommentIds: [comment.id], _paperclipWakeContext: { issueId: task.id, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } } });
  }
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "board-user", companyIds: [run.companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
  app.use("/api", approvalRoutes(db)); app.use(errorHandler);
  const approve = () => request(app).post(`/api/approvals/${approval.id}/approve`).send({});
  if (gate === "concurrent") {
   const [held] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
   await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, held.id));
   const responses = await Promise.all([approve(), approve(), heartbeat.resumeQueuedRuns()]);
   expect(responses.slice(0, 2).map(response => response!.status)).toEqual([200, 200]);
  } else {
   const response = await approve();
   expect(response.status, JSON.stringify(response.body)).toBe(200);
  }
  if (gate === "concurrent") {
   try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 15000 });
    const duplicates = await Promise.all([approve(), approve(), heartbeat.resumeQueuedRuns()]);
    expect(duplicates.slice(0, 2).map(response => response!.status)).toEqual([200, 200]);
    expect(execute).toHaveBeenCalledOnce();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(2);
   } finally { releaseExecution?.(); }
  }
  await heartbeat.drainActiveRunExecutions();
  if (["question", "dependency", "no-replay", "stop"].includes(gate)) {
   expect(execute).not.toHaveBeenCalled();
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(gate === "stop" ? 2 : 1);
   if (gate === "no-replay" || gate === "stop") return;
   if (blockerId) await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
   else await db.update(issueThreadInteractions).set({ status: "answered" }).where(eq(issueThreadInteractions.issueId, task.id));
   const [held] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
   await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, held.id));
   await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
  }
  expect(execute).toHaveBeenCalledOnce();
  if (queuedCommentId) expect(execute.mock.calls[0][0].context.wakeCommentIds).toContain(queuedCommentId);
  expect(execute.mock.calls[0][0].context).toMatchObject({ forceFreshSession: true, recovery: { predecessorRunId: run.id, outcomesUnknown: true } });
  expect(execute.mock.calls[0][0].context.prompt).toContain("do not blindly replay");
  expect(execute.mock.calls[0][0].context).toMatchObject({ approvalId: approval.id, approvalStatus: "approved" });
  const successorId = execute.mock.calls[0][0].runId;
  await db.update(issues).set({ status: "in_progress", completedAt: null }).where(eq(issues.id, task.id));
  const repeats = await Promise.all([request(app).post(`/api/approvals/${approval.id}/approve`).send({}), request(app).post(`/api/approvals/${approval.id}/approve`).send({})]);
  expect(repeats.map(response => response.status)).toEqual([200, 200]);
  await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.runId, run.id));
  const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
  await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, receipt.id));
  await Promise.all([heartbeat.consumeExternalRunLivenessOutbox(), heartbeat.resumeQueuedRuns()]);
  await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(2);
  const adopted = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0];
  expect(adopted.runId).toBe(successorId);
  expect(["coalesced", "completed", "succeeded"]).toContain(adopted.status);
 });

 it("adopts gone recovery through the real answer service and durable delivery callback", async () => {
  const run = await fixture();
  const [task] = await db.insert(issues).values({ companyId: run.companyId, title: "[test] answer recovery", status: "in_progress", assigneeAgentId: run.agentId, responsibleUserId: "board-user", executionRunId: run.id }).returning();
  await db.update(companies).set({ defaultResponsibleUserId: "board-user" }).where(eq(companies.id, run.companyId));
  await db.update(heartbeatRuns).set({ issueId: task.id, contextSnapshot: { issueId: task.id } }).where(eq(heartbeatRuns.id, run.id));
  const interactions = issueThreadInteractionService(db);
  const interaction = await interactions.create(task, { kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId: run.id, payload: { version: 1, questions: [{ id: "next", prompt: "Which task must continue?", selectionMode: "single", required: true, options: [{ id: "verify", label: "Verify prior effects" }] }] } }, { agentId: run.agentId, runId: run.id });
  probe.mockResolvedValue({ state: "gone", authoritative: true });
  execute.mockImplementation(async () => { await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, task.id)); return { exitCode: 0, signal: null, timedOut: false, resultJson: {} }; });
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox();
  expect(execute).not.toHaveBeenCalled();
  const answered = await interactions.answerQuestions(task, interaction.id, { answers: [{ questionId: "next", optionIds: ["verify"] }] }, { userId: "board-user" });
  expect(answered.status).toBe("answered");
  const deliveries = questionResponseDeliveryService(db, { heartbeat });
  await deliveries.deliver(interaction.id);
  await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0].context).toMatchObject({ forceFreshSession: true, recovery: { predecessorRunId: run.id, outcomesUnknown: true }, interactionId: interaction.id, interactionStatus: "answered" });
  expect(execute.mock.calls[0][0].context.executionContinuation.humanResponses).toContainEqual(expect.objectContaining({ id: interaction.id, result: { answers: [{ questionId: "next", optionIds: ["verify"] }] } }));
  expect(execute.mock.calls[0][0].context.prompt).toContain("do not blindly replay");
  await Promise.all([deliveries.deliver(interaction.id), deliveries.deliver(interaction.id)]);
  await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.runId, run.id));
  const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
  await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, receipt.id));
  await Promise.all([heartbeat.consumeExternalRunLivenessOutbox(), heartbeat.resumeQueuedRuns()]);
  await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(2);
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0]).toMatchObject({ status: "coalesced", runId: execute.mock.calls[0][0].runId });
 });

 it.each(["gone", "active", "unknown", "hold"])("real blocked/unblocked routes preserve %s provider evidence", async state => {
  const run = await fixture();
  const [task] = await db.insert(issues).values({ companyId: run.companyId, title: "[test] blocked recovery", status: "in_progress", assigneeAgentId: run.agentId, responsibleUserId: "board-user", executionRunId: run.id }).returning();
  const [blocker] = await db.insert(issues).values({ companyId: run.companyId, title: "[test] blocking task", status: "todo" }).returning();
  await db.update(companies).set({ defaultResponsibleUserId: "board-user" }).where(eq(companies.id, run.companyId));
  await db.update(heartbeatRuns).set({ issueId: task.id, contextSnapshot: { issueId: task.id } }).where(eq(heartbeatRuns.id, run.id));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [run.companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
  app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
  const blocked = await request(app).patch(`/api/issues/${task.id}`).send({ status: "blocked", blockedByIssueIds: [blocker.id] });
  expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
  probe.mockResolvedValue(state === "active" ? { state: "active" } : state === "unknown" ? { state: "unknown", reason: "unavailable" } : { state: "gone", authoritative: true });
  let releaseObserver!: () => void, releaseExecution!: () => void;
  const observationHold = new Promise<void>(resolve => { releaseObserver = resolve; });
  const executionHold = new Promise<void>(resolve => { releaseExecution = resolve; });
  observe.mockImplementation(async () => { await observationHold; return { exitCode: 0, signal: null, timedOut: false, resultJson: { staleResult: true } }; });
  execute.mockImplementation(async () => { await executionHold; await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, task.id)); return { exitCode: 0, signal: null, timedOut: false, resultJson: {} }; });
  try {
   await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox();
   expect(probe).toHaveBeenCalledOnce();
   expect(execute).not.toHaveBeenCalled();
   if (state === "active") await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
   else expect(observe).not.toHaveBeenCalled();
   if (state !== "hold") {
    const lifted = await request(app).patch(`/api/issues/${task.id}`).send({ blockedByIssueIds: [] });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
   }
   const commentClientRequestId = crypto.randomUUID();
   const resume = () => request(app).patch(`/api/issues/${task.id}`).send({ status: "todo", resume: true, comment: "Verify prior effects and keep this direction.", commentClientRequestId });
   const resumed = await resume();
   expect(resumed.status, JSON.stringify(resumed.body)).toBe(state === "hold" ? 409 : 200);
   if (state === "hold") {
    await heartbeat.resumeQueuedRuns();
    expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0].status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(1);
    return;
   }
   if (state === "active" || state === "unknown") {
    // The status route enqueues asynchronously: wait for durable admission, not HTTP completion.
    await vi.waitFor(async () => {
     expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0].executionRunId).toBe(run.id);
    }, { timeout: 15000 });
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].livenessProbe).toMatchObject({ state });
    // Positive stop evidence, not the resume request, permits a new admission.
    probe.mockResolvedValue({ state: "gone", authoritative: true });
    await db.update(heartbeatRuns).set({ livenessClaimedUntil: null, controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
    await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox();
   }
   await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 15000 });
   const successorId = execute.mock.calls[0][0].runId;
   expect(execute.mock.calls[0][0].context).toMatchObject({ forceFreshSession: true, recovery: { predecessorRunId: run.id, outcomesUnknown: true } });
   expect(execute.mock.calls[0][0].context.prompt).toContain("do not blindly replay");
   expect(execute.mock.calls[0][0].context.wakeCommentIds).toHaveLength(1);
   const [comment] = await db.select().from(issueComments).where(eq(issueComments.issueId, task.id));
   expect(execute.mock.calls[0][0].context.wakeCommentIds).toContain(comment.id);
   const repeats = await Promise.all([request(app).patch(`/api/issues/${task.id}`).send({ status: "todo", resume: true, comment: "Verify prior effects and keep this direction.", commentClientRequestId }), heartbeat.resumeQueuedRuns()]);
   expect(repeats[0]!.status, JSON.stringify(repeats[0]!.body)).toBe(200);
   await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.runId, run.id));
   await heartbeat.consumeExternalRunLivenessOutbox();
   // Race the old observer result against the admitted successor. Its epoch is stale.
   releaseObserver(); releaseExecution();
   await heartbeat.drainActiveRunExecutions();
   expect(execute).toHaveBeenCalledOnce();
   expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "failed", errorCode: "external_session_gone" });
   expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId)))[0].status).toBe("succeeded");
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(2);
   expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0].executionRunId).not.toBe(run.id);
  } finally { releaseObserver(); releaseExecution(); await heartbeat.drainActiveRunExecutions(); }
 });
});
