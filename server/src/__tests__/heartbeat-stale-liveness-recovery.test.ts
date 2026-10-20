import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { approvalRoutes } from "../routes/approvals.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, runLivenessOutbox, budgetPolicies, costEvents, projects, companyMemberships, authUsers, instanceSettings, approvals, issueApprovals, issueThreadInteractions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
const { execute, observe, probe } = vi.hoisted(() => ({ execute: vi.fn(), observe: vi.fn(), probe: vi.fn() }));
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(), getServerAdapter: vi.fn(() => ({ type: "test_external", execute, observeRun: observe, probeRun: probe })) }));
const support = await getEmbeddedPostgresTestSupport(); console.log("POSTGRES_SUPPORT", support);
if (!support.supported) throw new Error(`Embedded PostgreSQL required: ${JSON.stringify(support)}`);
describe("stale recovery and post-Stop delivery (simulated adapter, real PostgreSQL/routes)", () => {
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
  app.use("/api", issueRoutes(db, {} as never)); app.use("/api", agentRoutes(db)); app.use("/api", approvalRoutes(db)); app.use(errorHandler);
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


 async function secondPredecessor(f: Awaited<ReturnType<typeof held>>) {
  const [run] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.run.agentId, issueId: f.task.id, runtimeMode: "legacy", status: "running", runnerProfileJson: f.run.runnerProfileJson, startedAt: new Date(Date.now()-3600000), externalRunHandle: { sessionId: "newer", turnRef: "newer-turn", dispatch: "accepted" }, contextSnapshot: { issueId: f.task.id } }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.task.id));
  return run;
 }

 it("a current-generated cutoff skip cannot erase a newer predecessor recovery", async () => {
  const f = await held();
  // Remove only this fixture's first recovery: recreate its actual delivery
  // through the current worktree cutoff, not a synthesized legacy receipt.
  await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
  await lift(f.policy.id);
  await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableWorktreeRunExecution: true, worktreeRunExecutionActivatedAt: new Date(Date.now()+60000).toISOString(), worktreeRunExecutionActivationInstanceId: "per1049" } }).onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableWorktreeRunExecution: true, worktreeRunExecutionActivatedAt: new Date(Date.now()+60000).toISOString(), worktreeRunExecutionActivationInstanceId: "per1049" } } });
  const worktree = heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "per1049" } });
  await db.update(runLivenessOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(runLivenessOutbox.id, f.outbox.id));
  await worktree.consumeExternalRunLivenessOutbox();
  const [skipped] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${f.run.id}`));
  expect(skipped).toMatchObject({ status: "skipped", reason: "heartbeat.worktree_execution_cutoff", runId: null });
  const newer = await secondPredecessor(f);
  execute.mockImplementation(() => finish(f.task.id));
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0].context.recovery).toMatchObject({ predecessorRunId: newer.id, outcomesUnknown: true });
  expect(execute.mock.calls[0][0].context.prompt).toContain("do not blindly replay");
  const [old] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, skipped.id));
  expect(old).toMatchObject({ status: "skipped", runId: null });
  await db.delete(instanceSettings);
 });

 it("a deferred older predecessor does not replace a new recovery contract", async () => {
  const f = await held(); await lift(f.policy.id);
  const newer = await secondPredecessor(f);
  execute.mockImplementation(() => finish(f.task.id));
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0].context.recovery).toMatchObject({ predecessorRunId: newer.id, outcomesUnknown: true });
 });

 it.each(["answer", "approval"] as const)("Stop then %s keeps delivery data without starting work before fresh input", async kind => {
  const f = await held();
  await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.run.agentId));
  let cardId: string;
  if (kind === "answer") {
   const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.run.companyId, issueId: f.task.id, sourceRunId: f.run.id, createdByAgentId: f.run.agentId, kind: "ask_user_questions", payload: { version: 1, questions: [{ id: "next", prompt: "Which scope?", selectionMode: "single", required: true, options: [{ id: "verify", label: "Verify effects" }] }] } }).returning();
   cardId=card.id;
  } else {
   const [approval]=await db.insert(approvals).values({ companyId:f.run.companyId,type:"request_board_approval",status:"pending",requestedByAgentId:f.run.agentId,payload:{title:"Verify effects"} }).returning();
   cardId=approval.id; await db.insert(issueApprovals).values({companyId:f.run.companyId,issueId:f.task.id,approvalId:cardId});
  }
  const [later]=await db.insert(heartbeatRuns).values({companyId:f.run.companyId,agentId:f.run.agentId,issueId:f.task.id,status:"queued",runtimeMode:"legacy",contextSnapshot:{issueId:f.task.id}}).returning();
  await db.update(issues).set({executionRunId:later.id}).where(eq(issues.id,f.task.id));
  const stop=await request(f.app).post(`/api/heartbeat-runs/${later.id}/cancel`).send({});
  expect(stop.status,JSON.stringify(stop.body)).toBe(200);
  await lift(f.policy.id);
  const response=kind==="answer"
   ? await request(f.app).post(`/api/issues/${f.task.id}/interactions/${cardId}/respond`).send({answers:[{questionId:"next",optionIds:["verify"]}]})
   : await request(f.app).post(`/api/approvals/${cardId}/approve`).send({});
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  await heartbeat.drainActiveRunExecutions(); await age(f.receipt.id); await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled();
  execute.mockImplementation(() => finish(f.task.id));
  const fresh=await request(f.app).post(`/api/issues/${f.task.id}/comments`).send({body:"Start fresh work. Use my saved decision and verify prior effects.",clientRequestId:crypto.randomUUID()});
  expect(fresh.status,JSON.stringify(fresh.body)).toBe(201);
  await vi.waitFor(()=>expect(execute).toHaveBeenCalledOnce(),{timeout:15000}); await heartbeat.drainActiveRunExecutions();
  const delivered = execute.mock.calls[0][0].context;
  if (kind === "answer") expect(delivered.executionContinuation.humanResponses).toContainEqual(expect.objectContaining({ id: cardId, status: "answered", result: { answers: [expect.objectContaining({questionId:"next",optionIds:["verify"]})] } }));
  else expect(delivered).toMatchObject({ approvalId: cardId, approvalStatus: "approved" });
  expect(execute.mock.calls[0][0].context.wakeCommentIds).toContain(fresh.body.id);
  if(kind==="answer") {
   const saved=(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,cardId)))[0];
   expect(saved.result?.answers).toHaveLength(1);
   await questionResponseDeliveryService(db,{heartbeat}).deliver(cardId);
  }
  await heartbeat.resumeQueuedRuns(); await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
 },40000);

 it("mentioning the former assignee cannot resurrect its old liveness receipt", async () => {
  const f=await held(); await lift(f.policy.id);
  const [owner]=await db.insert(agents).values({companyId:f.run.companyId,name:"New owner",adapterType:"test_external",status:"idle"}).returning();
  let release!:()=>void; const wait=new Promise<void>(r=>{release=r;});
  execute.mockImplementationOnce(async()=>{await wait;return {exitCode:0,signal:null,timedOut:false,resultJson:{}};}).mockImplementation(()=>finish(f.task.id));
  try {
   expect((await request(f.app).patch(`/api/issues/${f.task.id}`).send({assigneeAgentId:owner.id,status:"todo"})).status).toBe(200);
   await vi.waitFor(()=>expect(execute).toHaveBeenCalledOnce(),{timeout:15000});
   const mentioned=await request(f.app).post(`/api/issues/${f.task.id}/comments`).send({body:`@[Observer](${f.run.agentId}) Check the old work. New owner: preserve this instruction.`,clientRequestId:crypto.randomUUID()});
   expect(mentioned.status,JSON.stringify(mentioned.body)).toBe(201);
   release(); await heartbeat.drainActiveRunExecutions(); await age(f.receipt.id); await heartbeat.resumeQueuedRuns(); await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.drainActiveRunExecutions();
   await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(2),{timeout:15000});
   expect(execute.mock.calls.every(call=>call[0].agent.id===owner.id)).toBe(true);
   expect(execute.mock.calls[1][0].context.wakeCommentIds).toContain(mentioned.body.id);
   expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.receipt.id)))[0].runId).toBeNull();
  } finally {release();await heartbeat.drainActiveRunExecutions();}
 },40000);
});
