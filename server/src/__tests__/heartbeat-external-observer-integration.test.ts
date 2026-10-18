import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, runLivenessOutbox, approvals, issueApprovals, issueThreadInteractions, issueRelations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
const { execute, observe, probe } = vi.hoisted(() => ({ execute: vi.fn(), observe: vi.fn(), probe: vi.fn() }));
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(), getServerAdapter: vi.fn(() => ({ type: "test_external", execute, observeRun: observe, probeRun: probe })) }));
const { resolveConfig, leaseStops } = vi.hoisted(() => ({ resolveConfig: vi.fn(), leaseStops: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock("../services/secrets.js", async original => {
 const actual = await original<typeof import("../services/secrets.js")>();
 return { ...actual, secretService: (...args: Parameters<typeof actual.secretService>) => ({
  ...actual.secretService(...args), resolveAdapterConfigForRuntime: resolveConfig,
 }) };
});
vi.mock("../services/legacy-controller-lease.js", async original => {
 const actual = await original<typeof import("../services/legacy-controller-lease.js")>();
 return { ...actual, watchLegacyControllerLease: (...args: Parameters<typeof actual.watchLegacyControllerLease>) => {
  const lease = actual.watchLegacyControllerLease(...args);
  const stop = vi.fn(() => lease.stop()); leaseStops.push(stop);
  return { ...lease, stop };
 } };
});
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("external heartbeat observer integration", () => {
 let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, heartbeat: ReturnType<typeof heartbeatService>;
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("external-observer-"); db = createDb(temp.connectionString); heartbeat = heartbeatService(db); }, 120000);
 afterAll(async () => { await heartbeat?.drainActiveRunExecutions(); await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
 async function fixture() {
  const {getServerAdapter}=await import("../adapters/index.js");
  vi.mocked(getServerAdapter).mockReset().mockReturnValue({type:"test_external",execute,observeRun:observe,probeRun:probe} as never);
  execute.mockReset(); observe.mockReset(); probe.mockReset();
  resolveConfig.mockReset().mockImplementation(async (_company, config) => ({ config, secretKeys: new Set<string>() }));
  leaseStops.length = 0;
  const [company] = await db.insert(companies).values({ name: "Observer", issuePrefix: crypto.randomUUID().slice(0, 8) }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Observer", adapterType: "test_external", status: "running" }).returning();
  return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, runtimeMode: "legacy", status: "running", runnerProfileJson: { externalObservation: { adapterType: "test_external", config: {} } }, startedAt: new Date(Date.now()-3600000), externalRunHandle: { sessionId: "existing", turnRef: "turn", dispatch: "accepted" } }).returning())[0];
 }
 const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,id)).then(rows => rows[0]!);
 it("observes stored handle without execute and uses normal completion", async () => {
  const run = await fixture(); probe.mockResolvedValue({ state: "active" });
  observe.mockImplementationOnce(async ctx => { expect(ctx.handle).toEqual(run.externalRunHandle); expect(ctx.runId).toBe(run.id); await ctx.onLog("stdout","Finished existing work"); await ctx.onHandle({ ...ctx.handle, dispatch: "observed" }); return { exitCode: 0, signal: null, timedOut: false, sessionId: "existing", resultJson: { finalResponse: "Finished" } }; });
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled(); expect(observe).toHaveBeenCalledOnce(); expect(await read(run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "existing", observerEpoch: 2 });
 });
 it("stops the observer lease when configuration resolution fails and later reattaches", async () => {
  const run = await fixture();
  await db.update(heartbeatRuns).set({ runnerProfileJson: { externalObservation: { adapterType: "test_external", config: { setupFailure: run.id } } } }).where(eq(heartbeatRuns.id, run.id));
  let resolutions = 0;
  resolveConfig.mockImplementation(async (_company, config) => {
   if (config.setupFailure === run.id && ++resolutions === 2) throw new Error("temporary configuration failure");
   return { config, secretKeys: new Set<string>() };
  });
  probe.mockResolvedValue({ state: "active" });
  try {
   await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
   expect(observe).not.toHaveBeenCalled();
   expect(leaseStops).toHaveLength(1); expect(leaseStops[0]).toHaveBeenCalledOnce();
   await db.update(heartbeatRuns).set({ livenessClaimedUntil: null, controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
   observe.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, resultJson: { finalResponse: "Recovered" } });
   await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
   expect(observe).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
   expect(await read(run.id)).toMatchObject({ status: "succeeded", observerEpoch: 3 });
  } finally { for (const stop of leaseStops) stop(); }
 });
 it("bounds hung observer setup and stops renewal before a later reattachment", async () => {
  const run = await fixture();
  await db.update(heartbeatRuns).set({ runnerProfileJson: { externalObservation: { adapterType: "test_external", config: { hungSetup: run.id } } } }).where(eq(heartbeatRuns.id, run.id));
  let resolutions = 0;
  resolveConfig.mockImplementation(async (_company, config) => {
   if (config.hungSetup === run.id && ++resolutions === 2) return new Promise(() => {});
   return { config, secretKeys: new Set<string>() };
  });
  probe.mockResolvedValue({ state: "active" });
  try {
   await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
   expect(observe).not.toHaveBeenCalled(); expect(leaseStops[0]).toHaveBeenCalledOnce();
   await db.update(heartbeatRuns).set({ livenessClaimedUntil: null, controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
   observe.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, resultJson: { finalResponse: "Recovered" } });
   await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
   expect(observe).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
   expect(await read(run.id)).toMatchObject({ status: "succeeded", observerEpoch: 3 });
  } finally { for (const stop of leaseStops) stop(); }
 }, 20000);
 it("harvests settled results without observe or execute", async () => {
  const run = await fixture(); probe.mockResolvedValue({ state: "settled", result: { exitCode: 0, signal: null, timedOut: false, sessionId: "harvested", resultJson: { finalResponse: "Finished" } } });
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(await read(run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "harvested", observerEpoch: 2 });
 });
 it("settles under the admitted adapter type after the agent configuration changes", async () => {
  const run=await fixture();await db.update(agents).set({adapterType:"edited_adapter",adapterConfig:{model:"edited"}}).where(eq(agents.id,run.agentId));
  probe.mockResolvedValue({state:"active"});
  observe.mockImplementationOnce(async ctx=>{expect(ctx.agent.adapterType).toBe("test_external");expect(ctx.agent.adapterConfig).toEqual({});return {exitCode:0,signal:null,timedOut:false,sessionId:"original",resultJson:{finalResponse:"Finished"}};});
  await heartbeat.sweepExternalRunLiveness();await heartbeat.drainActiveRunExecutions();
  expect(await read(run.id)).toMatchObject({status:"succeeded",sessionIdAfter:"original"});
 });
 it("keeps recorded remote handles with liveness when the current adapter cannot probe", async () => {
  const run=await fixture();const {getServerAdapter}=await import("../adapters/index.js");
  vi.mocked(getServerAdapter).mockReturnValueOnce({type:"edited_adapter",execute} as never);
  await heartbeat.reapOrphanedRuns();expect(await read(run.id)).toMatchObject({status:"running",errorCode:null});
 });
 it("delivers one outcomes-unknown recovery through the assembled heartbeat after outbox redelivery", async () => {
  const run=await fixture();
  const [task]=await db.insert(issues).values({companyId:run.companyId,title:"[test] gone recovery",status:"in_progress",assigneeAgentId:run.agentId,responsibleUserId:"board-user",executionRunId:run.id}).returning();
  await db.update(companies).set({defaultResponsibleUserId:"board-user"}).where(eq(companies.id,run.companyId));
  await db.update(heartbeatRuns).set({issueId:task.id,contextSnapshot:{issueId:task.id}}).where(eq(heartbeatRuns.id,run.id));
  probe.mockResolvedValue({state:"gone",reason:"intent session absent",authoritative:true});
  execute.mockImplementationOnce(async ctx=>{
   expect(ctx.context.recovery).toMatchObject({predecessorRunId:run.id,outcomesUnknown:true});
   expect(ctx.context.prompt).toContain("do not blindly replay");
   await db.update(issues).set({status:"done",completedAt:new Date()}).where(eq(issues.id,task.id));
   return {exitCode:0,signal:null,timedOut:false,resultJson:{finalResponse:"Verified previous effects"}};
  });
  await heartbeat.sweepExternalRunLiveness();
  await Promise.all([heartbeat.consumeExternalRunLivenessOutbox(),heartbeat.consumeExternalRunLivenessOutbox()]);
  await heartbeat.drainActiveRunExecutions();
  await db.update(runLivenessOutbox).set({status:"pending",nextAttemptAt:new Date(0)}).where(eq(runLivenessOutbox.runId,run.id));
  await heartbeat.consumeExternalRunLivenessOutbox();await heartbeat.drainActiveRunExecutions();
  const requests=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`liveness:${run.id}`));
  const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,run.agentId));
  expect(requests).toHaveLength(1);expect(runs).toHaveLength(2);expect(execute).toHaveBeenCalledOnce();
  expect(await read(run.id)).toMatchObject({status:"failed",errorCode:"external_session_gone"});
 });
 it.each(["question", "approval", "dependency"] as const)("does not bypass a pending %s during gone recovery", async kind => {
  const run=await fixture();
  const [task]=await db.insert(issues).values({companyId:run.companyId,title:"[test] held recovery",status:"in_progress",assigneeAgentId:run.agentId,responsibleUserId:"board-user",executionRunId:run.id}).returning();
  await db.update(companies).set({defaultResponsibleUserId:"board-user"}).where(eq(companies.id,run.companyId));
  await db.update(heartbeatRuns).set({issueId:task.id,contextSnapshot:{issueId:task.id}}).where(eq(heartbeatRuns.id,run.id));
  let blockerId: string | undefined;
  if(kind==="dependency") {
   const [blocker]=await db.insert(issues).values({companyId:run.companyId,title:"[test] prerequisite",status:"todo",responsibleUserId:"board-user"}).returning();
   blockerId=blocker.id;
   await db.insert(issueRelations).values({companyId:run.companyId,issueId:blocker.id,relatedIssueId:task.id,type:"blocks"});
  } else if(kind==="approval") {
   const [approval]=await db.insert(approvals).values({companyId:run.companyId,type:"test",status:"pending",payload:{}}).returning();
   await db.insert(issueApprovals).values({companyId:run.companyId,issueId:task.id,approvalId:approval.id});
  } else await db.insert(issueThreadInteractions).values({companyId:run.companyId,issueId:task.id,kind:"question",status:"pending",payload:{}} as never);
  probe.mockResolvedValue({state:"gone",authoritative:true,reason:"gone while waiting"});
  execute.mockImplementationOnce(async ctx=>{
   expect(ctx.context.recovery).toMatchObject({predecessorRunId:run.id,outcomesUnknown:true});
   await db.update(issues).set({status:"done",completedAt:new Date()}).where(eq(issues.id,task.id));
   return {exitCode:0,signal:null,timedOut:false,resultJson:{}};
  });
  await heartbeat.sweepExternalRunLiveness();await heartbeat.consumeExternalRunLivenessOutbox();await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,run.agentId))).toHaveLength(1);
  if(kind==="approval") expect((await db.select().from(approvals).where(eq(approvals.companyId,run.companyId)))[0].status).toBe("pending");
  else if(kind==="question") expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,task.id)))[0].status).toBe("pending");
  if(blockerId) expect(await db.select().from(issueRelations).where(eq(issueRelations.issueId,blockerId))).toHaveLength(1);
  const receipts=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`liveness:${run.id}`));
  expect(receipts).toHaveLength(1);expect(receipts[0].status).toBe("deferred_issue_execution");
  await db.update(runLivenessOutbox).set({status:"pending",nextAttemptAt:new Date(0)}).where(eq(runLivenessOutbox.runId,run.id));
  await Promise.all([heartbeat.consumeExternalRunLivenessOutbox(),heartbeat.consumeExternalRunLivenessOutbox()]);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`liveness:${run.id}`))).toHaveLength(1);
  await db.update(agentWakeupRequests).set({requestedAt:new Date(Date.now()-180000)}).where(eq(agentWakeupRequests.id,receipts[0].id));
  await heartbeat.resumeQueuedRuns();await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,run.agentId))).toHaveLength(1);
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,receipts[0].id)))[0].status).toBe("deferred_issue_execution");
  if(kind==="approval") await db.update(approvals).set({status:"approved"}).where(eq(approvals.companyId,run.companyId));
  else if(blockerId) await db.update(issues).set({status:"done",completedAt:new Date()}).where(eq(issues.id,blockerId));
  else await db.update(issueThreadInteractions).set({status:"resolved"}).where(eq(issueThreadInteractions.issueId,task.id));
  await db.update(agentWakeupRequests).set({requestedAt:new Date(Date.now()-180000)}).where(eq(agentWakeupRequests.id,receipts[0].id));
  await heartbeat.resumeQueuedRuns();await heartbeat.drainActiveRunExecutions();
  expect(execute).toHaveBeenCalledOnce();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,run.agentId))).toHaveLength(2);

 });
 it("does not reap remote handles as process_lost", async () => { const run = await fixture(); await heartbeat.reapOrphanedRuns(); expect(await read(run.id)).toMatchObject({ status: "running", errorCode: null }); });
});
