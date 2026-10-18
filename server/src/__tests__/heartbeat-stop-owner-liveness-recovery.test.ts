import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, runLivenessOutbox, budgetPolicies, costEvents, projects, companyMemberships, authUsers } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
const { execute, observe, probe } = vi.hoisted(() => ({ execute: vi.fn(), observe: vi.fn(), probe: vi.fn() }));
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(), getServerAdapter: vi.fn(() => ({ type: "test_external", execute, observeRun: observe, probeRun: probe })) }));
const support = await getEmbeddedPostgresTestSupport(); console.log("POSTGRES_SUPPORT", support);
if (!support.supported) throw new Error(`Embedded PostgreSQL required: ${JSON.stringify(support)}`);
describe("Stop, owner and receipt recovery boundaries", () => {
 let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, heartbeat: ReturnType<typeof heartbeatService>;
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("superseded-liveness-"); db = createDb(temp.connectionString); heartbeat = heartbeatService(db); await db.insert(authUsers).values({id:"board-user",name:"Test board",email:"board@example.test",createdAt:new Date(),updatedAt:new Date()}); }, 120000);
 afterAll(async () => { await heartbeat?.drainActiveRunExecutions(); await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
 async function fixture() {
  const {getServerAdapter}=await import("../adapters/index.js");
  vi.mocked(getServerAdapter).mockReset().mockReturnValue({type:"test_external",execute,observeRun:observe,probeRun:probe} as never);
  execute.mockReset(); observe.mockReset(); probe.mockReset();
  const [company] = await db.insert(companies).values({ name: "Observer", issuePrefix: crypto.randomUUID().slice(0, 8) }).returning();
  await db.insert(companyMemberships).values({companyId: company.id, principalType: "user", principalId: "board-user", status: "active", membershipRole: "owner"});
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Observer", adapterType: "test_external", status: "running" }).returning();
  return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, runtimeMode: "legacy", status: "running", runnerProfileJson: { externalObservation: { adapterType: "test_external", config: {} } }, startedAt: new Date(Date.now()-3600000), externalRunHandle: { sessionId: "existing", turnRef: "turn", dispatch: "accepted" } }).returning())[0];
 }

 function appFor(companyId: string) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
  app.use("/api", issueRoutes(db, {} as never)); app.use("/api", agentRoutes(db)); app.use(errorHandler);
  return app;
 }
 async function held() {
  const run = await fixture();
  const [project] = await db.insert(projects).values({ companyId: run.companyId, name: "[test] supersession" }).returning();
  const [task] = await db.insert(issues).values({ companyId: run.companyId, projectId: project.id, title: "[test] recovery supersession", status: "in_progress", assigneeAgentId: run.agentId, responsibleUserId: "board-user", executionRunId: run.id }).returning();
  await db.update(companies).set({ defaultResponsibleUserId: "board-user" }).where(eq(companies.id, run.companyId));
  await db.update(heartbeatRuns).set({ issueId: task.id, contextSnapshot: { issueId: task.id } }).where(eq(heartbeatRuns.id, run.id));
  const [policy] = await db.insert(budgetPolicies).values({ companyId: run.companyId, scopeType: "project", scopeId: project.id, metric: "billed_cents", windowKind: "lifetime", amount: 1, hardStopEnabled: true, unpricedUsagePolicy: "allow", notifyEnabled: false }).returning();
  await db.insert(costEvents).values({ companyId: run.companyId, agentId: run.agentId, projectId: project.id, provider: "test", model: "test", costCents: 2, occurredAt: new Date() });
  probe.mockResolvedValue({ state: "gone", authoritative: true });
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox();
  expect(execute).not.toHaveBeenCalled();
  const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
  expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
  expect(receipt.payload?.executionWait).toMatchObject({ reason: "budget.blocked" });
  const [outbox] = await db.select().from(runLivenessOutbox).where(and(eq(runLivenessOutbox.runId, run.id), eq(runLivenessOutbox.action, "finalize_external_run")));
  expect(outbox.status, JSON.stringify(outbox)).toBe("done");
  return { run, task, policy, receipt, outbox, app: appFor(run.companyId) };
 }
 async function lift(policyId: string) { const [policy] = await db.update(budgetPolicies).set({ amount: 100 }).where(eq(budgetPolicies.id, policyId)).returning(); await db.update(companies).set({ status: "active" }).where(eq(companies.id, policy.companyId)); await db.update(agents).set({status: "idle"}).where(eq(agents.companyId, policy.companyId)); }
 async function age(receiptId: string) { await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, receiptId)); }
 async function finish(taskId: string) { await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, taskId)); return { exitCode: 0, signal: null, timedOut: false, resultJson: {} }; }

 it("real Stop suppresses old recovery but explicit new continuation is not wedged", async () => {
  const f = await held();
  await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.run.agentId));
  // A later queued operator turn is fixture state; cancellation itself uses the real Stop route.
  const [later] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.run.agentId, issueId: f.task.id, status: "queued", runtimeMode: "legacy", contextSnapshot: { issueId: f.task.id } }).returning();
  await db.update(issues).set({ executionRunId: later.id }).where(eq(issues.id, f.task.id));
  const stopped = await request(f.app).post(`/api/heartbeat-runs/${later.id}/cancel`).send({});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, later.id)))[0]).toMatchObject({ status: "cancelled", resultJson: { cancelledByActorType: "user" } });
  await lift(f.policy.id); await age(f.receipt.id);
  await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); expect(execute).not.toHaveBeenCalled();
  execute.mockImplementation(() => finish(f.task.id));
  const resumed = await request(f.app).patch(`/api/issues/${f.task.id}`).send({ status: "todo", resume: true, comment: "Start new work. First check all prior effects.", commentClientRequestId: crypto.randomUUID() });
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await heartbeat.drainActiveRunExecutions();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 15000 }); await heartbeat.drainActiveRunExecutions();
  expect(execute.mock.calls[0][0].context.forceFreshSession).toBe(true);
  expect(execute.mock.calls[0][0].context.recovery).toMatchObject({ predecessorRunId: f.run.id, outcomesUnknown: true });
  expect(execute.mock.calls[0][0].context.prompt).toContain("do not blindly replay");
  await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); expect(execute).toHaveBeenCalledOnce();
 }, 40000);

 it("reassignment releases new-owner queued input despite an old-owner budget recovery", async () => {
  const f = await held(); await lift(f.policy.id);
  const [newAgent] = await db.insert(agents).values({ companyId: f.run.companyId, name: "New owner", adapterType: "test_external", status: "idle" }).returning();
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  execute.mockImplementationOnce(async () => { await hold; return { exitCode: 0, signal: null, timedOut: false, resultJson: {} }; }).mockImplementation(() => finish(f.task.id));
  try {
   const reassigned = await request(f.app).patch(`/api/issues/${f.task.id}`).send({ assigneeAgentId: newAgent.id, status: "todo" });
   expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
   await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 15000 });
   expect(execute.mock.calls[0][0].agent.id).toBe(newAgent.id);
   const message = await request(f.app).post(`/api/issues/${f.task.id}/comments`).send({ body: "Keep this new-owner direction.", clientRequestId: crypto.randomUUID() });
   expect(message.status, JSON.stringify(message.body)).toBe(201);
   release(); await heartbeat.drainActiveRunExecutions();  await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
   await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), { timeout: 15000 });
   expect(execute.mock.calls.every(call => call[0].agent.id === newAgent.id)).toBe(true);
   expect(execute.mock.calls[1][0].context.wakeCommentIds).toContain(message.body.id);
   expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0].runId).toBeNull();
  } finally { release(); await heartbeat.drainActiveRunExecutions(); }
 }, 40000);

 it("budget cancellation protects only the matching company and agent saved input", async () => {
  const f = await held();
  const [other] = await db.insert(agents).values({ companyId: f.run.companyId, name: "Other", adapterType: "test_external", status: "idle" }).returning();
  const [foreign] = await db.insert(companies).values({ name: "Foreign", issuePrefix: crypto.randomUUID().slice(0, 8) }).returning();
  const [foreignAgent] = await db.insert(agents).values({ companyId: foreign.id, name: "Foreign", adapterType: "test_external", status: "idle" }).returning();
  const rows = await db.insert(agentWakeupRequests).values([
   { companyId: f.run.companyId, agentId: f.run.agentId, source: "automation", status: "deferred_issue_execution", payload: { issueId: f.task.id } },
   { companyId: f.run.companyId, agentId: other.id, source: "automation", status: "deferred_issue_execution", payload: { issueId: f.task.id } },
   { companyId: foreign.id, agentId: foreignAgent.id, source: "automation", status: "deferred_issue_execution", payload: { issueId: f.task.id } },
  ]).returning();
  await heartbeat.cancelBudgetScopeWork({ companyId: f.run.companyId, scopeType: "company", scopeId: f.run.companyId });
  const read = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  expect(await read(rows[0].id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
  expect(await read(rows[1].id)).toMatchObject({ status: "cancelled", runId: null });
  expect(await read(rows[2].id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
  await heartbeat.cancelBudgetScopeWork({ companyId: foreign.id, scopeType: "agent", scopeId: foreignAgent.id });
  expect(await read(rows[2].id)).toMatchObject({ status: "cancelled", runId: null });
  expect(await read(f.receipt.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
  expect(execute).not.toHaveBeenCalled();
 });

 it.each(["cancelled", "bound"])("periodic and outbox redelivery do not revive a %s receipt", async state => {
  const f = await held();
  await db.update(agentWakeupRequests).set(state === "cancelled" ? { status: "cancelled", finishedAt: new Date() } : { status: "coalesced", runId: f.run.id, finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.receipt.id));
  const before = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
  await lift(f.policy.id); await age(f.receipt.id);
  await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.id, f.outbox.id));
  await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled();
  const after = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
  expect(after).toMatchObject({ status: before.status, runId: before.runId, finishedAt: before.finishedAt });
 });

});
