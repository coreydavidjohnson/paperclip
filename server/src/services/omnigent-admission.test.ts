import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@paperclipai/db';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents, companies, createDb, heartbeatRuns, agentWakeupRequests, issues, issueRelations, issueThreadInteractions } from '@paperclipai/db';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from '../__tests__/helpers/embedded-postgres.js';
import { admitAgentRun, countAdmittedRunsForAgent, suspendOmnigentAdmissions } from './run-admission.js';
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('bounded owned admission', () => {
 let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase('omnigent-admission-'); db = createDb(temporary.connectionString); }, 60000);
 afterAll(async () => { await db?.$client.end({timeout:0}); await temporary?.cleanup(); });
 async function seed(ageSeconds = 600, status = 'blocked', state = 'intent') {
  const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), id=randomUUID();
  const old = new Date(Date.now()-ageSeconds*1000);
  await db.insert(companies).values({id:companyId,name:'Admission',issuePrefix:'A'+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:'Observer',role:'general',adapterType:'omnigent'});
  await db.insert(issues).values({id:issueId,companyId,title:'Waiting',status,assigneeAgentId:agentId,updatedAt:old});
  const receipt={version:1,runId:id,companyId,agentId,omnigentSessionId:'session-'+id,state};
  const [run]=await db.insert(heartbeatRuns).values({id,companyId,agentId,status:'running',startedAt:old,lastOutputAt:old,runtimeMode:'legacy',executionStage:'awaiting_external_evidence',controllerBootId:randomUUID(),controllerLeaseExpiresAt:sql`clock_timestamp() + interval '60 seconds'`,runnerProfileJson:{adapterDispatch:{adapterType:'omnigent'}},contextSnapshot:{issueId},resultJson:{omnigentDispatchReceipt:receipt}}).returning();
  await db.update(issues).set({executionRunId:id,checkoutRunId:id}).where(eq(issues.id,issueId));
  return {run,issueId,receipt};
 }
 it.each(['intent','accepted','observed'])('suspends ambiguous %s without finalizing or changing receipt',async state=>{
  const {run,issueId,receipt}=await seed(600,'blocked',state);
  const [blocker]=await db.insert(issues).values({companyId:run.companyId,title:'Real prerequisite',status:'todo'}).returning();
  await db.insert(issueRelations).values({companyId:run.companyId,issueId:blocker.id,relatedIssueId:issueId,type:'blocks'});
  await db.insert(issueThreadInteractions).values({companyId:run.companyId,issueId,kind:'request_confirmation',payload:{kind:'request_confirmation',title:'Approval',message:'Approve?',confirmLabel:'Yes',cancelLabel:'No'} as never,status:'pending'});
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(1);
  expect((await suspendOmnigentAdmissions(db)).some(row=>row.id===run.id)).toBe(true);
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(0);
  const [saved]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(saved.status).toBe('running');expect(saved.finishedAt).toBeNull();
  expect(saved.resultJson?.omnigentDispatchReceipt).toEqual(receipt);
  expect(saved.runnerProfileJson?.omnigentAdmissionSuspension).toMatchObject({version:1,runId:run.id,companyId:run.companyId,agentId:run.agentId,issueId,omnigentSessionId:receipt.omnigentSessionId});
  const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
  expect(issue.status).toBe('blocked');expect(issue.executionRunId).toBe(run.id);expect(issue.checkoutRunId).toBe(run.id);
  expect((await suspendOmnigentAdmissions(db)).some(row=>row.id===run.id)).toBe(false);
  expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId,issueId))).toHaveLength(1);
  expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,issueId)))[0].status).toBe('pending');
 });
 it('fences same issue across agents even if locks cleared, while admitting unrelated work',async()=>{
  const {run,issueId}=await seed();await suspendOmnigentAdmissions(db);
  await db.update(issues).set({executionRunId:null,checkoutRunId:null,status:'todo'}).where(eq(issues.id,issueId));
  const claim={id:randomUUID(),issueId};
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,claim))).toBe(false);
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,{id:randomUUID(),issueId:randomUUID()}))).toBe(true);
  const otherAgent=randomUUID();await db.insert(agents).values({id:otherAgent,companyId:run.companyId,name:'Reviewer',role:'general'});
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,otherAgent,1,claim))).toBe(false);
 });
 it('bounds blocked finishing but requires negative evidence for silent active work',async()=>{
  const fresh=await seed(5);const finishing=await seed(45);const quiet=await seed(600,'in_progress');const thinking=await seed(60,'in_progress');
  await suspendOmnigentAdmissions(db);
  expect(await countAdmittedRunsForAgent(db,fresh.run.agentId)).toBe(1);
  expect(await countAdmittedRunsForAgent(db,finishing.run.agentId)).toBe(0);
  expect(await countAdmittedRunsForAgent(db,quiet.run.agentId)).toBe(1);
  expect(await countAdmittedRunsForAgent(db,thinking.run.agentId)).toBe(1);
 });
 it('bounds blocked finishing even while the provider still emits output',async()=>{
  const {run}=await seed(600);
  await db.update(heartbeatRuns).set({lastOutputAt:new Date()}).where(eq(heartbeatRuns.id,run.id));
  await suspendOmnigentAdmissions(db);
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(0);
 });
 it('keeps ownership when a late accepted acknowledgement follows ambiguous intent',async()=>{
  const {run,receipt}=await seed();await suspendOmnigentAdmissions(db);
  await db.update(heartbeatRuns).set({resultJson:{omnigentDispatchReceipt:{...receipt,state:'accepted',userItemId:'already-sent'}}}).where(eq(heartbeatRuns.id,run.id));
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(0);
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,{id:randomUUID(),issueId:run.contextSnapshot!.issueId as string}))).toBe(false);
 });
 it('retains unknown accepted work and its issue fence when an external summary says idle without a runner',async()=>{
  const {run,issueId,receipt}=await seed(600,'blocked','accepted');
  // A summary is not a terminal observation tied to this response/turn.
  await db.update(heartbeatRuns).set({resultJson:{omnigentDispatchReceipt:receipt,externalSummary:{status:'idle',runner_online:false}}}).where(eq(heartbeatRuns.id,run.id));
  await suspendOmnigentAdmissions(db);
  const [saved]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(saved.status).toBe('running');expect(saved.finishedAt).toBeNull();
  expect(saved.resultJson?.omnigentDispatchReceipt).toEqual(receipt);
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(0);
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,{id:randomUUID(),issueId}))).toBe(false);
 });
 it('fails closed if receipt binding changes',async()=>{
  const {run,receipt}=await seed();await suspendOmnigentAdmissions(db);
  await db.update(heartbeatRuns).set({resultJson:{omnigentDispatchReceipt:{...receipt,omnigentSessionId:'replacement'}}}).where(eq(heartbeatRuns.id,run.id));
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(1);
 });
 it('serializes capacity claims across controllers in the same transaction',async()=>{
  const {run}=await seed();await suspendOmnigentAdmissions(db);
  const claim=()=>db.transaction(async tx=>{
    const id=randomUUID();
    if(!await admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,{id,issueId:null}))return false;
    await tx.insert(heartbeatRuns).values({id,companyId:run.companyId,agentId:run.agentId,status:'running'});
    return true;
  });
  expect((await Promise.all([claim(),claim()])).filter(Boolean)).toHaveLength(1);
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(1);
 });
 it('serializes concurrent same-issue claims from different agents even without issue locks',async()=>{
  const {run,issueId}=await seed();
  await db.update(heartbeatRuns).set({status:'succeeded'}).where(eq(heartbeatRuns.id,run.id));
  const other=randomUUID();await db.insert(agents).values({id:other,companyId:run.companyId,name:'Review',role:'general'});
  const claim=(agentId:string)=>db.transaction(async tx=>{
    const id=randomUUID();
    if(!await admitAgentRun(tx as unknown as typeof db,run.companyId,agentId,1,{id,issueId}))return false;
    await tx.execute(sql`select pg_sleep(0.1)`);
    await tx.insert(heartbeatRuns).values({id,companyId:run.companyId,agentId,status:'running',contextSnapshot:{issueId}});
    return true;
  });
  expect((await Promise.all([claim(run.agentId),claim(other)])).filter(Boolean)).toHaveLength(1);
 });
 it.each(['missing','wrong-session','wrong-run','wrong-company','wrong-agent','native','unbound','stopped'])('fails closed for %s',async kind=>{
  const {run,issueId,receipt}=await seed();
  if(kind==='unbound') await db.update(issues).set({assigneeAgentId:null}).where(eq(issues.id,issueId));
  else if(kind==='native') await db.update(heartbeatRuns).set({runtimeMode:'native'}).where(eq(heartbeatRuns.id,run.id));
  else if(kind==='stopped') await db.update(heartbeatRuns).set({status:'cancelled'}).where(eq(heartbeatRuns.id,run.id));
  else await db.update(heartbeatRuns).set({resultJson:{omnigentDispatchReceipt:kind==='missing'?null:{...receipt,...(kind==='wrong-session'?{omnigentSessionId:''}:kind==='wrong-run'?{runId:randomUUID()}:kind==='wrong-company'?{companyId:randomUUID()}:{agentId:randomUUID()})}}}).where(eq(heartbeatRuns.id,run.id));
  expect((await suspendOmnigentAdmissions(db)).some(row=>row.id===run.id)).toBe(false);
 });
 it.each(['scalar-profile','scalar-result','json-null-profile','json-null-context','wrong-version','wrong-state','wrong-adapter','wrong-stage','cancelled-issue'])('keeps malformed or ineligible %s admitted',async kind=>{
  const {run,issueId,receipt}=await seed();
  if(kind==='cancelled-issue') await db.update(issues).set({status:'cancelled'}).where(eq(issues.id,issueId));
  else if(kind==='wrong-stage') await db.update(heartbeatRuns).set({executionStage:'queued'}).where(eq(heartbeatRuns.id,run.id));
  else if(kind==='wrong-adapter') await db.update(heartbeatRuns).set({runnerProfileJson:{adapterDispatch:{adapterType:'other'}}}).where(eq(heartbeatRuns.id,run.id));
  else if(kind==='wrong-version'||kind==='wrong-state') await db.update(heartbeatRuns).set({resultJson:{omnigentDispatchReceipt:{...receipt,...(kind==='wrong-version'?{version:2}:{state:'unknown'})}}}).where(eq(heartbeatRuns.id,run.id));
  else if(kind==='scalar-profile') await db.execute(sql`update heartbeat_runs set runner_profile_json = 'true'::jsonb where id = ${run.id}`);
  else if(kind==='scalar-result') await db.execute(sql`update heartbeat_runs set result_json = '42'::jsonb where id = ${run.id}`);
  else if(kind==='json-null-profile') await db.execute(sql`update heartbeat_runs set runner_profile_json = 'null'::jsonb where id = ${run.id}`);
  else await db.execute(sql`update heartbeat_runs set context_snapshot = 'null'::jsonb where id = ${run.id}`);
  expect((await suspendOmnigentAdmissions(db)).some(row=>row.id===run.id)).toBe(false);
 });
 it.each(['not_found','runner_offline'])('releases two-hour silent %s with exact fence',async reason=>{
  const {run,receipt,issueId}=await seed(7500,'in_progress');
  const probe=async()=>reason as 'not_found'|'runner_offline';
  expect((await suspendOmnigentAdmissions(db,probe)).some(r=>r.id===run.id)).toBe(true);
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(0);
  const [saved]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(saved.status).toBe('running');expect(saved.resultJson?.omnigentDispatchReceipt).toEqual(receipt);
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,{id:randomUUID(),issueId}))).toBe(false);
 });
 it('keeps unknown quiet work admitted without a negative probe',async()=>{
  const {run}=await seed(7500,'in_progress');
  await suspendOmnigentAdmissions(db,async()=>null);
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(1);
 });
 it('rejects stale evidence when output advances during the probe',async()=>{
  const {run}=await seed(7500,'in_progress');
  await suspendOmnigentAdmissions(db,async candidate=>{
   if(candidate.id===run.id)await db.update(heartbeatRuns).set({lastOutputAt:new Date()}).where(eq(heartbeatRuns.id,run.id));
   return 'runner_offline';
  });
  expect(await countAdmittedRunsForAgent(db,run.agentId)).toBe(1);
 });
 it('retires an offline suspended observer for a queued wake without claiming earlier actions succeeded',async()=>{
  const {run,issueId,receipt}=await seed(7500,'todo');
  await suspendOmnigentAdmissions(db,async()=> 'runner_offline');
  await db.insert(agentWakeupRequests).values({companyId:run.companyId,agentId:run.agentId,source:'on_demand',reason:'issue_commented',status:'queued',payload:{issueId}});
  const {retireSuspendedOmnigentObservers}=await import('./run-admission.js');
  const retired=await retireSuspendedOmnigentObservers(db,async()=> 'runner_offline');
  expect(retired.some(r=>r.id===run.id)).toBe(true);
  const [saved]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(saved.status).toBe('interrupted');expect(saved.finishedAt).not.toBeNull();
  expect(saved.resultJson?.omnigentDispatchReceipt).toEqual(receipt);
  expect(saved.resultJson?.omnigentObserverRetirement).toMatchObject({actionOutcomes:'unknown',providerStopped:false,issueId});
  const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
  expect(issue.status).toBe('todo');
  expect(await retireSuspendedOmnigentObservers(db,async()=> 'runner_offline')).not.toContainEqual(expect.objectContaining({id:run.id}));
 });
 it.each(['online','unknown','fresh-output','no-wake','changed-receipt'])('keeps suspended ownership for %s',async kind=>{
  const {run,issueId,receipt}=await seed(7500,'todo');
  await suspendOmnigentAdmissions(db,async()=> 'runner_offline');
  if(kind!=='no-wake')await db.insert(agentWakeupRequests).values({companyId:run.companyId,agentId:run.agentId,source:'on_demand',status:'queued',payload:{issueId}});
  if(kind==='changed-receipt')await db.update(heartbeatRuns).set({resultJson:{omnigentDispatchReceipt:{...receipt,omnigentSessionId:'other'}}}).where(eq(heartbeatRuns.id,run.id));
  const {retireSuspendedOmnigentObservers}=await import('./run-admission.js');
  await retireSuspendedOmnigentObservers(db,async candidate=>{if(kind==='fresh-output'&&candidate.id===run.id)await db.update(heartbeatRuns).set({lastOutputAt:new Date()}).where(eq(heartbeatRuns.id,run.id));return kind==='online'||kind==='unknown'?null:'runner_offline';});
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id)))[0].status).toBe('running');
 });
 it('promotes a deferred assignment through the real release transaction after observer retirement', async()=>{
  const {run,issueId,receipt}=await seed(7500,'todo');
  await suspendOmnigentAdmissions(db,async()=> 'runner_offline');
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:run.companyId,agentId:run.agentId,source:'assignment',reason:'issue_execution_deferred',status:'deferred_issue_execution',payload:{issueId,_paperclipWakeContext:{issueId,wakeReason:'issue_assigned'}}}).returning();
  const {retireSuspendedOmnigentObservers}=await import('./run-admission.js');
  expect((await retireSuspendedOmnigentObservers(db,async()=> 'runner_offline')).some(r=>r.id===run.id)).toBe(true);
  const {createPostgresWakeQueueAdapter}=await import('../modules/wake-queue/adapters/postgres.js');
  const {createReleaseIssueExecution}=await import('../modules/wake-queue/application/use-cases.js');
  const release=createReleaseIssueExecution({issueLock:createPostgresWakeQueueAdapter(db,{resolveResponsibleUserId:async()=> 'fixture-owner',getRoutineEnv:async()=>({routineId:null,env:null,responsibleUserId:null}),resolveSessionBeforeForWakeup:async()=> null}),recovery:{escalateStrandedAssignedIssue:async()=>{},escalateStrandedRecoveryIssueInPlace:async()=>{}}});
  const result=await release({companyId:run.companyId,runId:run.id,now:new Date(),suppressImmediateRecovery:true});
  expect(result.outcome.kind).toBe('promoted');
  const [promoted]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id));
  expect(promoted.runId).not.toBeNull();
  const [next]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,promoted.runId!));
  expect(next.status).toBe('queued');
  expect(await db.transaction(tx=>admitAgentRun(tx as unknown as typeof db,run.companyId,run.agentId,1,{id:next.id,issueId}))).toBe(true);
  const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
  expect(issue.checkoutRunId).toBeNull();expect(issue.executionRunId).toBe(next.id);
  const [saved]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(saved.resultJson?.omnigentDispatchReceipt).toEqual(receipt);
  await release({companyId:run.companyId,runId:run.id,now:new Date(),suppressImmediateRecovery:true});
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,run.companyId))).toHaveLength(2);
}, 60000);
});

it('materializes bounded observer properties before evaluating repeated receipt predicates', async () => {
  let query = '';
  const db = { select: () => ({ from: () => ({ where: (condition: SQL) => {
    query = new PgDialect().sqlToQuery(condition).sql;
    return Promise.resolve([]);
  } }) }) } as unknown as Db;
  expect(await suspendOmnigentAdmissions(db)).toEqual([]);
  expect(query).toContain('as materialized');
  const materialized = query.split('as materialized')[1].split('select id from')[0];
  expect(materialized).toContain("status = 'running'");
  expect(materialized).toContain("runtime_mode = 'legacy'");
  expect(materialized).toContain("execution_stage in ('dispatching', 'external_attached', 'awaiting_external_evidence')");
  expect(query.match(/result_json\s*->\s*'omnigentDispatchReceipt'/g)).toHaveLength(1);
  expect(query.match(/context_snapshot\s*->>\s*'issueId'/g)).toHaveLength(1);
  for (const key of ['version', 'runId', 'companyId', 'agentId', 'state', 'omnigentSessionId']) {
    expect(query).toContain(`receipt->>'${key}'`);
  }
});
