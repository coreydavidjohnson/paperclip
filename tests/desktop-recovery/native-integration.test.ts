import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { eq, sql } from 'drizzle-orm';
import { agents, companies, issues, activityLog, createDb, startEmbeddedPostgresTestDatabase } from '@paperclipai/db';
import { issueService } from '../../server/src/services/issues.js';
import { desktopRecoveryService } from '../../server/src/services/desktop-recovery.js';
import { desktopRecoveryRoutes, desktopRecoveryCredentialBoundary } from '../../server/src/routes/desktop-recovery.js';

// Intentionally no test hooks: real native services, migrations, PostgreSQL,
// Express, receipt and scheduler wiring. Run in a unique disposable CI pod.
test('native isolated API commits a real issue transition and receipt exactly once', { timeout: 120000 }, async () => {
  process.env.PAPERCLIP_IN_WORKTREE = 'true'; // no adapter or external run execution
  const temp = await startEmbeddedPostgresTestDatabase('per591-native-');
  const db = createDb(temp.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), incidentIssueId = randomUUID(), issueId = randomUUID();
  const token = 'isolated-per591-native-token-not-production';
  let server: ReturnType<typeof express.application.listen> | undefined;
  try {
    await db.insert(companies).values({id:companyId,name:'isolated desktop API',issuePrefix:'ISO',defaultResponsibleUserId:'isolated-board'});
    await db.insert(agents).values({id:agentId,companyId,name:'isolated desktop API',status:'idle',adapterType:'process'});
    await db.insert(issues).values([{id:incidentIssueId,companyId,title:'isolated incident target',status:'todo'},
      {id:issueId,companyId,title:'isolated broader work',status:'todo',assigneeAgentId:agentId}]);
    const updated = await issueService(db).update(issueId,{status:'blocked',unblockDescriptor:{owner:{agentId},action:'Restore desktop command access.'}});
    assert.ok(updated);
    await db.insert(activityLog).values({companyId,actorType:'system',actorId:'isolated',action:'issue.updated',entityType:'issue',entityId:issueId,details:{changes:updated.changes}});
    const target = {companyId,agentId,incidentIssueId,namespace:'opensandbox',desktop:'desktop-isolated',restoreOnlyIssueIds:[] as string[]};
    const native = desktopRecoveryService(db);
    const app=express();app.use(express.json());app.use(desktopRecoveryCredentialBoundary);
    app.use(desktopRecoveryRoutes({token,targets:{isolated:target},resumeEnabled:true,handle:native}));
    app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message}));
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
    const port=(server.address() as {port:number}).port;
    const body={version:1,agent:'isolated',desktop:target.desktop,incidents:[{id:'event-native-1',reason:'DesktopRecoverySucceeded',time:Date.now()/1000,involvedObject:{apiVersion:'sandbox.opensandbox.io/v1alpha1',kind:'BatchSandbox',namespace:target.namespace,name:target.desktop,uid:randomUUID()}}],ready:{observedAt:Date.now()/1000,recoveryId:'startup:owned',batch:{namespace:target.namespace,name:target.desktop,uid:randomUUID(),generation:1,observedGeneration:1},podUid:randomUUID()}};
    const post=(value=body,headers:Record<string,string>={})=>fetch(`http://127.0.0.1:${port}/api/internal/desktop-recovery`,{method:'POST',headers:{'Content-Type':'application/json','X-Desktop-Recovery-Token':token,...headers},body:JSON.stringify(value)});
    // Only override the scheduler's worktree suppression for the mutation test;
    // the isolated agent is paused for execution through its runtime config.
    process.env.PAPERCLIP_IN_WORKTREE='false';
    await db.update(agents).set({runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false}}}).where(eq(agents.id,agentId));
    const rejected=await post(body,{'X-Desktop-Recovery-Token':'wrong'});assert.equal(rejected.status,401);
    const concurrent=await Promise.all([post(),post()]);
    const response=concurrent[0];const result:any=await response.json();
    assert.equal(concurrent[1].status,200);assert.deepEqual((await concurrent[1].json()).resumes,result.resumes);
    assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.notifications.length,1);assert.equal(result.resumes.length,1);
    const repeat=await post();assert.equal(repeat.status,200);assert.deepEqual((await repeat.json()).resumes,result.resumes);
    const [readback]=await db.select().from(issues).where(eq(issues.id,issueId));assert.equal(readback.status,'todo');
    const receipts=await db.execute(sql`select id from activity_log where company_id=${companyId} and action='desktop_recovery.resume_receipt'`);
    assert.equal(receipts.length,1);
    console.log('NATIVE_API_RECEIPTS',JSON.stringify(result));
    // New eligible transitions are admitted on a new verified observation, not an old payload.
    const laterId=randomUUID(),heldId=randomUUID(),restoreId=randomUUID();
    await db.insert(issues).values([
      {id:laterId,companyId,title:'new eligible work',status:'todo',assigneeAgentId:agentId},
      {id:heldId,companyId,title:'pending user input',status:'todo',assigneeAgentId:agentId},
      {id:restoreId,companyId,title:'explicit restore child',parentId:incidentIssueId,status:'todo',assigneeAgentId:agentId},
    ]);
    for(const id of [laterId,heldId,restoreId]) {
      const change=await issueService(db).update(id,{status:'blocked',unblockDescriptor:{owner:{agentId},action:'Restore desktop command access.'}});
      await db.insert(activityLog).values({companyId,actorType:'system',actorId:'isolated',action:'issue.updated',entityType:'issue',entityId:id,details:{changes:change!.changes}});
    }
    await db.execute(sql`insert into issue_thread_interactions(company_id,issue_id,kind,payload) values(${companyId},${heldId},'ask_user_questions','{}')`);
    const stale=await post();assert.deepEqual((await stale.json()).resumes,result.resumes);
    const refreshed={...body,ready:{...body.ready,observedAt:Date.now()/1000}};
    target.restoreOnlyIssueIds.push(restoreId);
    const fresh=await post(refreshed);const freshResult:any=await fresh.json();assert.equal(fresh.status,200,JSON.stringify(freshResult));
    assert.equal(freshResult.resumes.length,3);
    assert.equal((await db.select().from(issues).where(eq(issues.id,laterId)))[0].status,'todo');
    assert.equal((await db.select().from(issues).where(eq(issues.id,heldId)))[0].status,'blocked');
    assert.equal((await db.select().from(issues).where(eq(issues.id,restoreId)))[0].status,'done');
    const wakes=await db.execute(sql`select id from agent_wakeup_requests where company_id=${companyId} and reason='issue_children_completed'`);
    // Parent is deliberately unassigned; native closure must not invent an assignee.
    assert.equal(wakes.length,0);
    const changed=await post({...refreshed,ready:{...refreshed.ready,podUid:randomUUID()}});assert.equal(changed.status,409);
    const finalReceipts=await db.execute(sql`select id from activity_log where company_id=${companyId} and action='desktop_recovery.resume_receipt'`);assert.equal(finalReceipts.length,3);
    console.log('NATIVE_RACE_NEGATIVE_CATCHUP_CLOSURE_OK',JSON.stringify(freshResult));
  } finally {
    process.env.PAPERCLIP_IN_WORKTREE='true';
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await temp.cleanup();
    console.log('NATIVE_ISOLATED_DATABASE_CLEANED');
  }
});
