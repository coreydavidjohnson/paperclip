import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';

const companyId = randomUUID(), agentId = randomUUID(), incidentIssueId = randomUUID();
const target = { companyId, agentId, incidentIssueId, namespace: 'opensandbox', desktop: 'desktop-home-lab' };
const request = { version: 1 as const, agent: 'home_lab', desktop: target.desktop, incidents: [], ready: { get observedAt(){ return Date.now()/1000; }, recoveryId: 'recovery-1', batch: { namespace: target.namespace, name: target.desktop, uid: randomUUID(), generation: 2, observedGeneration: 2 }, podUid: randomUUID() } };

async function setup() {
  const module = await import('../../server/src/services/desktop-recovery.js').catch(() => null);
  assert.ok(module?.desktopRecoveryService, 'desktop recovery must use a durable database transaction');
  const pg = new PGlite();
  const snapshot = JSON.parse(await readFile(new URL('../../packages/db/src/migrations/meta/0293_snapshot.json', import.meta.url), 'utf8'));
  // Real current column names/types/defaults, without unrelated extension indexes.
  for (const name of ['companies','agents','issues','activity_log','issue_comments','agent_wakeup_requests','heartbeat_runs','issue_thread_interactions','issue_approvals','approvals','issue_relations','issue_recovery_actions','issue_tree_holds','issue_tree_hold_members','tool_action_requests','workspace_operations','native_run_finalizations']) {
    const table = snapshot.tables[`public.${name}`];
    const columns = Object.values(table.columns).map((column: any) => `"${column.name}" ${column.type}${column.notNull ? ' NOT NULL' : ''}${column.default === undefined ? '' : ` DEFAULT ${column.default}`}`);
    await pg.exec(`CREATE TABLE "${name}" (${columns.join(',')})`);
  }
  const db = drizzle(pg);
  await db.execute(sql`insert into companies(id,name,status) values(${companyId},'isolated desktop recovery test','active')`);
  await db.execute(sql`insert into agents(id,company_id,name,status) values(${agentId},${companyId},'isolated-test','idle')`);
  await db.execute(sql`insert into issues(id,company_id,title,status) values(${incidentIssueId},${companyId},'isolated incident target','todo')`);
  const calls: string[] = [];
  const handler = module.desktopRecoveryService(db, {
    // This is a DB orchestration test, not proof of native issueService effects.
    updateIssue: async (tx: any, id: string, data: any) => {
      calls.push(id);
      await tx.execute(sql`update issues set status=${data.status}, status_version=41, unblock_descriptor=null, blocked_transition_at=null where id=${id} and company_id=${data.companyGuard}`);
      return { id, statusVersion: 41, changes: { status: { from: 'blocked', to: data.status } } };
    },
    addComment: async (tx: any, id: string, text: string) => {
      const commentId = randomUUID();
      await tx.execute(sql`insert into issue_comments(id,company_id,issue_id,body,author_type) values(${commentId},${companyId},${id},${text},'system')`);
      return { id: commentId };
    },
    afterCommit: async () => {}, isSuppressed: () => false,
  });
  async function blocked(action = 'Restore desktop command access.', at = new Date()) {
    const id = randomUUID(), auditId = randomUUID();
    const stamp = new Date(at.getTime() - 1000);
    await db.execute(sql`insert into issues(id,company_id,title,status,assignee_agent_id,blocked_transition_at,unblock_descriptor) values(${id},${companyId},'isolated blocked task','blocked',${agentId},${stamp.toISOString()},${JSON.stringify({ owner: { agentId }, action })}::jsonb)`);
    await db.execute(sql`insert into activity_log(id,company_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at) values(${auditId},${companyId},'system','isolated-test','issue.updated','issue',${id},${JSON.stringify({ changes: { status: { from: 'todo', to: 'blocked' }, blockedTransitionAt: { from: null, to: stamp.toISOString() } } })}::jsonb,${stamp.toISOString()})`);
    return id;
  }
  return { pg, db, calls, handler, blocked };
}
test('Ready commits one durable native wake per eligible transition and returns it across restart/repeat', async () => {
  const f = await setup();
  try {
    const first = await f.blocked(); const other = await f.blocked();
    const response = await f.handler(request, target, true);
    assert.equal(response.resumes.length, 2); assert.equal(f.calls.length, 2);
    for (const receipt of response.resumes) assert.ok(receipt.wakeRequestId && receipt.blockedTransitionAt && receipt.transitionId);
    const repeat = await f.handler(request, target, true);
    assert.deepEqual(repeat.resumes, response.resumes);
    const later = await f.blocked();
    const catchup = await f.handler(request, target, true);
    assert.equal(catchup.resumes.length, 3); assert.equal(f.calls.length, 3);
    assert.deepEqual(new Set(catchup.resumes.map((r: any) => r.issueId)), new Set([first,other,later]));
    const wakes = await f.db.execute(sql`select id from agent_wakeup_requests`);
    assert.equal(wakes.rows.length, 3);
  } finally { await f.pg.close(); }
});
test('disabled resume does not mutate tickets but incident delivery is durable and rejects changed identity payload', async () => {
  const f = await setup();
  try {
    await f.blocked();
    const incident = { id: 'incident-1', reason: 'desktop recovery failed', time: Date.now() / 1000, involvedObject: { apiVersion: 'sandbox.opensandbox.io/v1alpha1', kind: 'BatchSandbox', namespace: target.namespace, name: target.desktop, uid: request.ready.batch.uid } };
    const payload = { ...request, incidents: [incident] };
    const response = await f.handler(payload, target, false);
    assert.equal(f.calls.length, 0); assert.equal(response.resumes.length, 0); assert.equal(response.notifications.length, 1);
    assert.ok(response.notifications[0].commentId);
    assert.deepEqual((await f.handler(payload, target, false)).notifications, response.notifications);
    await assert.rejects(f.handler({ ...payload, incidents: [{ ...incident, reason: 'changed' }] }, target, false));
    assert.equal((await f.db.execute(sql`select id from issue_comments`)).rows.length, 1);
  } finally { await f.pg.close(); }
});
test('old, unrelated, active-run, approval, input, prerequisite, recovery and tree-held tasks are not resumed', async () => {
  const f = await setup();
  try {
    await f.blocked('Deploy the database.');
    await f.blocked('Restore desktop command access.', new Date(Date.now() - 3 * 60 * 60 * 1000));
    const input = await f.blocked();
    await f.db.execute(sql`insert into issue_thread_interactions(company_id,issue_id,kind,payload) values(${companyId},${input},'ask_user_questions','{}')`);
    const approval = await f.blocked(), approvalId = randomUUID();
    await f.db.execute(sql`insert into approvals(id,company_id,type,status,payload) values(${approvalId},${companyId},'test','pending','{}')`);
    await f.db.execute(sql`insert into issue_approvals(company_id,issue_id,approval_id) values(${companyId},${approval},${approvalId})`);
    const dependency = await f.blocked();
    await f.db.execute(sql`insert into issue_relations(company_id,issue_id,related_issue_id,type) values(${companyId},${incidentIssueId},${dependency},'blocks')`);
    const active = await f.blocked();
    await f.db.execute(sql`insert into heartbeat_runs(company_id,agent_id,status,invocation_source,context_snapshot) values(${companyId},${agentId},'running','automation',${JSON.stringify({ issueId: active })}::jsonb)`);
    const recovery = await f.blocked();
    await f.db.execute(sql`insert into issue_recovery_actions(company_id,source_issue_id,kind,cause,fingerprint,next_action) values(${companyId},${recovery},'repair','test','test','wait')`);
    const held = await f.blocked();
    await f.db.execute(sql`insert into issue_tree_holds(company_id,root_issue_id,mode) values(${companyId},${held},'pause')`);
    const response = await f.handler(request,target,true);
    assert.equal(response.resumes.length,0); assert.equal(f.calls.length,0);
  } finally { await f.pg.close(); }
});
test('zero-result Ready persists identity and rejects changed evidence without needing a resumed task', async () => {
  const f = await setup();
  try {
    await f.handler(request,target,false);
    await assert.rejects(f.handler({ ...request, ready: { ...request.ready, podUid: randomUUID() } },target,false));
    assert.equal((await f.db.execute(sql`select id from activity_log where action='desktop_recovery.ready_receipt'`)).rows.length,1);
  } finally { await f.pg.close(); }
});
test('a failure after issue mutation rolls the transaction and its receipts back', async () => {
  const f = await setup();
  try {
    const id = await f.blocked();
    await f.pg.exec(`CREATE FUNCTION fail_wake() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'isolated crash before commit'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER fail_wake BEFORE INSERT ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION fail_wake()`);
    await assert.rejects(f.handler(request,target,true));
    assert.equal((await f.db.execute(sql`select status from issues where id=${id}`)).rows[0].status,'blocked');
    assert.equal((await f.db.execute(sql`select id from activity_log where action='desktop_recovery.resume_receipt'`)).rows.length,0);
  } finally { await f.pg.close(); }
});
test('shared native status wake intent is persisted by the existing scheduler outbox API', async () => {
  const f = await setup();
  try {
    const module = await import('../../server/src/services/native-runtime/status-wake-intents.js').catch(() => null);
    assert.ok(module?.enqueueNativeStatusWakeIntent, 'reuse one native durable wake-intent API');
    const id = await module.enqueueNativeStatusWakeIntent({ tx: f.db, companyId, agentId, issueId: incidentIssueId,
      actorId: 'desktop-recovery', reason: 'desktop_recovered', idempotencyKey: 'isolated-native-intent', payload: {} });
    assert.equal(await module.enqueueNativeStatusWakeIntent({ tx: f.db, companyId, agentId, issueId: incidentIssueId,
      actorId: 'desktop-recovery', reason: 'desktop_recovered', idempotencyKey: 'isolated-native-intent', payload: {} }), id);
    const result = await f.db.execute(sql`select requested_by_actor_id from agent_wakeup_requests where id=${id}`);
    assert.equal(result.rows[0].requested_by_actor_id, 'desktop-recovery');
  } finally { await f.pg.close(); }
});
test('receipts match the parent hook contract and identify a durable recovery receipt', async () => {
  const f = await setup();
  try {
    const id = await f.blocked();
    const incident = { id: 'incident-contract', reason: 'Evicted', time: Date.now() / 1000, involvedObject: { apiVersion: 'sandbox.opensandbox.io/v1alpha1', kind: 'BatchSandbox', namespace: target.namespace, name: target.desktop, uid: request.ready.batch.uid } };
    const response = await f.handler({ ...request, incidents: [incident] }, target, true);
    assert.equal(response.notifications[0].id, incident.id);
    const receipt = response.resumes.find((r: any) => r.issueId === id)!;
    assert.equal(receipt.outcome, 'resumed');
    assert.ok(receipt.blockedTransitionId && receipt.receiptId && receipt.wakeRequestId);
    assert.equal((await f.db.execute(sql`select id from activity_log where id=${receipt.receiptId} and action='desktop_recovery.resume_receipt'`)).rows.length, 1);
  } finally { await f.pg.close(); }
});
test('wake guard uses the persisted native update version, not an assumed increment', async () => {
  const f = await setup();
  try {
    const id = await f.blocked();
    await f.handler(request,target,true);
    const state = (await f.db.execute(sql`select status_version from issues where id=${id}`)).rows[0];
    const wake = (await f.db.execute(sql`select payload from agent_wakeup_requests`)).rows[0];
    assert.equal(wake.payload.desktopRecoveryGuard.statusVersion, state.status_version);
  } finally { await f.pg.close(); }
});
test('completed prerequisites and answered approvals do not hide eligible tasks', async () => {
  const f = await setup();
  try {
    const id = await f.blocked(), approvalId = randomUUID();
    await f.db.execute(sql`insert into approvals(id,company_id,type,status,payload) values(${approvalId},${companyId},'test','approved','{}')`);
    await f.db.execute(sql`insert into issue_approvals(company_id,issue_id,approval_id) values(${companyId},${id},${approvalId})`);
    await f.db.execute(sql`update issues set status='done' where id=${incidentIssueId}`);
    await f.db.execute(sql`insert into issue_relations(company_id,issue_id,related_issue_id,type) values(${companyId},${incidentIssueId},${id},'blocks')`);
    assert.equal((await f.handler(request,target,true)).resumes.length,1);
  } finally { await f.pg.close(); }
});
test('a resolved native action with an explicit no-replay hold still blocks ticket mutation', async () => {
  const f = await setup();
  try {
    const id = await f.blocked();
    await f.db.execute(sql`insert into issue_recovery_actions(company_id,source_issue_id,kind,cause,fingerprint,next_action,status,evidence) values(${companyId},${id},'repair','test','test','read status','resolved','{"automaticRecovery":{"replay":"blocked"}}')`);
    assert.equal((await f.handler(request,target,true)).resumes.length,0);
  } finally { await f.pg.close(); }
});
test('an unrelated tree hold does not prevent an eligible task from resuming', async () => {
  const f = await setup();
  try {
    await f.blocked();
    await f.db.execute(sql`insert into issue_tree_holds(company_id,root_issue_id,mode) values(${companyId},${incidentIssueId},'pause')`);
    assert.equal((await f.handler(request,target,true)).resumes.length,1);
  } finally { await f.pg.close(); }
});
test('a done prerequisite with an unfinished workspace finalization is not ready', async () => {
  const f = await setup();
  try {
    const id = await f.blocked();
    await f.db.execute(sql`update issues set status='done',execution_workspace_id=${randomUUID()} where id=${incidentIssueId}`);
    await f.db.execute(sql`insert into issue_relations(company_id,issue_id,related_issue_id,type) values(${companyId},${incidentIssueId},${id},'blocks')`);
    assert.equal((await f.handler(request,target,true)).resumes.length,0);
  } finally { await f.pg.close(); }
});
test('native pending execution review remains blocked even without an interaction row', async () => {
  const f = await setup();
  try {
    const id = await f.blocked();
    await f.db.execute(sql`update issues set execution_state='{"status":"pending","stageIndex":1}' where id=${id}`);
    assert.equal((await f.handler(request,target,true)).resumes.length,0);
  } finally { await f.pg.close(); }
});
test('only explicitly scoped restore-access children close; a title match never closes broader work', async () => {
  const f = await setup();
  try {
    const restore = await f.blocked(), broader = await f.blocked();
    await f.db.execute(sql`update issues set parent_id=${incidentIssueId} where id=${restore}`);
    await f.db.execute(sql`update issues set title='Restore desktop command access and finish implementation' where id=${broader}`);
    const response = await f.handler(request,{...target,restoreOnlyIssueIds:[restore]},true);
    assert.equal((await f.db.execute(sql`select status from issues where id=${restore}`)).rows[0].status,'done');
    assert.equal((await f.db.execute(sql`select status from issues where id=${broader}`)).rows[0].status,'todo');
    assert.equal(response.resumes.find((r:any)=>r.issueId===restore)?.outcome,'closed');
  } finally { await f.pg.close(); }
});
test('old Ready cannot authorize a later outage, while a new observation catches newly blocked transitions', async () => {
  const f=await setup();
  try {
    const old={...request,ready:{...request.ready}};
    const later=await f.blocked();
    const at=new Date(old.ready.observedAt*1000+10);
    await f.db.execute(sql`update issues set blocked_transition_at=${at.toISOString()} where id=${later}`);
    await f.db.execute(sql`update activity_log set created_at=${at.toISOString()},details=${JSON.stringify({changes:{status:{from:'todo',to:'blocked'},blockedTransitionAt:{from:null,to:at.toISOString()}}})}::jsonb where entity_id=${later}`);
    assert.equal((await f.handler(old,target,true)).resumes.length,0);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal((await f.handler(request,target,true)).resumes.length,1);
  } finally {await f.pg.close();}
});
