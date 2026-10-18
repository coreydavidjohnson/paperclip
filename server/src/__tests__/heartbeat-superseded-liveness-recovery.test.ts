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
describe("superseded liveness recovery", () => {
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

 it("periodic admission preserves recovery with the outbox already done and never rearms it", async () => {
  const f = await held(); await lift(f.policy.id); await age(f.receipt.id);
  execute.mockImplementation(() => finish(f.task.id));
  await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0].context.forceFreshSession).toBe(true);
  expect(execute.mock.calls[0][0].context.recovery).toMatchObject({ predecessorRunId: f.run.id, outcomesUnknown: true });
  expect(execute.mock.calls[0][0].context.prompt).toContain("do not blindly replay");
  expect((await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.id, f.outbox.id)))[0]).toMatchObject({ status: "done", attempts: f.outbox.attempts });
  await heartbeat.resumeQueuedRuns(); await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
 });

 it.each(["skipped", "coalesced"])("fresh admission recovers an unbound legacy %s receipt exactly once", async status => {
  const f = await held();
  await db.update(agentWakeupRequests).set({ status, finishedAt: new Date(), runId: null }).where(eq(agentWakeupRequests.id, f.receipt.id));
  await lift(f.policy.id); execute.mockImplementation(() => finish(f.task.id));
  // Retry the real outbox consumer before fresh user admission. An old unbound
  // receipt must retain its safety context without starting a duplicate turn.
  await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.id, f.outbox.id));
  await heartbeat.consumeExternalRunLivenessOutbox();
  expect(execute).not.toHaveBeenCalled();
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0]).toMatchObject({ status, runId: null });
  const resumed = await request(f.app).patch(`/api/issues/${f.task.id}`).send({ status: "todo", resume: true, comment: "Check prior effects and continue once.", commentClientRequestId: crypto.randomUUID() });
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 15000 }); await heartbeat.drainActiveRunExecutions();
  expect(execute.mock.calls[0][0].context.forceFreshSession).toBe(true);
  expect(execute.mock.calls[0][0].context.recovery).toMatchObject({ predecessorRunId: f.run.id, outcomesUnknown: true });
  await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.id, f.outbox.id));
  await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0].runId).toBe(execute.mock.calls[0][0].runId);
 });
});
