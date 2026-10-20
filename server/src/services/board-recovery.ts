import { budgetService } from './budgets.js';
import { parseIssueExecutionState } from './issue-execution-policy.js';
import { readChatControlRecoveryStop } from './chat-control-recovery-stop.js';
import { isPluginManagedIssueLifecycle } from './recovery/successful-run-handoff.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { agents, heartbeatRuns, issues, agentWakeupRequests, issueThreadInteractions, agentTaskSessions, routines, type Db } from '@paperclipai/db';
import { boardRecoveryDecision, observeIdle, BOARD_RECOVERY_REASON, BOARD_RECOVERY_LIMIT, type IdleObservation } from './board-recovery-policy.js';
import { probeNewestIssueSession } from './omnigent-issue-session.js';
import { validOmnigentReceipt } from './omnigent-attachment.js';
import { getExecutionBlocker } from './execution-blocker.js';
import { issueService } from './issues.js';
import { issueTreeControlService } from './issue-tree-control.js';
import { issueRecoveryActionService } from './issue-recovery-actions.js';
import { logActivity } from './activity-log.js';
type Run = typeof heartbeatRuns.$inferSelect;
export type BoardRecoveryDeps = {
  resolveConfig:(companyId:string,config:Record<string,unknown>)=>Promise<Record<string,unknown>>;
  wake:(agentId:string,issueId:string,sourceRunId:string,statusVersion:number)=>Promise<unknown>;
  release:(run:Run)=>Promise<void>;
  resumeSuccessful:(runId:string)=>Promise<string>;
  request?:typeof fetch;
  now?:number;
  dryRun?:boolean;
};
/** Cluster scheduler entry point. Native recovery resolution, monitor dispatch
 * and wake admission remain the authorities. This method never calls provider
 * cancel/interrupt/retry/archive and never clears a workspace or human hold. */
