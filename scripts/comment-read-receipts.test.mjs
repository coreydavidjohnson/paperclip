import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQueuedIssueComment, applyLocalQueuedIssueCommentState } from '../ui/src/lib/optimistic-issue-comments.ts';
const comment = { id: 'delivered', createdAt: '2026-10-22T18:00:00Z', consumedByRunId: 'run-1' };
test('acknowledged input is not inferred queued from its submission time', () => {
  assert.equal(isQueuedIssueComment({ comment, activeRunStartedAt: '2026-10-22T17:00:00Z' }), false);
});
test('acknowledged input overrides the submitters local queued target', () => {
  assert.equal(applyLocalQueuedIssueCommentState(comment, { queuedTargetRunId: 'run-1', targetRunIsLive: true, runningRunId: 'run-1' }), comment);
});
test('only native acknowledged-read audit facts establish delivery', async () => {
  const { getIssueCommentReadReceipts } = await import('../ui/src/lib/optimistic-issue-comments.ts');
  const receipt = { action: 'issue.queued_comments_delivered', runId: 'run-1', createdAt: new Date('2026-10-22T18:04:15Z'), details: { delivery: 'issue_comments_read', commentIds: ['first', 'second', 12, null, ''] } };
  const reads = getIssueCommentReadReceipts([
    { ...receipt, createdAt: new Date('2026-10-22T18:05:00Z') }, receipt,
    { ...receipt, runId: null, details: { ...receipt.details, commentIds: ['no-run'] } },
    { ...receipt, action: 'issue.comment_added', details: { ...receipt.details, commentIds: ['wrong-action'] } },
    { ...receipt, details: { delivery: 'unacknowledged', commentIds: ['wrong-mode'] } },
    { ...receipt, createdAt: new Date('invalid'), details: { ...receipt.details, commentIds: ['bad-date'] } },
  ]);
  assert.deepEqual([...reads.keys()], ['first', 'second']);
  assert.deepEqual(reads.get('first'), { runId: 'run-1', anchorAt: '2026-10-22T18:04:15.000Z', sequence: 0 });
  assert.equal(reads.get('second').sequence, 1);
});
