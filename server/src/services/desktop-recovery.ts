import { enqueueNativeStatusWakeIntent } from './native-runtime/status-wake-intents.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@paperclipai/db';
import { issues } from '@paperclipai/db/schema/issues';
import { agents } from '@paperclipai/db/schema/agents';
import { companies } from '@paperclipai/db/schema/companies';
import { activityLog } from '@paperclipai/db/schema/activity_log';

import type { DesktopRecoveryRequest, DesktopRecoveryTarget } from '../routes/desktop-recovery.js';
import { conflict, forbidden } from '../errors.js';
import { desktopBlockedTransition } from './desktop-recovery-eligibility.js';
import type { ActivityPublication } from './activity-log.js';
import type { IssuePostCommitAction } from './issues.js';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type NativeHooks = {
  updateIssue: (tx: Transaction, id: string, data: Record<string, unknown>, publications: ActivityPublication[], actions: IssuePostCommitAction[]) => Promise<any>;
  addComment: (tx: Transaction, id: string, text: string) => Promise<{ id: string }>;
  afterCommit: (publications: ActivityPublication[], actions: IssuePostCommitAction[]) => Promise<void>;
  isSuppressed: () => boolean | Promise<boolean>;
  onClosed?: (tx: Transaction, issue: typeof issues.$inferSelect) => Promise<void>;
  dependencyReady?: (tx: Transaction, companyId: string, issueId: string) => Promise<boolean>;
};
const readyEvidence = (ready: NonNullable<DesktopRecoveryRequest['ready']>) => ({ recoveryId:ready.recoveryId, batch:ready.batch, podUid:ready.podUid });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function nativeHooks(db: Db): Promise<NativeHooks> {
  const [{ issueService, executeIssuePostCommitActions }, { publishActivity }, { resolveHeartbeatSchedulingSuppression }] = await Promise.all([
    import('./issues.js'), import('./activity-log.js'), import('./heartbeat.js'),
  ]);
  return {
    // Construct against the transaction: internal reads must not escape to the outer pool.
    updateIssue: (tx, id, data, publications, actions) => issueService(tx as unknown as Db).update(id, data, tx, publications, actions),
    addComment: (tx, id, text) => issueService(tx as unknown as Db).addComment(id, text, {}, { authorType: 'system' }, tx),
    dependencyReady: async (tx, companyId, issueId) => (await issueService(tx as unknown as Db).listDependencyReadiness(companyId,[issueId],tx)).get(issueId)?.isDependencyReady === true,
    onClosed: async (tx, issue) => {
      const svc = issueService(tx as unknown as Db);
      const dependents = await svc.listWakeableBlockedDependents(issue.id);
      const parent = issue.parentId ? await svc.getWakeableParentAfterChildCompletion(issue.parentId) : null;
      const { buildIssueBlockersResolvedWakeIdempotencyKey } = await import('./issue-dependency-wakeups.js');
      for (const dependent of dependents) {
        await enqueueNativeStatusWakeIntent({ tx: tx as unknown as Db, companyId: issue.companyId,
          issueId: dependent.id, agentId: dependent.assigneeAgentId, reason: 'issue_blockers_resolved',
          idempotencyKey: buildIssueBlockersResolvedWakeIdempotencyKey({dependentIssueId:dependent.id,resolvedBlockerIssueId:issue.id}),
          payload: {resolvedBlockerIssueId:issue.id,blockerIssueIds:dependent.blockerIssueIds},
        });
      }
      if (parent && !dependents.some(dependent => dependent.id === parent.id)) {
        await enqueueNativeStatusWakeIntent({ tx: tx as unknown as Db, companyId: issue.companyId,
          issueId: parent.id, agentId: parent.assigneeAgentId, reason: 'issue_children_completed',
          idempotencyKey: `issue_children_completed:${parent.id}:${issue.id}`,
          payload: {completedChildIssueId:issue.id,childIssueIds:parent.childIssueIds,childIssueSummaries:parent.childIssueSummaries},
        });
      }
    },
    afterCommit: async (publications, actions) => {
      for (const publication of publications) publishActivity(publication);
      await executeIssuePostCommitActions(db, actions);
      const { heartbeatService } = await import('./heartbeat.js');
      await heartbeatService(db).dispatchPendingNativeStatusWakeups();
    },
    isSuppressed: () => resolveHeartbeatSchedulingSuppression().suppressed,
  };
}

