import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests, runLivenessOutbox, approvals, issueApprovals, issueThreadInteractions, issueRelations, issueComments } from '@paperclipai/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { heartbeatService } from '../services/heartbeat.js';
import { terminalizeLegacyExecution } from '../services/legacy-execution-recovery.js';
const { execute, probe, stop } = vi.hoisted(() => ({ execute: vi.fn(), probe: vi.fn(), stop: vi.fn() }));
vi.mock('../adapters/index.js', async original => ({ ...await original<typeof import('../adapters/index.js')>(), getServerAdapter: vi.fn(() => ({ type: 'test_external', execute, probeRun: probe, stopRun: stop })) }));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)('confirmed operator stop through the real wake queue', () => {
 let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, heartbeat: ReturnType<typeof heartbeatService>;
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('stop-queue-'); db = createDb(temp.connectionString); heartbeat = heartbeatService(db); }, 120000);
 afterEach(async () => { await heartbeat.drainActiveRunExecutions(); await db.update(runLivenessOutbox).set({ status: 'done' }); });
 afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
 async function fixture() {
  execute.mockReset(); probe.mockReset().mockResolvedValue({ state: 'settled' }); stop.mockReset().mockResolvedValue(undefined);
  const [company] = await db.insert(companies).values({ name: 'Stop', issuePrefix: crypto.randomUUID().slice(0, 8), defaultResponsibleUserId: 'board-user' }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Stop', status: 'idle', adapterType: 'test_external' }).returning();
  const [task] = await db.insert(issues).values({ companyId: company.id, title: '[test] saved work', status: 'in_progress', assigneeAgentId: agent.id, responsibleUserId: 'board-user' }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: task.id, contextSnapshot: { issueId: task.id }, runtimeMode: 'legacy', status: 'running', startedAt: new Date(Date.now()-3600000), runnerProfileJson: { externalObservation: { adapterType: 'test_external', config: {} } }, externalRunHandle: { sessionId: crypto.randomUUID(), turnRef: crypto.randomUUID(), dispatch: 'accepted' } }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, task.id));
  await terminalizeLegacyExecution({ db, run, status: 'cancelled', reconcileIfNeeded: true, patch: { finishedAt: new Date(), resultJson: { cancellation: { source: 'operator', expected: true, initiator: { type: 'user', id: 'board-user' }, reason: 'Stop', recordedAt: new Date().toISOString() } } } });
  const commentIds: string[] = [];
  for (const body of ['Check the first saved request.', 'Keep the second saved request.']) {
   const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: task.id, authorType: 'user', authorUserId: 'board-user', body }).returning(); commentIds.push(comment.id);
   await heartbeat.wakeup(agent.id, { source: 'on_demand', reason: 'issue_commented', requestedByActorType: 'user', requestedByActorId: 'board-user', payload: { issueId: task.id, commentId: comment.id }, contextSnapshot: { issueId: task.id, wakeReason: 'issue_commented', wakeCommentId: comment.id, wakeCommentIds: [comment.id] } });
  }
  execute.mockImplementation(async ctx => {
   await db.update(issues).set({ status: 'done', completedAt: new Date() }).where(eq(issues.id, task.id));
   return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
  });
  return { run, task, commentIds };
 }
 async function consume() { await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.consumeExternalRunLivenessOutbox(); await heartbeat.drainActiveRunExecutions(); }
 it('coalesces saved human input into exactly one outcome-aware continuation', async () => {
  const { run, commentIds } = await fixture(); await consume(); await consume();
  const ctx = execute.mock.calls[0]?.[0]?.context;
  expect(ctx?.recovery).toMatchObject({ predecessorRunId: run.id, outcomesUnknown: true });
  expect(ctx?.prompt).toContain('do not blindly replay');
  expect(ctx?.wakeCommentIds).toEqual(expect.arrayContaining(commentIds));
  const successor = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, 'succeeded')));
  expect(successor).toHaveLength(1);
  expect(execute).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(probe).toHaveBeenCalledOnce();
  const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
  expect(receipts).toHaveLength(1); expect(receipts[0].runId).not.toBeNull();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, run.agentId))).toHaveLength(2);
 });
 it.each(['question', 'approval', 'dependency'] as const)('does not release a pending %s gate', async kind => {
  const { run, task } = await fixture(); let blockerId: string | undefined;
  if (kind === 'dependency') {
   const [blocker] = await db.insert(issues).values({ companyId: run.companyId, title: '[test] blocker', status: 'todo', responsibleUserId: 'board-user' }).returning(); blockerId = blocker.id;
   await db.insert(issueRelations).values({ companyId: run.companyId, issueId: blocker.id, relatedIssueId: task.id, type: 'blocks' });
  } else if (kind === 'approval') {
   const [approval] = await db.insert(approvals).values({ companyId: run.companyId, type: 'test', status: 'pending', payload: {} }).returning();
   await db.insert(issueApprovals).values({ companyId: run.companyId, issueId: task.id, approvalId: approval.id });
  } else await db.insert(issueThreadInteractions).values({ companyId: run.companyId, issueId: task.id, kind: 'question', status: 'pending', payload: {} } as never);
  await consume(); expect(execute).not.toHaveBeenCalled();
  const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `liveness:${run.id}`));
  expect(receipt).toMatchObject({ status: 'deferred_issue_execution', runId: null });
  if (kind === 'approval') expect((await db.select().from(approvals).where(eq(approvals.companyId, run.companyId)))[0].status).toBe('pending');
  if (kind === 'question') expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, task.id)))[0].status).toBe('pending');
  if (blockerId) expect(await db.select().from(issueRelations).where(eq(issueRelations.issueId, blockerId))).toHaveLength(1);
 });
});
