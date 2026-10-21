import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createDb, companies,agents,issues,heartbeatRuns,agentWakeupRequests,issueThreadInteractions,issueRelations,issueRecoveryActions } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase,getEmbeddedPostgresTestSupport } from '../__tests__/helpers/embedded-postgres.js';
import { checkBoardRecovery, type BoardRecoveryDeps } from './board-recovery.js';
import { terminalizeLegacyExecution, isRetiredOmnigentObserver } from './legacy-execution-recovery.js';
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
  await db.insert(heartbeatRuns).values({id,companyId,agentId,status,runtimeMode:'legacy',updatedAt:old,startedAt:old,finishedAt:status==='running'?null:old,controllerBootId:randomUUID(),controllerLeaseExpiresAt:sql`clock_timestamp()+interval '60 seconds'`,contextSnapshot:{issueId},runnerProfileJson:{adapterDispatch:{adapterType:'omnigent'}},resultJson:{omnigentDispatchReceipt:receipt}});
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
 it.each(['active','resolved'])('keeps one no-replay hold per run across repeated watchdog passes (%s)',async status=>{
  const s=await seed('failed');
  const [action]=await db.insert(issueRecoveryActions).values({companyId:s.companyId,sourceIssueId:s.issueId,
   kind:'active_run_watchdog',status,ownerType:'board',returnOwnerAgentId:s.agentId,
   cause:'legacy_execution_requires_reconciliation',fingerprint:`legacy-execution:${s.id}`,attemptCount:1,
   evidence:{runId:s.id,...(status==='resolved'?{automaticRecovery:{replay:'blocked',actionOutcome:'unknown'}}:{})},
   nextAction:'Verify the stopped provider and outcomes before continuing.'}).returning();
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id));
  for(let i=0;i<3;i++) await terminalizeLegacyExecution({db,run,status:'failed'});
  const actions=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,s.issueId));
  expect(actions).toHaveLength(1);expect(actions[0]).toEqual(action);
 });
 it.each([false,true])('inspects a resolved hold behind a deferred wake without clearing busy work (busy: %s)',async busy=>{
  const s=await seed('failed');s.busy(busy);
  await db.update(heartbeatRuns).set({errorCode:'omnigent_session_failed'}).where(eq(heartbeatRuns.id,s.id));
  const [action]=await db.insert(issueRecoveryActions).values({companyId:s.companyId,sourceIssueId:s.issueId,
   kind:'active_run_watchdog',status:'resolved',ownerType:'board',returnOwnerAgentId:s.agentId,
   cause:'legacy_execution_requires_reconciliation',fingerprint:`legacy-execution:${s.id}`,
   evidence:{runId:s.id,automaticRecovery:{replay:'blocked',actionOutcome:'unknown'}},
   nextAction:'Verify the stopped provider and outcomes before continuing.'}).returning();
  await db.insert(agentWakeupRequests).values({companyId:s.companyId,agentId:s.agentId,source:'automation',
   reason:'execution_reconciliation_required',status:'deferred_issue_execution',payload:{issueId:s.issueId}});
  expect((await idleForTenMinutes(s)).at(-1)?.status).toBe(busy?'observe':'retry_failed');
  expect(s.methods.length).toBeGreaterThan(0);expect(s.counts()).toEqual({wakes:0,releases:0});
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,action.id)))[0]).toEqual(action);
 });
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
 it('preserves a recent running observer despite a stable idle newest session',async()=>{
  const s=await seed();
  await db.update(heartbeatRuns).set({updatedAt:new Date(s.now)}).where(eq(heartbeatRuns.id,s.id));
  expect((await idleForTenMinutes(s)).map(r=>r.status)).toEqual(['observe','observe','observe']);
  expect(s.counts()).toEqual({wakes:0,releases:0});
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id)))[0].status).toBe('running');
 });
 it('releases the slot for a fifteen-hour idle observer, not just the saved session pointer',async()=>{
  const s=await seed();
  await db.update(heartbeatRuns).set({updatedAt:new Date(s.now-15*3600000)}).where(eq(heartbeatRuns.id,s.id));
  expect((await idleForTenMinutes(s)).at(-1)?.status).toBe('observer_retired');
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id));
  expect(run.resultJson?.omnigentObserverRetirement).toMatchObject({currentSessionId:'new',runStaleLimitMs:1200000,providerStopped:false});
  expect(s.counts()).toEqual({wakes:1,releases:1});
 });
 it('handles PostgreSQL sub-millisecond source timestamps without a false CAS mismatch',async()=>{
  const s=await seed();
  await db.update(heartbeatRuns).set({updatedAt:sql`date_trunc('milliseconds', clock_timestamp()) - interval '2 hours' + interval '123 microseconds'`}).where(eq(heartbeatRuns.id,s.id));
  expect((await idleForTenMinutes(s)).at(-1)?.status).toBe('observer_retired');
  expect(s.counts()).toEqual({wakes:1,releases:1});
 });
 it('does not retire a run refreshed during native wake admission',async()=>{
  const s=await seed(); const wake=s.deps.wake;
  s.deps.wake=async(...args)=>{
   const result=await wake(...args);
   await db.update(heartbeatRuns).set({updatedAt:new Date(s.now+600000)}).where(eq(heartbeatRuns.id,s.id));
   return result;
  };
  expect((await idleForTenMinutes(s)).at(-1)?.status).toBe('held');
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,s.id));
  expect(run.status).toBe('running');expect(run.resultJson?.omnigentObserverRetirement).toBeUndefined();
  expect(s.counts()).toEqual({wakes:1,releases:0});
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
