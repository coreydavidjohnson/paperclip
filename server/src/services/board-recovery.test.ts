import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createDb, companies,agents,issues,heartbeatRuns,agentWakeupRequests,issueThreadInteractions,issueRelations,issueRecoveryActions } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase,getEmbeddedPostgresTestSupport } from '../__tests__/helpers/embedded-postgres.js';
import { checkBoardRecovery, type BoardRecoveryDeps } from './board-recovery.js';
import { isRetiredOmnigentObserver } from './legacy-execution-recovery.js';
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)('native board recovery fences',()=>{
 let temporary:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 beforeAll(async()=>{temporary=await startEmbeddedPostgresTestDatabase('board-recovery-');db=createDb(temporary.connectionString);},60000);
 afterAll(async()=>{await db?.$client.end({timeout:0});await temporary?.cleanup();});
 async function seed(status='running') {
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),id=randomUUID();
  const now=Date.now(),old=new Date(now-7200000);
  await db.insert(companies).values({id:companyId,name:'Board sweep',issuePrefix:'B'+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:'Worker',adapterType:'omnigent',adapterConfig:{baseUrl:'http://provider',agentId:'provider'}});
  await db.insert(issues).values({id:issueId,companyId,title:'Task',status:'in_progress',assigneeAgentId:agentId});
  const receipt={version:1,runId:id,companyId,agentId,omnigentSessionId:'old',state:'observed'};
  await db.insert(heartbeatRuns).values({id,companyId,agentId,status,runtimeMode:'legacy',startedAt:old,finishedAt:status==='running'?null:old,controllerBootId:randomUUID(),controllerLeaseExpiresAt:sql`clock_timestamp()+interval '60 seconds'`,contextSnapshot:{issueId},runnerProfileJson:{adapterDispatch:{adapterType:'omnigent'}},resultJson:{omnigentDispatchReceipt:receipt}});
  if(status==='running') await db.update(issues).set({executionRunId:id,checkoutRunId:id}).where(eq(issues.id,issueId));
  const labels={'paperclip.company_id':companyId,'paperclip.agent_id':agentId,'paperclip.issue_key':`${companyId}:${agentId}:issue:${issueId}`};
  let busy=false,wakes=0,releases=0;
  const methods:string[]=[];
  const session={id:'new',agent_id:'provider',status:'idle',labels};
  const deps:BoardRecoveryDeps={now,resumeSuccessful:async()=> 'queued',resolveConfig:async(_,config)=>config,
   request:async(url,init)=>{methods.push(init?.method ?? 'GET');const path=new URL(String(url)).pathname;return Response.json(path==='/v1/sessions'?{data:[{...session,status:busy?'running':'idle'}],has_more:false}:path.endsWith('/items')?{data:[{id:'tail',type:'message',role:'assistant'}]}:{...session,status:busy?'running':'idle'});},
   wake:async()=>{wakes++;await db.insert(agentWakeupRequests).values({companyId,agentId,source:'automation',reason:'paperclip_board_reconcile',status:'deferred_issue_execution',idempotencyKey:`board-recovery:${issueId}:${id}`,payload:{issueId}});},release:async()=>{releases++;}};
  return {companyId,agentId,issueId,id,now,receipt,deps,methods,busy:(value:boolean)=>{busy=value;},counts:()=>({wakes,releases})};
 }
 async function idleForTenMinutes(s:Awaited<ReturnType<typeof seed>>) {
  const results=[];
  for(const elapsed of [0,300000,600000]) results.push(await checkBoardRecovery(db,s.issueId,{...s.deps,now:s.now+elapsed}));
  return results;
 }
 it('never retires a silent run while its newest ticket session is busy',async()=>{
  const s=await seed();s.busy(true);await idleForTenMinutes(s);
  expect(s.counts()).toEqual({wakes:0,releases:0});
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id)))[0].status).toBe('running');
 });
 it('retires only the observer after repeated stable idle and native deferred admission',async()=>{
  const s=await seed();const results=await idleForTenMinutes(s);
  expect(results.map(r=>r.status)).toEqual(['observe','observe','observer_retired']);
  const [saved]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id));
  expect(saved.resultJson?.omnigentDispatchReceipt).toEqual(s.receipt);
  expect(isRetiredOmnigentObserver(saved)).toBe(true);
  expect(saved.resultJson?.omnigentObserverRetirement).toMatchObject({currentSessionId:'new',providerStopped:false,actionOutcomes:'unknown'});
  expect(s.counts()).toEqual({wakes:1,releases:1});expect(new Set(s.methods)).toEqual(new Set(['GET']));
 });
 it('holds a live orphan until it finishes, then asks for a native monitor',async()=>{
  const s=await seed('succeeded');s.busy(true);expect((await idleForTenMinutes(s)).at(-1)?.status).toBe('observe');
  s.busy(false);for(const elapsed of [900000,1200000,1500000]) await checkBoardRecovery(db,s.issueId,{...s.deps,now:s.now+elapsed});
  const result=await checkBoardRecovery(db,s.issueId,{...s.deps,now:s.now+1501000});
  expect(result.status).toBe('native_continuation_queued');expect(s.counts()).toEqual({wakes:0,releases:0});
 });
 it('does not consume idle observation time across a failed probe or a long gap',async()=>{
  const s=await seed();await checkBoardRecovery(db,s.issueId,s.deps);
  expect((await checkBoardRecovery(db,s.issueId,{...s.deps,now:s.now+600000})).status).toBe('observe');
  expect(s.counts()).toEqual({wakes:0,releases:0});
 });
 it('preserves a pending approval and unresolved first-class dependency',async()=>{
  const s=await seed();await db.insert(issueThreadInteractions).values({companyId:s.companyId,issueId:s.issueId,kind:'request_confirmation',status:'pending',payload:{kind:'request_confirmation',title:'Approval',message:'Allow the test?',confirmLabel:'Allow',cancelLabel:'Do not allow'} as never});
  const [blocker]=await db.insert(issues).values({companyId:s.companyId,title:'Required',status:'todo'}).returning();
  await db.insert(issueRelations).values({companyId:s.companyId,issueId:blocker.id,relatedIssueId:s.issueId,type:'blocks'});
  expect((await idleForTenMinutes(s)).every(r=>r.status==='held')).toBe(true);expect(s.methods).toHaveLength(0);
 });
 it('dry-run creates no observations, attempts, wakeups or provider mutations',async()=>{
  const s=await seed();await checkBoardRecovery(db,s.issueId,{...s.deps,dryRun:true});
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id));
  expect(run.resultJson?.boardRecovery).toBeUndefined();expect(s.counts()).toEqual({wakes:0,releases:0});
 });
 it('shares a per-ticket retry cap across source runs and records a board-owned reason',async()=>{
  const s=await seed('succeeded');
  for(let index=0;index<3;index++) await db.insert(heartbeatRuns).values({companyId:s.companyId,agentId:s.agentId,status:'failed',runtimeMode:'legacy',
    createdAt:new Date(s.now-7200000-index),contextSnapshot:{issueId:s.issueId},resultJson:{boardRecovery:{attemptAt:s.now-1800000-index}}});
  const results=await idleForTenMinutes(s);
  expect(results.at(-1)?.status).toBe('exhausted');
  const [issue]=await db.select().from(issues).where(eq(issues.id,s.issueId));
  const [action]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,s.issueId));
  expect(issue.status).toBe('blocked');expect(action.ownerType).toBe('board');
  expect(action.nextAction).toContain('3 attempts');expect(action.evidence.recoveryBudget).toMatchObject({state:'exhausted'});
  expect(s.counts()).toEqual({wakes:0,releases:0});
 });

});