export async function checkBoardRecovery(db:Db, issueId:string, deps:BoardRecoveryDeps) {
  const now=deps.now ?? Date.now();
  const [issue]=await db.select().from(issues).where(eq(issues.id,issueId)).limit(1);
  if(!issue?.assigneeAgentId || issue.hiddenAt || issue.assigneeUserId || !['todo','in_progress','blocked'].includes(issue.status)) return {status:'held'};
  const [agent]=await db.select().from(agents).where(and(eq(agents.id,issue.assigneeAgentId),eq(agents.companyId,issue.companyId))).limit(1);
  if(!agent || agent.adapterType!=='omnigent' || ['paused','terminated','error','pending_approval'].includes(agent.status) || agent.pauseReason || issue.conversationAgentId) return {status:'held'};
  const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,issue.companyId),eq(heartbeatRuns.agentId,agent.id),
    sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId',${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`)).orderBy(desc(heartbeatRuns.createdAt),desc(heartbeatRuns.id)).limit(1);
  if(!run || run.runtimeMode!=='legacy' || (run.scheduledRetryAt && run.scheduledRetryAt.getTime()>now-300000) || (issue.executionRunId && issue.executionRunId!==run.id) || (issue.checkoutRunId && issue.checkoutRunId!==run.id)) return {status:'held'};
  if(!deps.dryRun) await db.update(heartbeatRuns).set({resultJson:sql`coalesce(${heartbeatRuns.resultJson},'{}'::jsonb) || jsonb_build_object('boardRecovery',coalesce(${heartbeatRuns.resultJson}->'boardRecovery','{}'::jsonb) || jsonb_build_object('checkedAt',${now}::bigint))`}).where(eq(heartbeatRuns.id,run.id));
  if(issue.monitorNextCheckAt || await issueTreeControlService(db).getActivePauseHoldGate(issue.companyId,issueId)) return {status:'held'};
  if(isPluginManagedIssueLifecycle(issue) || parseIssueExecutionState(issue.executionState)?.status==='pending' ||
    run.contextSnapshot?.goalControlRequestId || run.contextSnapshot?.resumeSessionGoalHeartbeat===true ||
    (await readChatControlRecoveryStop(db,{companyId:issue.companyId,issueId,agentId:agent.id,sourceRunId:run.id})).kind!=='clear' ||
    await budgetService(db).getInvocationBlock(issue.companyId,agent.id,{issueId,projectId:issue.projectId})) return {status:'held'};
  const [goal]=await db.select({status:agentTaskSessions.goalStatus}).from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId,issue.companyId),eq(agentTaskSessions.agentId,agent.id),eq(agentTaskSessions.taskKey,issueId))).limit(1);
  const [routine]=await db.select({id:routines.id}).from(routines).where(and(eq(routines.companyId,issue.companyId),eq(routines.parentIssueId,issueId),eq(routines.status,'active'))).limit(1);
  if((goal?.status && goal.status!=='complete') || routine) return {status:'held'};
  const readiness=await issueService(db).getDependencyReadiness(issueId);
  if(readiness.unresolvedBlockerCount>0) return {status:'held'};
  const [pending]=await db.select({id:issueThreadInteractions.id}).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId,issue.companyId),eq(issueThreadInteractions.issueId,issueId),eq(issueThreadInteractions.status,'pending'))).limit(1);
  if(pending) return {status:'held'};
  const blocker=await getExecutionBlocker(db,issue.companyId,issueId);
  if(blocker && (blocker.cause!=='legacy_execution_requires_reconciliation' || blocker.runId!==run.id)) return {status:'held'};
  if(issue.status==='blocked' && !blocker) return {status:'held'};
  const action=await issueRecoveryActionService(db).getActiveForIssue(issue.companyId,issueId);
  if((action?.evidence?.recoveryBudget as Record<string,unknown>|undefined)?.state==='exhausted') return {status:'held',reason:'native_recovery_exhausted'};
  if(action && !blocker && !(run.status==='succeeded' && action.kind==='deliberate_wait_without_target' && action.ownerType==='agent')) return {status:'held',reason:'native_recovery_owns_continuation'};
  if(run.resultJson?.workspaceRestoreFailure) return {status:'held'};
  // Existing native timers/recoveries own the continuation; do not compete.
  const [queued]=await db.select({id:agentWakeupRequests.id}).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,issue.companyId),eq(agentWakeupRequests.agentId,agent.id),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,inArray(agentWakeupRequests.status,['queued','deferred_issue_execution']),
    sql`coalesce(${agentWakeupRequests.reason},'') != ${BOARD_RECOVERY_REASON}`)).limit(1);
  if(queued) return {status:'held'};
  const config=await deps.resolveConfig(issue.companyId,agent.adapterConfig);
  const session=await probeNewestIssueSession({companyId:issue.companyId,agentId:agent.id,issueId},config,deps.request);
  const previous=run.resultJson?.boardRecovery as {observation?:IdleObservation;attemptAt?:number;kind?:string}|undefined;
  const observed=observeIdle(previous?.observation ?? null,session,now);
  if(!deps.dryRun) await db.update(heartbeatRuns).set({resultJson:sql`coalesce(${heartbeatRuns.resultJson},'{}'::jsonb) || jsonb_build_object('boardRecovery',coalesce(${heartbeatRuns.resultJson}->'boardRecovery','{}'::jsonb) || ${JSON.stringify({observation:observed.observation})}::jsonb)`})
    .where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.status,run.status)));
  const [budget]=await db.select({attempts:sql<number>`count(*)`,last:sql<number|null>`max((${heartbeatRuns.resultJson}->'boardRecovery'->>'attemptAt')::bigint)`}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,issue.companyId),
    sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId',${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`,
    sql`(${heartbeatRuns.resultJson}->'boardRecovery'->>'attemptAt')::bigint > ${now-86400000}`));
  let decision=boardRecoveryDecision({now,issueStatus:blocker?'todo':issue.status,runStatus:run.status,errorCode:run.errorCode,error:run.error,
    finishedAt:run.finishedAt?.getTime() ?? null,idleConfirmed:observed.confirmed,sessionBusy:!!session && !session.idle,hold:null,
    attempts:Math.max(Number(budget.attempts),run.scheduledRetryAttempt)-(previous?.attemptAt && previous.attemptAt>now-86400000?1:0),lastAttemptAt:previous?.attemptAt && previous.attemptAt>now-86400000 ? null : budget.last===null ? null : Number(budget.last)});
  const bootstrap=run.resultJson?.executionRecovery as Record<string,unknown>|undefined;
  if(session?.absent && observed.confirmed && !(run.errorCode==='setup_failed' && bootstrap?.kind==='bootstrap' && bootstrap.providerWorkStarted===false)) decision='manual';
  const result={status:decision,issueId,agentId:agent.id,runId:run.id,sessionId:session?.id ?? null};
  if(['held','observe','backoff'].includes(decision)) return result;
  if(deps.dryRun) return {...result,status:'would_'+decision};
  if(decision==='exhausted' || decision==='manual') {
    // Durable native board-owned notice: no automatic timer or new model turn.
    const reason=session?.absent ? 'No current ticket-labeled session was found and the dispatch outcome is not proven. Inspect retained run evidence and actual targets, then use Retry after the cause is fixed.' : decision==='exhausted' ? `Automatic recovery stopped after ${BOARD_RECOVERY_LIMIT} attempts on this ticket in 24 hours. Check the session and last failure, fix the cause, then use Retry.` : 'Automatic recovery stopped because the failure needs access, credentials, budget, or workspace repair. Fix the recorded cause, then use Retry.';
    let escalated=false;
    await db.transaction(async tx=> {
      const [owned]=await tx.select().from(issues).where(and(eq(issues.id,issueId),eq(issues.companyId,issue.companyId))).for('update');
      if(!owned || owned.statusVersion!==issue.statusVersion || owned.assigneeAgentId!==agent.id || !['todo','in_progress','blocked'].includes(owned.status)) return;
      const active=await issueRecoveryActionService(tx as unknown as Db).getActiveForIssue(issue.companyId,issueId);
      // Never replace a newer recovery identity or a new human/dependency wait.
      if(active && active.id!==action?.id) return;
      const [waiting]=await tx.select({id:issueThreadInteractions.id}).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId,issue.companyId),eq(issueThreadInteractions.issueId,issueId),eq(issueThreadInteractions.status,'pending'))).limit(1);
      if(waiting || (await issueService(tx as unknown as Db).getDependencyReadiness(issueId)).unresolvedBlockerCount>0) return;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({companyId:issue.companyId,sourceIssueId:issueId,kind:'active_run_watchdog',ownerType:'board',returnOwnerAgentId:agent.id,
        cause:active?.cause ?? 'automatic_board_recovery_requires_review',fingerprint:active?.fingerprint ?? 'board-recovery:'+run.id,
        evidence:{...(active?.evidence ?? {}),runId:run.id,sessionId:session?.id,recoveryBudget:{state:'exhausted'},reason},
        nextAction:reason,attemptCount:BOARD_RECOVERY_LIMIT,maxAttempts:BOARD_RECOVERY_LIMIT,wakePolicy:{type:'board_escalation'},monitorPolicy:null,preserveExistingOwner:false});
      await tx.update(issues).set({status:'blocked',statusVersion:sql`${issues.statusVersion}+1`,blockedTransitionAt:new Date(now),updatedAt:new Date(now)}).where(eq(issues.id,issueId));
      escalated=true;
    });
    if(escalated) await logActivity(db,{companyId:issue.companyId,actorType:'system',actorId:BOARD_RECOVERY_REASON,action:'issue.board_recovery_exhausted',entityType:'issue',entityId:issueId,details:{sourceRunId:run.id,reason}});
    return {...result,status:escalated?decision:'held',reason};
  }
  if(!session?.idle || !observed.confirmed) return {status:'observe'};
  const key=`board-recovery:${issueId}:${run.id}`;
  // Record before effects. Repeated/lost requests reuse the exact source key;
  // source attempts, not HTTP request counts, consume the ticket-wide budget.
  await db.update(heartbeatRuns).set({resultJson:sql`coalesce(${heartbeatRuns.resultJson},'{}'::jsonb) || jsonb_build_object('boardRecovery',coalesce(${heartbeatRuns.resultJson}->'boardRecovery','{}'::jsonb) || ${JSON.stringify({attemptAt:previous?.attemptAt ?? now,kind:decision,idempotencyKey:key})}::jsonb)`})
    .where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.status,run.status)));
  if(decision==='retry_failed' && !blocker) {
    await deps.wake(agent.id,issueId,run.id,issue.statusVersion);
    await logActivity(db,{companyId:issue.companyId,actorType:'system',actorId:BOARD_RECOVERY_REASON,action:'issue.board_recovery_retry_requested',entityType:'issue',entityId:issueId,details:{sourceRunId:run.id}});
    return {...result,status:'native_retry_requested'};
  }
  if(decision==='retry_failed') return {...result,recoveryActionId:blocker?.recoveryActionId ?? null,idempotencyKey:key,
    evidence:`Newest ticket-labeled OmniGenT session ${session.id} is idle with a stable transcript for at least ten minutes. Earlier action outcomes may be mixed; inspect retained session and actual targets before repeating mutations. No provider was interrupted or archived.`};
  if(decision==='monitor') {
    const outcome=await deps.resumeSuccessful(run.id);
    if(outcome==='queued') await logActivity(db,{companyId:issue.companyId,actorType:'system',actorId:BOARD_RECOVERY_REASON,action:'issue.board_recovery_continuation_requested',entityType:'issue',entityId:issueId,details:{sourceRunId:run.id}});
    return {...result,status:'native_continuation_'+outcome};
  }
  if(!validOmnigentReceipt(run,run.resultJson?.omnigentDispatchReceipt)) return {...result,status:'held',reason:'missing_dispatch_receipt'};
  await deps.wake(agent.id,issueId,run.id,issue.statusVersion);
  // Native wake admission must have retained a real continuation before revoke.
  const [continuation]=await db.select({id:agentWakeupRequests.id}).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,issue.companyId),eq(agentWakeupRequests.agentId,agent.id),eq(agentWakeupRequests.idempotencyKey,key),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,inArray(agentWakeupRequests.status,['queued','deferred_issue_execution']))).limit(1);
  if(!continuation) return {...result,status:'held',reason:'native_admission_hold'};
  // Fresh current-session check after wake admission. Busy work never authorizes
  // retirement; even a race after this read cannot stop the provider.
  const fresh=await probeNewestIssueSession({companyId:issue.companyId,agentId:agent.id,issueId},config,deps.request);
  if(!fresh?.idle || fresh.id!==session.id || fresh.fingerprint!==session.fingerprint) return {...result,status:'observe'};
  let retired:Run|undefined;
  await db.transaction(async tx=> {
    const [owned]=await tx.select().from(issues).where(and(eq(issues.id,issueId),eq(issues.companyId,issue.companyId))).for('update');
    if(!owned || owned.assigneeAgentId!==agent.id || !['todo','in_progress'].includes(owned.status) || (owned.executionRunId && owned.executionRunId!==run.id) || (owned.checkoutRunId && owned.checkoutRunId!==run.id)) return;
    [retired]=await tx.update(heartbeatRuns).set({status:'interrupted',errorCode:'omnigent_observer_retired',error:'Idle observer retired for same-session continuation; prior action outcomes remain unknown.',finishedAt:new Date(now),controllerLeaseExpiresAt:new Date(now),controllerBootId:sql`gen_random_uuid()`,updatedAt:new Date(now),
      resultJson:sql`coalesce(${heartbeatRuns.resultJson},'{}'::jsonb) || ${JSON.stringify({omnigentObserverRetirement:{version:1,runId:run.id,companyId:run.companyId,agentId:run.agentId,issueId,
        omnigentSessionId:(run.resultJson?.omnigentDispatchReceipt as Record<string,unknown>).omnigentSessionId,retiredAt:new Date(now).toISOString(),reason:'stable_issue_session_idle',currentSessionId:session.id,
        firstIdleObservedAt:observed.observation?.firstSeenAt,lastIdleObservedAt:now,sessionFingerprint:session.fingerprint,actionOutcomes:'unknown',providerStopped:false},summary:'An idle observer was retired for a same-session continuation. Prior action outcomes are unknown. Inspect retained evidence and actual targets before repeating any mutation.'})}::jsonb`})
      .where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.status,'running'),eq(heartbeatRuns.controllerBootId,run.controllerBootId!),
        sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt' = ${JSON.stringify(run.resultJson?.omnigentDispatchReceipt)}::jsonb`)).returning();
    if(retired?.wakeupRequestId) await tx.update(agentWakeupRequests).set({status:'failed',finishedAt:new Date(now),error:'Idle observer retired; provider preserved, prior action outcomes unknown.',updatedAt:new Date(now)})
      .where(and(eq(agentWakeupRequests.id,retired.wakeupRequestId),eq(agentWakeupRequests.companyId,issue.companyId)));
  });
  if(retired) {
    await deps.release(retired);
    await logActivity(db,{companyId:issue.companyId,actorType:'system',actorId:BOARD_RECOVERY_REASON,action:'issue.board_recovery_repaired',entityType:'issue',entityId:issueId,details:{sourceRunId:run.id,kind:decision,sessionId:session.id,providerStopped:false}});
  }
  return {...result,status:retired?'observer_retired':'held'};
}
