import { describe, expect, it } from 'vitest';
import { boardRecoveryDecision, observeIdle, retainedBoardSession, validBoardRetainedSession, type SweepInput } from './board-recovery-policy.js';
const now = Date.parse('2026-10-20T22:00:00Z');
const base: SweepInput = { now, issueStatus:'in_progress', runStatus:'succeeded', errorCode:null, error:null,
  finishedAt:now-3600000, runUpdatedAt:now-3600000, idleConfirmed:true, sessionBusy:false, hold:null, attempts:0, lastAttemptAt:null };
describe('board recovery policy (PER-1120)', () => {
 it.each(['omnigent_dispatch_evidence_timeout','setup_failed','omnigent_session_not_recovered','omnigent_session_failed','omnigent_empty_turn','omnigent_rotation_not_ready'])('recovers the missing %s class only after actual session idle', code => {
  expect(boardRecoveryDecision({...base,runStatus:'failed',errorCode:code})).toBe('retry_failed');
  expect(boardRecoveryDecision({...base,runStatus:'failed',errorCode:code,idleConfirmed:false})).toBe('observe');
 });
 it('never uses silent run events as a liveness signal',()=> {
  expect(boardRecoveryDecision({...base,runStatus:'running',sessionBusy:true})).toBe('observe');
  expect(boardRecoveryDecision({...base,runStatus:'running',idleConfirmed:true})).toBe('retire_observer');
 });
 it('requires an idle provider AND more than twenty minutes without run updates',()=> {
  const running = {...base, runStatus:'running'};
  expect(boardRecoveryDecision({...running,runUpdatedAt:now-20*60000-1})).toBe('retire_observer');
  for (const runUpdatedAt of [now-20*60000,now-60000,now+1,null,Number.NaN]) {
   expect(boardRecoveryDecision({...running,runUpdatedAt})).toBe('observe');
  }
  expect(boardRecoveryDecision({...running,runUpdatedAt:now-15*60*60000,sessionBusy:true})).toBe('observe');
  expect(boardRecoveryDecision({...running,runUpdatedAt:now-15*60*60000,idleConfirmed:false})).toBe('observe');
 });
 it('observes orphan work and then repairs missing continuation',()=> {
  expect(boardRecoveryDecision({...base,sessionBusy:true})).toBe('observe');
  expect(boardRecoveryDecision(base)).toBe('monitor');
 });
 it.each(['interaction','dependency','review','monitor','scheduled_retry','pause','budget','execution_recovery','workspace','conversation'])('preserves %s holds', hold=> {
  expect(boardRecoveryDecision({...base,hold})).toBe('held');
 });
 it.each(['auth failed','HTTP 401','permission denied','quota exceeded','login required'])('does not retry %s', error=> {
  expect(boardRecoveryDecision({...base,runStatus:'failed',errorCode:'setup_failed',error})).toBe('manual');
 });
 it('bounds retries per ticket across failure classes with exponential backoff',()=> {
  expect(boardRecoveryDecision({...base,attempts:3})).toBe('exhausted');
  expect(boardRecoveryDecision({...base,attempts:2,lastAttemptAt:now-19*60000})).toBe('backoff');
  expect(boardRecoveryDecision({...base,attempts:2,lastAttemptAt:now-20*60000})).toBe('monitor');
 });
 it.each(['done','cancelled','backlog','blocked','in_review'])('never starts %s without explicit native recovery',issueStatus=> {
  expect(boardRecoveryDecision({...base,issueStatus})).toBe('held');
 });
 it('requires stable elapsed idle with continuous observations; no outage credit',()=> {
  const first=observeIdle(null,{id:'new',fingerprint:'tail-1',idle:true},now);
  expect(first.confirmed).toBe(false);
  const second=observeIdle(first.observation,{id:'new',fingerprint:'tail-1',idle:true},now+300000);
  expect(second.confirmed).toBe(false);
  expect(observeIdle(second.observation,{id:'new',fingerprint:'tail-1',idle:true},now+600000).confirmed).toBe(true);
  expect(observeIdle(first.observation,{id:'new',fingerprint:'tail-1',idle:true},now+600000).confirmed).toBe(false);
  expect(observeIdle(second.observation,{id:'newer',fingerprint:'tail-1',idle:true},now+600000).confirmed).toBe(false);
  expect(observeIdle(second.observation,{id:'new',fingerprint:'tail-2',idle:true},now+600000).confirmed).toBe(false);
  expect(observeIdle(second.observation,{id:'new',fingerprint:'tail-1',idle:false},now+600000).observation).toBeNull();
 });
});

describe('retained session continuation authority',()=>{
 it('allows a retained issue session only with recent server-observed idle proof',()=>{
  const result={boardRecovery:{kind:'retry_failed',observation:{sessionId:'new',fingerprint:'a'.repeat(64),firstSeenAt:now-600000,lastSeenAt:now}}};
  expect(retainedBoardSession(result,now)).toBe('new');
  expect(retainedBoardSession(result,now+360001)).toBeNull();
  expect(retainedBoardSession({boardRecovery:{...result.boardRecovery,kind:'monitor'}},now)).toBeNull();
  expect(retainedBoardSession({boardRecovery:{...result.boardRecovery,observation:{...result.boardRecovery.observation,sessionId:'absent'}}},now)).toBeNull();
 });
 it('does not accept a caller hint or foreign recovery binding',()=>{
  const binding={runId:'run',companyId:'co',agentId:'agent',issueId:'issue'};
  expect(validBoardRetainedSession({version:1,...binding,sessionId:'new'},binding)).toBe(true);
  expect(validBoardRetainedSession({version:1,...binding,agentId:'foreign',sessionId:'new'},binding)).toBe(false);
  expect(validBoardRetainedSession({forceFreshSession:false},binding)).toBe(false);
 });
});
