import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, issues, agentWakeupRequests, runLivenessOutbox, approvals, issueApprovals, issueThreadInteractions, issueRelations, issueComments } from '@paperclipai/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { createAdapterExecutionControl, registerAdapterExecutionControl, adapterExecutionControls } from '../services/adapter-execution-control.js';
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
 async function fixture(source = 'operator') {
  execute.mockReset(); probe.mockReset().mockResolvedValue({ state: 'settled' }); stop.mockReset().mockResolvedValue(undefined);
  const [company] = await db.insert(companies).values({ name: 'Stop', issuePrefix: crypto.randomUUID().slice(0, 8), defaultResponsibleUserId: 'board-user' }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Stop', status: 'idle', adapterType: 'test_external' }).returning();
  const [task] = await db.insert(issues).values({ companyId: company.id, title: '[test] saved work', status: 'in_progress', assigneeAgentId: agent.id, responsibleUserId: 'board-user' }).returning();
  const runId = crypto.randomUUID();
  const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id, issueId: task.id, contextSnapshot: { issueId: task.id }, runtimeMode: 'legacy', status: 'running', startedAt: new Date(Date.now()-3600000), runnerProfileJson: { externalObservation: { adapterType: 'test_external', config: {} } }, externalRunHandle: { runId, companyId: company.id, agentId: agent.id, sessionId: crypto.randomUUID(), turnRef: crypto.randomUUID(), dispatch: 'accepted' } }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, task.id));
  await terminalizeLegacyExecution({ db, run, status: 'cancelled', reconcileIfNeeded: true, patch: { finishedAt: new Date(), resultJson: { executionCancellation: { state: 'requested', requestedAt: new Date().toISOString() }, cancellation: { source, expected: true, initiator: { type: 'user', id: 'board-user' }, reason: 'Stop', recordedAt: new Date().toISOString() } } } });
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
 it.each(['operator', 'control_plane', 'queued_message'])('coalesces saved human input after %s stop into exactly one outcome-aware continuation', async source => {
  const { run, commentIds } = await fixture(source); await consume(); await consume();
  const ctx = execute.mock.calls[0]?.[0]?.context;
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].resultJson?.executionCancellation).toMatchObject({ state: 'acknowledged' });
  expect(ctx?.recovery).toMatchObject({ predecessorRunId: run.id, outcomesUnknown: true });
  expect(ctx?.prompt).toContain('do not blindly replay');
  expect(ctx?.wakeCommentIds).toEqual(expect.arrayContaining(commentIds));
  const successor = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, 'succeeded')));
  expect(successor).toHaveLength(1);
  expect(execute).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled(); expect(probe).toHaveBeenCalledOnce();
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
  const delivery = await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId, run.id));
  expect(receipt, JSON.stringify({ delivery })).toMatchObject({ status: 'deferred_issue_execution', runId: null });
  if (kind === 'approval') expect((await db.select().from(approvals).where(eq(approvals.companyId, run.companyId)))[0].status).toBe('pending');
  if (kind === 'question') expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, task.id)))[0].status).toBe('pending');
  if (blockerId) expect(await db.select().from(issueRelations).where(eq(issueRelations.issueId, blockerId))).toHaveLength(1);
 });
 async function cancelOwnedTurn(source: string, state = 'settled') {
  const { run, task } = await fixture(source);
  await db.update(heartbeatRuns).set({ status: 'running', finishedAt: null, resultJson: null }).where(eq(heartbeatRuns.id, run.id));
  const control = createAdapterExecutionControl(); await registerAdapterExecutionControl(run.id, control);
  probe.mockResolvedValue({ state });
  let settle: Promise<unknown> | undefined;
  control.controller.signal.addEventListener('abort', () => {
   settle = (async () => {
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    await terminalizeLegacyExecution({ db, run: current, status: 'cancelled', reconcileIfNeeded: true,
     patch: { finishedAt: new Date(), resultJson: current.resultJson } });
   })().finally(() => { adapterExecutionControls.delete(run.id); control.finish(); });
  }, { once: true });
  const resultJson = source === 'operator' ? { cancelledByActorType: 'user', cancelledByUserId: 'board-user' }
   : source === 'queued_message' ? { queuedCommentInterruptQueueId: crypto.randomUUID() } : {};
  try { return { stopped: await heartbeat.cancelRun(run.id, 'Stop original turn', { resultJson }), task, run }; }
  finally { await settle; adapterExecutionControls.delete(run.id); control.finish(); }
 }
 it.each(['operator', 'control_plane', 'queued_message'])('synchronous %s cancellation accepts confirmed original termination without false409', async source => {
  const { stopped } = await cancelOwnedTurn(source);
  expect(stopped?.status).toBe('cancelled');
  expect(stopped?.resultJson?.executionCancellation).toMatchObject({ state: 'acknowledged', proof: 'external_run_probe' });
  expect(stop).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
 });
 it('synchronous cancellation keeps409 when original termination is unknown', async () => {
  await expect(cancelOwnedTurn('control_plane', 'unknown')).rejects.toThrow('provider termination could not be verified');
  expect(stop).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
 });

 it('public cancellation worker rejects proof when a concurrent rebind wins', async () => {
  const { run, task } = await fixture('control_plane');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  probe.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'settled' }; });
  const consumption = heartbeat.consumeExternalRunLivenessOutbox();
  try {
   await entered.promise;
   await db.transaction(async tx => {
    await tx.select().from(issues).where(eq(issues.id, task.id)).for('update');
    await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for('update');
    await tx.update(heartbeatRuns).set({ externalRunHandle: { ...run.externalRunHandle!, turnRef: crypto.randomUUID() },
     observerEpoch: sql`${heartbeatRuns.observerEpoch} + 1` }).where(eq(heartbeatRuns.id, run.id));
   });
  } finally { release.resolve(); await consumption; }
  const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  expect(saved.resultJson?.executionCancellation).toMatchObject({ state: 'requested' });
  expect(saved.resultJson?.executionReconciliation).toBeUndefined();
  expect(stop).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  expect(await db.select().from(runLivenessOutbox).where(and(eq(runLivenessOutbox.runId, run.id), eq(runLivenessOutbox.action, 'finalize_external_run')))).toHaveLength(0);
 });

 it('competing public workers stop the original turn once and commit one acknowledgement', async () => {
  const { run } = await fixture('queued_message');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const other = heartbeatService(db);
  probe.mockResolvedValueOnce({ state: 'active' }).mockResolvedValue({ state: 'settled' });
  stop.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
  const first = heartbeat.consumeExternalRunLivenessOutbox();
  try { await entered.promise; await other.consumeExternalRunLivenessOutbox(); }
  finally { release.resolve(); await first; }
  const [ack] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  expect(ack.resultJson?.executionCancellation).toMatchObject({ state: 'acknowledged', proof: 'external_run_probe' });
  expect(stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ handle: run.externalRunHandle }));
  expect(probe).toHaveBeenCalledTimes(2);
  await Promise.all([heartbeat.consumeExternalRunLivenessOutbox(), other.consumeExternalRunLivenessOutbox()]);
  await heartbeat.drainActiveRunExecutions(); await other.drainActiveRunExecutions();
  const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  expect(after.resultJson?.executionCancellation).toEqual(ack.resultJson?.executionCancellation);
  expect(after.livenessVersion).toBe(ack.livenessVersion);
  const acknowledgements = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, 'external.liveness')));
  expect(acknowledgements.filter(event => event.payload?.state === 'settled')).toHaveLength(1);
  expect(await db.select().from(runLivenessOutbox).where(and(eq(runLivenessOutbox.runId, run.id), eq(runLivenessOutbox.action, 'finalize_external_run')))).toHaveLength(1);
  expect(execute).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
 });

});
