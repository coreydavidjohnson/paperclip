import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents, companies, createDb, heartbeatRuns, issues, issueRelations, issueThreadInteractions } from '@paperclipai/db';
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
 it('bounds blocked finishing at 30 seconds and silence at five minutes, not stop evidence',async()=>{
  const fresh=await seed(5);const finishing=await seed(45);const quiet=await seed(600,'in_progress');const thinking=await seed(60,'in_progress');
  await suspendOmnigentAdmissions(db);
  expect(await countAdmittedRunsForAgent(db,fresh.run.agentId)).toBe(1);
  expect(await countAdmittedRunsForAgent(db,finishing.run.agentId)).toBe(0);
  expect(await countAdmittedRunsForAgent(db,quiet.run.agentId)).toBe(0);
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
});