/** Native transaction owner; no HTTP PATCH, production fixtures or command replay. */
export function desktopRecoveryService(db: Db, testHooks?: NativeHooks) {
  return async (request: DesktopRecoveryRequest, target: DesktopRecoveryTarget, resumeEnabled: boolean) => {
    const hooks = testHooks ?? await nativeHooks(db);
    const publications: ActivityPublication[] = [];
    const actions: IssuePostCommitAction[] = [];
    const response = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '15s'`);
      // Parent row locks fence FK-backed inserts, not just the rows already present.
      // This bounded per-company fence is conservative; replace with a shared native
      // governance lock protocol if recovery throughput ever requires finer admission.
      const [company] = await tx.select().from(companies).where(eq(companies.id, target.companyId)).for('update');
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, target.agentId), eq(agents.companyId, target.companyId))).for('update');
      if (!company || !agent) throw forbidden('Recovery target is not registered');
      const [incidentTarget] = await tx.select().from(issues).where(and(eq(issues.id, target.incidentIssueId), eq(issues.companyId, target.companyId))).for('update');
      if (!incidentTarget) throw forbidden('Incident target does not belong to this company');
      if (request.ready) {
        const readyKey = digest({ agent: request.agent, desktop: request.desktop, recoveryId: request.ready.recoveryId });
        const readyDigest = digest(readyEvidence(request.ready));
        const [priorReady] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.action, 'desktop_recovery.ready_receipt'), eq(activityLog.entityId, readyKey))).limit(1);
        if (priorReady && priorReady.details?.readyDigest !== readyDigest) throw conflict('Recovery identity was already used for different Ready evidence');
        if (!priorReady) await tx.insert(activityLog).values({ companyId: target.companyId, actorType: 'system', actorId: 'desktop-recovery', action: 'desktop_recovery.ready_receipt', entityType: 'desktop_recovery', entityId: readyKey,
          details: { readyDigest, agent: request.agent, desktop: request.desktop, recoveryId: request.ready.recoveryId, ready: request.ready } });
      }
      const notifications: Array<Record<string, unknown>> = [];
      for (const incident of request.incidents) {
        const identity = { agent: request.agent, desktop: request.desktop, incidentId: incident.id };
        const key = digest(identity), payloadDigest = digest(incident);
        const existing = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.action, 'desktop_recovery.incident_receipt'), eq(activityLog.entityId, key))).limit(1);
        if (existing[0]) {
          if (existing[0].details?.payloadDigest !== payloadDigest) throw conflict('Incident identity was already used for different evidence');
          notifications.push(existing[0].details!.receipt as Record<string, unknown>);
          continue;
        }
        const comment = await hooks.addComment(tx, incidentTarget.id,
          `Desktop recovery: ${request.agent} / ${request.desktop}. ${incident.reason} Observed Unix time ${incident.time}. Object ${incident.involvedObject.kind} ${incident.involvedObject.namespace}/${incident.involvedObject.name} UID ${incident.involvedObject.uid}. Incident ${incident.id}.`);
        const receipt = { id: incident.id, issueId: incidentTarget.id, commentId: comment.id };
        await tx.insert(activityLog).values({ companyId: target.companyId, actorType: 'system', actorId: 'desktop-recovery', action: 'desktop_recovery.incident_receipt', entityType: 'desktop_recovery', entityId: key, details: { ...identity, payloadDigest, receipt } });
        notifications.push(receipt);
      }
      const resumes: Array<Record<string, unknown>> = [];
      if (request.ready && resumeEnabled && company.status === 'active' && !company.pausedAt && !agent.pausedAt && ['idle','running','error'].includes(agent.status) && !await hooks.isSuppressed()) {
        const recoveryKey = digest({ agent: request.agent, desktop: request.desktop, recoveryId: request.ready.recoveryId });
        const prior = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.action, 'desktop_recovery.resume_receipt'), sql`${activityLog.details}->>'recoveryKey' = ${recoveryKey}`)).orderBy(asc(activityLog.id));
        const readyDigest = digest(readyEvidence(request.ready));
        for (const row of prior) {
          if (row.details?.readyDigest !== readyDigest) throw conflict('Recovery identity was already used for different Ready evidence');
          resumes.push(row.details!.receipt as Record<string, unknown>);
        }
        // ponytail: company-wide issue fence; finer native admission locks can
        // replace it only after their concurrent-writer protocol is proven.
        const companyIssues = await tx.select().from(issues).where(eq(issues.companyId, target.companyId)).orderBy(asc(issues.id)).for('update');
        const candidates = companyIssues.filter(issue => issue.assigneeAgentId === target.agentId && issue.status === 'blocked').sort((a,b) => Number(target.restoreOnlyIssueIds?.includes(b.id) ?? false)-Number(target.restoreOnlyIssueIds?.includes(a.id) ?? false));
        const now = new Date();
        for (const issue of candidates) {
          const history = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.entityType, 'issue'), eq(activityLog.entityId, issue.id), eq(activityLog.action, 'issue.updated'))).orderBy(desc(activityLog.createdAt), desc(activityLog.id));
          const transition = desktopBlockedTransition(issue, history, target.agentId, now);
          if (!transition || issue.executionState?.status === 'pending') continue;
          if (request.ready.observedAt === undefined || request.ready.observedAt < Date.now()/1000 - 60 || request.ready.observedAt > Date.now()/1000 + 5 || issue.blockedTransitionAt!.getTime() > request.ready.observedAt * 1000) continue;
          if (hooks.dependencyReady && !await hooks.dependencyReady(tx,target.companyId,issue.id)) continue;
          // Lock existing gates as well as their FK parents. New rows cannot cross
          // the company/issue/agent fence; changed existing rows are re-read here.
          // A blocked dependency is never cleared by this operation.
          for (const table of ['issue_thread_interactions','tool_action_requests','approvals','issue_approvals','issue_relations','issue_recovery_actions','issue_tree_holds','issue_tree_hold_members','heartbeat_runs','agent_wakeup_requests','workspace_operations','native_run_finalizations']) {
            const keyColumn = table === 'issue_approvals' ? 'issue_id' : table === 'native_run_finalizations' ? 'run_id' : 'id';
            await tx.execute(sql`select 1 from ${sql.identifier(table)} where company_id=${target.companyId} order by ${sql.identifier(keyColumn)} for update`);
          }
          // Gate only the held issue or its ancestors, not unrelated company work.
          const gates = await tx.execute(sql`select 1 where
            exists(select 1 from issue_thread_interactions where company_id=${target.companyId} and issue_id=${issue.id} and status='pending') or
            exists(select 1 from tool_action_requests where company_id=${target.companyId} and issue_id=${issue.id} and status in ('pending','approved','executing')) or
            exists(select 1 from issue_approvals ia left join approvals a on a.id=ia.approval_id and a.company_id=ia.company_id where ia.company_id=${target.companyId} and ia.issue_id=${issue.id} and (a.id is null or a.status not in ('approved','rejected','cancelled'))) or
            exists(select 1 from issue_relations r left join issues b on b.id=r.issue_id and b.company_id=r.company_id where r.company_id=${target.companyId} and r.related_issue_id=${issue.id} and r.type='blocks' and (b.id is null or b.status <> 'done' or (${!hooks.dependencyReady} and b.execution_workspace_id is not null))) or
            exists(select 1 from issue_recovery_actions where company_id=${target.companyId} and (source_issue_id=${issue.id} or recovery_issue_id=${issue.id}) and (status in ('active','escalated') or evidence->'automaticRecovery'->>'replay'='blocked')) or
            exists(with recursive ancestors as (
              select id,parent_id,array[id] as path from issues where id=${issue.id} and company_id=${target.companyId}
              union all select p.id,p.parent_id,a.path||p.id from issues p join ancestors a on p.id=a.parent_id
                where p.company_id=${target.companyId} and not p.id=any(a.path)
            ) select 1 from issue_tree_holds h where h.company_id=${target.companyId} and h.status='active'
              and (h.root_issue_id in (select id from ancestors) or exists(select 1 from issue_tree_hold_members m
                where m.company_id=h.company_id and m.hold_id=h.id and m.issue_id=${issue.id} and not m.skipped))) or
            exists(select 1 from heartbeat_runs where company_id=${target.companyId} and status in ('queued','running','scheduled_retry','waiting') and (native_issue_id=${issue.id} or context_snapshot->>'issueId'=${issue.id} or context_snapshot->>'taskId'=${issue.id})) or
            exists(select 1 from agent_wakeup_requests where company_id=${target.companyId} and status in ('queued','claimed','deferred_issue_execution') and coalesce(payload->>'issueId',payload->>'taskId',payload->'_paperclipWakeContext'->>'issueId')=${issue.id}) or
            exists(select 1 from workspace_operations where company_id=${target.companyId} and issue_id=${issue.id} and status='running') or
            exists(select 1 from native_run_finalizations where company_id=${target.companyId} and issue_id=${issue.id} and phase <> 'committed')`);
          if ((Array.isArray(gates) ? gates : (gates as unknown as { rows: unknown[] }).rows).length || await hooks.isSuppressed()) continue;
          const transitionKey = digest({ issueId: issue.id, ...transition });
          const duplicate = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.action, 'desktop_recovery.resume_receipt'), sql`${activityLog.details}->>'transitionKey' = ${transitionKey}`)).limit(1);
          if (duplicate.length) continue;
          const close = Boolean(issue.parentId && target.restoreOnlyIssueIds?.includes(issue.id));
          const updated = await hooks.updateIssue(tx, issue.id, { status: close ? 'done' : 'todo', companyGuard: target.companyId }, publications, actions);
          if (!updated) throw conflict('Issue changed during recovery');
          if (close) await hooks.onClosed?.(tx,issue);
          const wakeRequestId = close ? null : await enqueueNativeStatusWakeIntent({ tx: tx as unknown as Db, companyId: target.companyId, agentId: target.agentId, issueId: issue.id,
            actorId: 'desktop-recovery', reason: 'desktop_recovered', idempotencyKey: `desktop-recovery:${transitionKey}`,
            payload: { recoveryId: request.ready.recoveryId, blockedTransition: transition,
              desktopRecoveryGuard: { assigneeAgentId: target.agentId, statuses: ['todo'], statusVersion: updated.statusVersion } },
            contextSnapshot: { recoveryId: request.ready.recoveryId,
              instruction: 'Desktop access is restored. Before any command replay with an unknown outcome, read its execution status and target. Preserve all approvals and blockers.' },
          });
          const receipt = { issueId: issue.id, ...transition, blockedTransitionId: transition.transitionId, receiptId: randomUUID(), outcome: close ? 'closed' : 'resumed', wakeRequestId, recoveryId: request.ready.recoveryId };
          await tx.insert(activityLog).values({ companyId: target.companyId, actorType: 'system', actorId: 'desktop-recovery', action: 'issue.updated', entityType: 'issue', entityId: issue.id,
            details: { source: 'desktop_recovery', changes: updated.changes, recoveryId: request.ready.recoveryId, wakeRequestId } });
          await tx.insert(activityLog).values({ id: receipt.receiptId, companyId: target.companyId, actorType: 'system', actorId: 'desktop-recovery', action: 'desktop_recovery.resume_receipt', entityType: 'issue', entityId: issue.id,
            details: { recoveryKey, readyDigest, transitionKey, receipt } });
          resumes.push(receipt);
        }
      }
      resumes.sort((a,b) => String(a.issueId).localeCompare(String(b.issueId)));
      return { version: 1, agent: request.agent, desktop: request.desktop, recoveryId: request.ready?.recoveryId ?? null, notifications, resumes, resumeEnabled };
    });
    await hooks.afterCommit(publications, actions);
    return response;
  };
}
