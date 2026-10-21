/** PER-1120: availability is not action-outcome evidence. These decisions only
 * start a new evidence-inspecting turn through native admission, never replay.
 * No Paperclip event/output timestamp participates in session liveness. */
export const BOARD_RECOVERY_LIMIT = 3;
export const BOARD_RECOVERY_REASON = 'paperclip_board_reconcile';
export const IDLE_LIMIT_MS = 10 * 60_000;
export const STALE_RUN_MS = 20 * 60_000;
const MAX_OBSERVATION_GAP_MS = 6 * 60_000;
const RETRY_CODES = new Set([
  'omnigent_dispatch_evidence_timeout', 'dispatch_evidence_timeout',
  'setup_failed', 'omnigent_session_not_recovered', 'session_not_recovered',
  'omnigent_session_failed', 'session_failed', 'omnigent_empty_turn', 'empty_turn',
  'omnigent_rotation_not_ready', 'rotation_not_ready', 'omnigent_turn_failed',
  'omnigent_unreachable', 'omnigent_host_offline', 'timeout', 'server_shutdown_interrupted',
]);
const NEEDS_PERSON = /auth|(?:^|[^0-9])40[13](?:$|[^0-9])|login|credential|permission|forbidden|quota|budget|restore_unsafe_archive/i;
export type IdleObservation = { sessionId:string; fingerprint:string; firstSeenAt:number; lastSeenAt:number };
export type SessionEvidence = { id:string; fingerprint:string; idle:boolean; absent?:boolean };
export function observeIdle(previous:IdleObservation|null, session:SessionEvidence|null, now:number) {
  if (!session?.idle) return { observation:null, confirmed:false };
  const continuous = previous && previous.sessionId === session.id && previous.fingerprint === session.fingerprint &&
    Number.isFinite(previous.firstSeenAt) && Number.isFinite(previous.lastSeenAt) &&
    previous.firstSeenAt <= previous.lastSeenAt && previous.lastSeenAt <= now &&
    now - previous.lastSeenAt <= MAX_OBSERVATION_GAP_MS;
  const observation:IdleObservation = { sessionId:session.id, fingerprint:session.fingerprint,
    firstSeenAt:continuous ? previous.firstSeenAt : now, lastSeenAt:now };
  return { observation, confirmed:now-observation.firstSeenAt >= IDLE_LIMIT_MS };
}
export type SweepInput = { now:number; issueStatus:string; runStatus:string; errorCode:string|null; error:string|null;
  finishedAt:number|null; runUpdatedAt:number|null; idleConfirmed:boolean; sessionBusy:boolean; hold:string|null; attempts:number; lastAttemptAt:number|null };
export function boardRecoveryDecision(input:SweepInput) {
  if (input.hold || !['todo','in_progress'].includes(input.issueStatus)) return 'held';
  if (input.sessionBusy || !input.idleConfirmed) return 'observe';
  // Run age is an additional admission gate, NOT proof of provider idleness.
  // Busy/newest-session evidence above always wins, including for Codex runs
  // that emit no Paperclip events. Unknown/future timestamps fail closed.
  if (input.runStatus === 'running' && (input.runUpdatedAt === null ||
      !Number.isFinite(input.runUpdatedAt) || input.now - input.runUpdatedAt <= STALE_RUN_MS)) return 'observe';
  if (input.runStatus === 'queued') return 'held';
  if (input.error && NEEDS_PERSON.test(input.error)) return 'manual';
  if (input.attempts >= BOARD_RECOVERY_LIMIT) return 'exhausted';
  const backoff = 5*60_000 * 2**Math.min(input.attempts,BOARD_RECOVERY_LIMIT);
  const backoffFrom = input.lastAttemptAt ?? input.finishedAt;
  if (backoffFrom !== null && input.now-backoffFrom < backoff) return 'backoff';
  if (input.runStatus === 'running') return 'retire_observer';
  if (['failed','timed_out','interrupted'].includes(input.runStatus) && RETRY_CODES.has(input.errorCode ?? '')) return 'retry_failed';
  if (input.runStatus === 'succeeded') return 'monitor';
  return 'held';
}

export function retainedBoardSession(result:Record<string,unknown>|null, now=Date.now(), expectedKind='retry_failed') {
  const state=result?.boardRecovery as {kind?:string;observation?:IdleObservation}|undefined;
  const observation=state?.observation;
  if(state?.kind!==expectedKind || !observation || observation.sessionId==='absent' || !observation.sessionId ||
    !/^[a-f0-9]{64}$/.test(observation.fingerprint) || !Number.isFinite(observation.firstSeenAt) || !Number.isFinite(observation.lastSeenAt) ||
    observation.lastSeenAt-observation.firstSeenAt<IDLE_LIMIT_MS || observation.lastSeenAt>now || now-observation.lastSeenAt>MAX_OBSERVATION_GAP_MS) return null;
  return observation.sessionId;
}
export function validBoardRetainedSession(value:unknown,binding:{runId:string;companyId:string;agentId:string;issueId:string}) {
  if(!value || typeof value!=='object' || Array.isArray(value)) return false;
  const marker=value as Record<string,unknown>;
  return marker.version===1 && Object.entries(binding).every(([key,v])=>marker[key]===v) &&
    typeof marker.sessionId==='string' && !!marker.sessionId && marker.sessionId!=='absent';
}
