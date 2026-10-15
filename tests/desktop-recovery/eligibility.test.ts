import assert from 'node:assert/strict';
import { test } from 'node:test';
const now = new Date('2026-10-15T03:00:00Z');
const transition = new Date('2026-10-15T02:00:00Z');
const agentId = '22222222-2222-4222-8222-222222222222';
const issue = { id: 'task', companyId: 'company', status: 'blocked', assigneeAgentId: agentId, assigneeUserId: null,
  statusVersion: 7, blockedTransitionAt: transition, hiddenAt: null, conversationAgentId: null, checkoutRunId: null, executionRunId: null,
  unblockDescriptor: { owner: { agentId }, action: 'Restore desktop command access.' } };
const audit = [{ id: 'transition', createdAt: transition, details: { changes: { status: { from: 'in_progress', to: 'blocked' } } } }];
async function check(candidate = issue, history = audit) {
  const module = await import('../../server/src/services/desktop-recovery-eligibility.js').catch(() => null);
  assert.ok(module?.desktopBlockedTransition, 'the authoritative blocked-transition policy must exist');
  return module.desktopBlockedTransition(candidate, history, agentId, now);
}
test('the latest actual blocked transition supplies the two-hour window, not updatedAt', async () => {
  assert.deepEqual(await check(), { transitionId: 'transition', blockedTransitionAt: transition.toISOString(), statusVersion: 7 });
  assert.equal(await check({ ...issue, blockedTransitionAt: new Date('2026-10-14T23:00:00Z'), updatedAt: now } as any,
    [{ ...audit[0], createdAt: new Date('2026-10-14T23:00:00Z') }]), null);
  assert.equal(await check({ ...issue, blockedTransitionAt: new Date('2026-10-15T03:00:01Z') }), null);
});
test('unknown, absent, inconsistent or later status history fails closed', async () => {
  for (const history of [[], [{ ...audit[0], details: { status: 'blocked' } }],
    [{ ...audit[0], details: { changes: { status: { from: null, to: 'blocked' } } } }],
    [{ ...audit[0], details: { changes: { status: { from: 'blocked', to: 'todo' } } } }],
    [{ ...audit[0], createdAt: new Date('2026-10-15T02:59:00Z') }]]) assert.equal(await check(issue, history as any), null);
  assert.equal(await check({ ...issue, blockedTransitionAt: null } as any), null);
  assert.ok(await check(issue, [{ ...audit[0], details: { fromStatus: 'in_progress', toStatus: 'blocked' } }] as any));
});
test('assignment, review, run ownership and unrelated or ambiguous current blockers stay untouched', async () => {
  for (const patch of [{ status: 'in_review' }, { assigneeAgentId: 'other' }, { assigneeUserId: 'user' }, { hiddenAt: now },
    { checkoutRunId: 'run' }, { executionRunId: 'run' }, { conversationAgentId: agentId }, { unblockDescriptor: null },
    { unblockDescriptor: { owner: 'board', action: 'Restore desktop command access.' } },
    { unblockDescriptor: { owner: { agentId }, action: 'Approve desktop credentials.' } },
    { unblockDescriptor: { owner: { agentId }, action: 'Restore desktop access and deploy database.' } },
    { unblockDescriptor: { owner: { agentId }, action: 'Wait for required dependency.' } }]) assert.equal(await check({ ...issue, ...patch } as any), null);
});
test('audit time proximity cannot validate an unrelated transition', async () => {
  assert.equal(await check(issue, [{ ...audit[0], createdAt: new Date(transition.getTime() + 20_000), details: { changes: { status: { from: 'todo', to: 'blocked' }, blockedTransitionAt: { from: null, to: '2026-10-15T02:00:19Z' } } } }] as any), null);
});
test('a newer unknown audit cannot be ignored in favor of an older valid transition', async () => {
  assert.equal(await check(issue, [{ id: 'unknown', createdAt: now, details: null }, ...audit] as any), null);
  assert.equal(await check(issue, [{ id: 'unknown', createdAt: now, details: {} }, ...audit] as any), null);
});
test('a changed blocker or assignment after the blocked transition invalidates its authority', async () => {
  for (const key of ['unblockDescriptor','blockedByIssueIds','assigneeAgentId','assigneeUserId','parentId','reviewPolicy','executionPolicy']) {
    const changes = { [key]: { from: 'old', to: 'new' } };
    assert.equal(await check(issue, [{ id: 'changed', createdAt: now, details: { changes } }, ...audit] as any), null);
  }
});
