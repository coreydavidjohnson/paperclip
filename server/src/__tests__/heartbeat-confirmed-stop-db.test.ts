import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agents, companies, createDb, heartbeatRuns, issues, issueRecoveryActions, runLivenessOutbox, agentWakeupRequests } from '@paperclipai/db';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { createExternalRunLivenessWorker } from '../services/heartbeat/external-run-liveness.js';
import { terminalizeLegacyExecution } from '../services/legacy-execution-recovery.js';
import { getExecutionBlocker } from '../services/execution-blocker.js';
import { settleUnrecoverableExecutions } from '../services/execution-recovery-resolution.js';
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)('confirmed external stop and parked hold release', () => {
 let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('confirmed-stop-'); db = createDb(temp.connectionString); }, 120000);
 afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
 afterEach(async () => { await db.update(runLivenessOutbox).set({ status: "done" }); });
 async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: 'Stop', issuePrefix: companyId.slice(0, 8), defaultResponsibleUserId: 'board-user' });
  await db.insert(agents).values({ id: agentId, companyId, name: 'Stop', status: 'idle', adapterType: 'test_external' });
  const [task] = await db.insert(issues).values({ companyId, title: 'Saved work', status: 'in_progress', assigneeAgentId: agentId, responsibleUserId: 'board-user' }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: task.id, contextSnapshot: { issueId: task.id }, status: 'running', runtimeMode: 'legacy',
   startedAt: new Date(Date.now() - 3600000), runnerProfileJson: { externalObservation: { adapterType: 'test_external', config: { original: true } } },
   externalRunHandle: { sessionId: randomUUID(), turnRef: randomUUID(), dispatch: 'accepted' } }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, task.id));
  await terminalizeLegacyExecution({ db, run, status: 'cancelled', reconcileIfNeeded: true, patch: { finishedAt: new Date(), resultJson: {
   cancellation: { source: 'operator', expected: true, initiator: { type: 'user', id: 'board-user' }, reason: 'Stop requested', recordedAt: new Date().toISOString() },
  } } });
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: 'automation', status: 'deferred_issue_execution', payload: { issueId: task.id }, requestedAt: new Date(0) }).returning();
  return { run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0], task, wake };
 }
 const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
 function worker(probe: any, options: { stop?: any; terminal?: any; wake?: any } = {}) {
  return createExternalRunLivenessWorker(db, { getAdapter: () => ({ type: 'test_external', probeRun: probe, stopRun: options.stop ?? vi.fn(async () => {}) } as never),
   resolveConfig: async (_company, config) => config, onSettled: async () => {}, onObserve: async () => {}, onTerminal: options.terminal ?? vi.fn(async () => {}), wake: options.wake ?? vi.fn(async () => {}) });
 }
 for (const state of ['gone', 'settled']) it(`records ${state} after operator stop and releases once`, async () => {
  const { run, task } = await fixture(); const probe = vi.fn(async () => ({ state })), wake = vi.fn(async () => {}), terminal = vi.fn(async () => {});
  const w = worker(probe, { wake, terminal });
  await w.consumeOutbox(); await w.consumeOutbox(); await w.consumeOutbox();
  expect(probe).toHaveBeenCalledWith(expect.objectContaining({ handle: run.externalRunHandle, config: { original: true } }));
  expect((await read(run.id)).resultJson).toMatchObject({ executionReconciliation: { runId: run.id, providerStopped: true, actionOutcome: 'mixed', probe: { state } } });
  expect(await getExecutionBlocker(db, run.companyId, task.id)).toBeNull();
  expect(wake).toHaveBeenCalledOnce(); expect(terminal).toHaveBeenCalledOnce();
  await settleUnrecoverableExecutions(db);
  expect(await getExecutionBlocker(db, run.companyId, task.id)).toBeNull();
 });
 for (const state of ['active', 'unknown']) it(`keeps the hold after a stop ACK with ${state} probe`, async () => {
  const { run, task } = await fixture(); const wake = vi.fn(async () => {}), terminal = vi.fn(async () => {});
  await worker(async () => ({ state }), { wake, terminal }).consumeOutbox();
  expect(await getExecutionBlocker(db, run.companyId, task.id)).not.toBeNull();
  expect((await read(run.id)).resultJson?.executionReconciliation).toBeUndefined();
  expect(wake).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled();
  const [stop] = await db.select().from(runLivenessOutbox).where(and(eq(runLivenessOutbox.runId, run.id), eq(runLivenessOutbox.action, 'stop_provider_session')));
  expect(stop.status).toBe('pending');
 });
 it('retains workspace holds even when the provider has stopped', async () => {
  const { run, task } = await fixture();
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || '{"workspaceRestoreFailure":"restore_unsafe_archive"}'::jsonb` }).where(eq(issueRecoveryActions.sourceIssueId, task.id));
  await worker(async () => ({ state: 'gone' })).consumeOutbox();
  expect(await getExecutionBlocker(db, run.companyId, task.id)).not.toBeNull();
 });
 it('does not restart cancelled work when no input is parked', async () => {
  const { run } = await fixture(); await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, run.companyId));
  const wake = vi.fn(async () => {}), terminal = vi.fn(async () => {});
  const w = worker(async () => ({ state: 'gone', reason: 'deleted' }), { wake, terminal });
  await w.consumeOutbox(); await w.consumeOutbox(); expect(wake).not.toHaveBeenCalled(); expect(terminal).toHaveBeenCalledOnce();
 });
 it('rolls back reconciliation and hold retirement if durable release cannot commit', async () => {
  const { run, task } = await fixture();
  await db.execute(sql.raw(`CREATE FUNCTION reject_stop_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${run.id}' AND NEW.action = 'finalize_external_run' THEN RAISE EXCEPTION 'injected release failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_stop_release BEFORE INSERT ON run_liveness_outbox FOR EACH ROW EXECUTE FUNCTION reject_stop_release();`));
  try {
   await worker(async () => ({ state: 'gone', reason: 'deleted' })).consumeOutbox();
   expect((await read(run.id)).resultJson?.executionReconciliation).toBeUndefined();
   expect(await getExecutionBlocker(db, run.companyId, task.id)).not.toBeNull();
  } finally { await db.execute(sql.raw('DROP TRIGGER reject_stop_release ON run_liveness_outbox; DROP FUNCTION reject_stop_release();')); }
 });
 it('rejects probe evidence superseded by a concurrent version change', async () => {
  const { run, task } = await fixture();
  await worker(async () => { await db.update(heartbeatRuns).set({ livenessVersion: sql`${heartbeatRuns.livenessVersion} + 1` }).where(eq(heartbeatRuns.id, run.id)); return { state: 'gone', reason: 'deleted' }; }).consumeOutbox();
  expect((await read(run.id)).resultJson?.executionReconciliation).toBeUndefined();
  expect(await getExecutionBlocker(db, run.companyId, task.id)).not.toBeNull();
 });
 it('cutover dry run probes without stop, mutation or admission; apply shares the confirmed-stop rule', async () => {
  const { run, task, wake } = await fixture(); const stop = vi.fn(async () => {}), terminal = vi.fn(async () => {}), admit = vi.fn(async () => {});
  const w = worker(async () => ({ state: 'settled' }), { stop, terminal, wake: admit });
  expect(await w.sweepParkedWakes({ companyId: run.companyId })).toMatchObject({ dryRun: true, entries: [{ wakeId: wake.id, runId: run.id, state: 'settled', applied: false }], nextCursor: null });
  expect(await getExecutionBlocker(db, run.companyId, task.id)).not.toBeNull(); expect(stop).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
  expect(await w.sweepParkedWakes({ companyId: run.companyId, apply: true })).toMatchObject({ dryRun: false, entries: [{ applied: true }] });
  expect(await getExecutionBlocker(db, run.companyId, task.id)).toBeNull();
  await w.consumeOutbox(); await w.consumeOutbox(); expect(admit).toHaveBeenCalledOnce();
 });
 it('cutover lists unknown and missing-handle wakes for human inspection and does not cross companies', async () => {
  const a = await fixture(), b = await fixture(); const probe = vi.fn(async () => ({ state: 'unknown', reason: 'outage' }));
  const w = worker(probe);
  expect(await w.sweepParkedWakes({ companyId: a.run.companyId, apply: true })).toMatchObject({ entries: [{ runId: a.run.id, state: 'unknown', applied: false }] });
  expect(probe).toHaveBeenCalledOnce(); expect(await getExecutionBlocker(db, a.run.companyId, a.task.id)).not.toBeNull();
  await db.update(heartbeatRuns).set({ externalRunHandle: null }).where(eq(heartbeatRuns.id, b.run.id));
  expect(await w.sweepParkedWakes({ companyId: b.run.companyId, apply: true })).toMatchObject({ entries: [{ runId: b.run.id, state: 'missing_durable_handle', applied: false }] });
 });

 it('does not stop a newer provider turn after confirmed-stop commit loses its ACK', async () => {
  const { run } = await fixture(); const stop = vi.fn(async () => {}), probe = vi.fn(async () => ({ state: 'settled' }));
  const w = worker(probe, { stop }); await w.consumeOutbox(); await w.consumeOutbox();
  await db.update(runLivenessOutbox).set({ status: 'pending', nextAttemptAt: new Date(0) }).where(and(eq(runLivenessOutbox.runId, run.id), eq(runLivenessOutbox.action, 'stop_provider_session')));
  probe.mockResolvedValue({ state: 'active' }); await w.consumeOutbox();
  expect(stop).toHaveBeenCalledOnce(); expect(probe).toHaveBeenCalledOnce();
  const [row] = await db.select().from(runLivenessOutbox).where(and(eq(runLivenessOutbox.runId, run.id), eq(runLivenessOutbox.action, 'stop_provider_session')));
  expect(row.status).toBe('done');
 });

 it('cutover running sources keep progress grace and the two-confirmation gone rule', async () => {
  const { run, task } = await fixture(); const probe = vi.fn(async () => ({ state: 'gone', reason: 'missing' }));
  await db.update(heartbeatRuns).set({ status: 'running', finishedAt: null, resultJson: null, lastProgressAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, task.id));
  const w = worker(probe);
  expect(await w.sweepParkedWakes({ companyId: run.companyId, apply: true })).toMatchObject({ entries: [{ state: 'progress_grace', applied: false }] });
  expect(probe).not.toHaveBeenCalled();
  await db.update(heartbeatRuns).set({ lastProgressAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
  expect(await w.sweepParkedWakes({ companyId: run.companyId, apply: true })).toMatchObject({ entries: [{ state: 'gone_not_confirmed', applied: false }] });
  expect((await read(run.id)).status).toBe('running');
  await db.update(heartbeatRuns).set({ livenessProbe: { state: 'gone', firstGoneAt: new Date(Date.now() - 120001).toISOString() } }).where(eq(heartbeatRuns.id, run.id));
  expect(await w.sweepParkedWakes({ companyId: run.companyId, apply: true })).toMatchObject({ entries: [{ state: 'gone', applied: true }] });
  expect((await read(run.id)).resultJson).toMatchObject({ executionReconciliation: { runId: run.id, providerStopped: true, actionOutcome: 'mixed' } });
 });

});
