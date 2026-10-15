import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@paperclipai/db';
import { agentWakeupRequests } from '@paperclipai/db/schema/agent_wakeup_requests';

/** Call under the authoritative issue lock. The heartbeat dispatcher alone
 * admits these durable intents to real queued runs after commit/restart. */
export async function enqueueNativeStatusWakeIntent(input: {
  tx: Db; companyId: string; issueId: string; agentId: string; reason: string;
  idempotencyKey: string; payload: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>; actorId?: 'native-status-committer' | 'desktop-recovery';
}) {
  const existing = await input.tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
    inArray(agentWakeupRequests.status, ['queued','deferred_issue_execution','claimed','completed','coalesced']),
  )).limit(1);
  if (existing[0]) return existing[0].id;
  const desktop = input.actorId === 'desktop-recovery';
  const [inserted] = await input.tx.insert(agentWakeupRequests).values({
    companyId: input.companyId, agentId: input.agentId, source: 'automation', triggerDetail: 'system', reason: input.reason,
    payload: { issueId: input.issueId, taskId: input.issueId, ...input.payload,
      _paperclipWakeContext: { issueId: input.issueId, taskId: input.issueId, ...(input.contextSnapshot ?? {}), wakeReason: input.reason,
        source: desktop ? 'desktop_recovery' : 'native_status_decision',
        ...(desktop ? {} : { statusDecisionSource: 'native_status_decision' }) } },
    requestedByActorType: 'system', requestedByActorId: input.actorId ?? 'native-status-committer', idempotencyKey: input.idempotencyKey,
  }).returning({ id: agentWakeupRequests.id });
  if (!inserted) throw new Error('native_status_wake_not_persisted');
  return inserted.id;
}
