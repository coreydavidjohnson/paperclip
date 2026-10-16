import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { desktopRecoveryService } from '../../server/src/services/desktop-recovery.js';

// Real PostgreSQL driver/locking check; native issue-service integration remains
// a separate release gate. No production URL, credentials, or tickets are used.
test('isolated PostgreSQL driver commits incident receipts and fences simultaneous retries', { timeout: 90000 }, async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), 'per591-pg-'));
  const password = randomUUID();
  const pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'isolated_test', password, persistent: true,
    initdbFlags: ['--encoding=UTF8','--locale=C','--lc-messages=C'], onLog: message => console.log(message), onError: message => console.error(message) });
  let client: ReturnType<typeof postgres> | undefined;
  let started = false;
  try {
    await pg.initialise(); await pg.start(); started = true;
    client = postgres({ host: '127.0.0.1', port, user: 'isolated_test', database: 'postgres', password, max: 3 });
    // Local test is isolated by loopback and ephemeral randomly-authenticated cluster.
    const db = drizzle(client);
    const snapshot = JSON.parse(await readFile(new URL('../../packages/db/src/migrations/meta/0293_snapshot.json', import.meta.url), 'utf8'));
    const names = ['companies','agents','issues','activity_log','issue_comments','agent_wakeup_requests','heartbeat_runs','issue_thread_interactions','issue_approvals','approvals','issue_relations','issue_recovery_actions','issue_tree_holds','issue_tree_hold_members','tool_action_requests','workspace_operations','native_run_finalizations'];
    for (const name of names) {
      const table = snapshot.tables[`public.${name}`];
      const columns = Object.values(table.columns).map((c: any) => `"${c.name}" ${c.type}${c.notNull ? ' NOT NULL' : ''}${c.default === undefined ? '' : ` DEFAULT ${c.default}`}${c.primaryKey ? ' PRIMARY KEY' : ''}`);
      await client.unsafe(`CREATE TABLE "${name}" (${columns.join(',')})`);
    }
    for (const name of names.filter(n => snapshot.tables[`public.${n}`].columns.company_id && snapshot.tables[`public.${n}`].columns.id)) await client.unsafe(`ALTER TABLE "${name}" ADD UNIQUE(company_id,id)`);
    for (const name of names) {
      const table = snapshot.tables[`public.${name}`];
      for (const fk of Object.values(table.foreignKeys) as any[]) {
        if (!names.includes(fk.tableTo) || fk.columnsTo.length !== 1) continue;
        await client.unsafe(`ALTER TABLE "${name}" ADD CONSTRAINT "${fk.name}" FOREIGN KEY (${fk.columnsFrom.map((v: string) => `"${v}"`).join(',')}) REFERENCES "${fk.tableTo}" (${fk.columnsTo.map((v: string) => `"${v}"`).join(',')})`);
      }
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await client`insert into companies(id,name,issue_prefix,status) values(${companyId},'isolated test','ISO','active')`;
    await client`insert into agents(id,company_id,name,adapter_type,status) values(${agentId},${companyId},'isolated test','process','idle')`;
    await client`insert into issues(id,company_id,title,status) values(${issueId},${companyId},'isolated incident target','todo')`;
    const target = { companyId, agentId, incidentIssueId: issueId, namespace: 'opensandbox', desktop: 'desktop-isolated' };
    const handler = desktopRecoveryService(db as any, {
      updateIssue: async (tx, id, data) => { await tx.execute(sql`update issues set status='todo',status_version=status_version+1 where id=${id}`); return { statusVersion: 1, changes: {status:{from:'blocked',to:'todo'}} }; },
      addComment: async (tx, id, body) => {
        const commentId = randomUUID();
        await tx.execute(sql`insert into issue_comments(id,company_id,issue_id,body,author_type) values(${commentId},${companyId},${id},${body},'system')`);
        return { id: commentId };
      }, afterCommit: async () => {}, isSuppressed: () => false,
    });
    const request = { version: 1 as const, agent: 'isolated', desktop: target.desktop, incidents: [{ id: 'event-1', reason: 'DesktopRecoveryStarted', time: Date.now()/1000,
      involvedObject: { apiVersion: 'sandbox.opensandbox.io/v1alpha1', kind: 'BatchSandbox', namespace: target.namespace, name: target.desktop, uid: randomUUID() } }],
      ready: { observedAt:Date.now()/1000, recoveryId: 'attempt-1', batch: { namespace: target.namespace, name: target.desktop, uid: randomUUID(), generation: 1, observedGeneration: 1 }, podUid: randomUUID() } };
    const results = await Promise.all([handler(request,target,false),handler(request,target,false)]);
    assert.deepEqual(results[0],results[1]);
    assert.equal((await client`select id from issue_comments`).length,1);
    assert.equal((await client`select id from agent_wakeup_requests`).length,0);
    await assert.rejects(handler({...request, incidents:[{...request.incidents[0], reason:'changed'}]},target,false));
    const blockedId = randomUUID(), transitionId = randomUUID(), at = new Date(Date.now()-1000).toISOString();
    await client`insert into issues(id,company_id,title,status,assignee_agent_id,blocked_transition_at,unblock_descriptor) values(${blockedId},${companyId},'isolated blocked','blocked',${agentId},${at},${JSON.stringify({owner:{agentId},action:'Restore desktop command access.'})}::jsonb)`;
    await client`insert into activity_log(id,company_id,actor_type,actor_id,action,entity_type,entity_id,created_at,details) values(${transitionId},${companyId},'system','isolated','issue.updated','issue',${blockedId},${at},${JSON.stringify({changes:{status:{from:'todo',to:'blocked'},blockedTransitionAt:{from:null,to:at}}})}::jsonb)`;
    const resumed = await handler(request,target,true);
    assert.equal(resumed.resumes.length,1);
    assert.equal((await client`select id from agent_wakeup_requests`).length,1);
    console.log('POSTGRES_CONCURRENT_DEDUPE_OK');
  } finally {
    await client?.end();
    if (started) await pg.stop();
    await rm(dir,{recursive:true,force:true});
    await assert.rejects(stat(dir), { code:'ENOENT' });
    console.log('POSTGRES_PROCESS_STOPPED_AND_DATA_DIRECTORY_ABSENT');
  }
});
