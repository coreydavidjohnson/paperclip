import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundExecutionContinuation } from '../server/src/services/continuation-budget.ts';
import { decideQueuedRunStaleness } from '../server/src/modules/run-dispatch/domain/policy.ts';

const message = (index, authorType = 'agent', body = 'status '.repeat(200)) => ({
  id: `comment-${index}`, authorType, authorId: authorType, createdByRunId: authorType === 'agent' ? 'run' : null,
  body, createdAt: '2026-10-28T18:00:00Z', updatedAt: '2026-10-28T18:00:00Z', deleted: false, sourceTrust: null,
});
const envelope = (messages = []) => ({
  version: 1, companyId: 'company', issueId: 'issue',
  trigger: { reason: 'issue_assigned', interactionId: null, sourceRunId: null },
  originCommentIds: [], objective: 'Preserve data and approval gates.',
  messages, humanResponses: [], interactionOutcomes: [], completedActions: [], completedWork: 'Verified saved work.',
  unresolvedInteractionIds: ['pending-approval'],
  coverage: { kind: 'full_task_history', throughCommentId: messages.at(-1)?.id ?? null, summaryThroughCommentId: null },
});
const encodedBytes = value => Buffer.byteLength(JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));

test('fresh long history keeps all human direction and only five recent agent comments', () => {
  const messages = Array.from({ length: 162 }, (_, index) => message(index));
  messages.splice(20, 0, message('human', 'user', 'Never delete retained state.'));
  messages.splice(60, 0, message('board', 'board', 'Approval is limited to staging.'));
  const original = envelope(messages);
  const bounded = boundExecutionContinuation(original);
  assert.ok(encodedBytes(bounded) <= 24 * 1024);
  assert.equal(bounded.messages.filter(row => row.authorType === 'agent').length, 5);
  assert.deepEqual(bounded.messages.filter(row => row.authorType !== 'agent'), messages.filter(row => row.authorType !== 'agent'));
  assert.deepEqual(bounded.messages.filter(row => row.authorType === 'agent').map(row => row.id), messages.slice(-5).map(row => row.id));
  assert.equal(bounded.coverage.kind, 'bounded_task_history');
  assert.equal(bounded.coverage.omittedAgentCommentCount, 157);
  assert.equal(original.messages.length, 164);
  assert.equal(bounded.completedWork, original.completedWork);
  assert.deepEqual(bounded.unresolvedInteractionIds, ['pending-approval']);
});
test('small history is unchanged', () => {
  const original = envelope([message(1)]);
  assert.deepEqual(boundExecutionContinuation(original), original);
});
test('escaped multibyte agent output cannot exceed the byte budget', () => {
  const bounded = boundExecutionContinuation(envelope(Array.from({ length: 8 }, (_, index) => message(index, 'agent', '<>🐎'.repeat(5000)))));
  assert.ok(encodedBytes(bounded) <= 24 * 1024);
  assert.equal(bounded.coverage.kind, 'bounded_task_history');
});
test('oversized human direction requires a thread read instead of truncated authority', () => {
  const original = envelope([message('human', 'user', 'Do not deploy. '.repeat(10000))]);
  original.humanResponses = [{ id: 'answer', kind: 'request_confirmation', status: 'accepted', resolvedByUserId: 'owner', resolvedAt: '2026-10-28T18:00:00Z', result: { accepted: true } }];
  const bounded = boundExecutionContinuation(original);
  assert.ok(encodedBytes(bounded) <= 24 * 1024);
  assert.equal(bounded.coverage.requiresThreadFetch, true);
  assert.deepEqual(bounded.humanResponses, []);
  assert.deepEqual(bounded.messages, []);
  assert.deepEqual(bounded.unresolvedInteractionIds, ['pending-approval']);
  assert.equal(original.humanResponses.length, 1);
});
test('run-authored user attribution is not mistaken for human direction', () => {
  const original = envelope(Array.from({ length: 30 }, (_, index) => ({ ...message(index), authorType: 'user' })));
  assert.equal(boundExecutionContinuation(original).messages.length, 5);
});
test('resume deltas do not reintroduce omitted agent history', () => {
  const original = envelope(Array.from({ length: 20 }, (_, index) => message(index)));
  original.resumeDelta = { baseRunId: 'prior', messages: original.messages, humanResponses: { updated: [], removedIds: ['withdrawn'] } };
  const bounded = boundExecutionContinuation(original);
  assert.equal(bounded.resumeDelta.messages.length, 5);
  assert.deepEqual(bounded.resumeDelta.humanResponses.removedIds, ['withdrawn']);
});
const facts = {
  runId: 'run', runAgentId: 'agent', issueId: 'issue', retryReasonKind: 'other',
  issueFound: true, issueStatus: 'blocked', issueAssigneeAgentId: 'agent', issueExecutionRunId: 'run',
  isResolvedInteractionContinuation: false, isInteractionWake: false, isAuthorizedSourceScopedRecovery: false,
  isNonAssigneeWorkspaceBusyRetry: false, resumeIntent: false, wakeCommentIdPresent: false,
  continuationParkApplies: false, continuationParksExecutor: false, continuationSummaryBody: null,
  wakeReason: 'transient_failure_retry', retryReason: 'transient_failure',
  reviewParticipant: { isInReview: false, hasParticipant: false, participantIsAgent: false, participantAgentId: null, currentStageType: null, currentParticipant: null },
};
test('a blocker added after retry promotion prevents provider dispatch', () => {
  assert.equal(decideQueuedRunStaleness({ ...facts, dependenciesBlocked: { unresolvedBlockerIssueIds: ['blocker'], unresolvedBlockerCount: 1 } }).errorCode, 'issue_dependencies_blocked');
});
test('a transient retry becomes eligible after its blocker closes', () => {
  assert.equal(decideQueuedRunStaleness({ ...facts, issueStatus: 'in_progress', dependenciesBlocked: null }).stale, false);
});
test('explicit new user direction is not suppressed by the automatic retry guard', () => {
  assert.equal(decideQueuedRunStaleness({ ...facts, wakeReason: 'issue_commented', retryReason: null, wakeCommentIdPresent: true, dependenciesBlocked: { unresolvedBlockerIssueIds: ['blocker'], unresolvedBlockerCount: 1 } }).stale, false);
});
