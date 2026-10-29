import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, environmentLeases, nativeRunFinalizations, issues, issueComments, issueRecoveryActions, issueThreadInteractions, approvals, issueApprovals, issueRelations } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "../services/heartbeat/queue.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.js";

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const preparation = createHeartbeatRunPreparation(db);
  return {
    ...preparation,
    ...state,
    getAgent: vi.fn<HeartbeatQueueDependencies["getAgent"]>(async () => { throw new Error("Unexpected agent lookup"); }),
    options: {},
    setRunStatus: vi.fn<HeartbeatQueueDependencies["setRunStatus"]>(async (id, status, patch) =>
      db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning().then(rows => rows[0] ?? null)),
    setWakeupStatus: vi.fn<HeartbeatQueueDependencies["setWakeupStatus"]>(async () => undefined),
    appendRunEvent: vi.fn<HeartbeatQueueDependencies["appendRunEvent"]>(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getAgentInvokability: vi.fn<HeartbeatQueueDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    getWorktreeExecutionCutoff: vi.fn(async () => null),
    applyRunDispatchPostCommitEffects: vi.fn(),
    issuesSvc: {
      getDependencyReadiness: vi.fn<HeartbeatQueueDependencies["issuesSvc"]["getDependencyReadiness"]>(),
      listDependencyReadiness: vi.fn(async () => new Map()),
    },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    instanceSettings: { getExperimental: vi.fn<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>() },
    runDispatch: createRunDispatch(db),
    wakeQueue: {
      createAdmissionTransactionScope: vi.fn<ReturnType<typeof createWakeQueue>["createAdmissionTransactionScope"]>(),
      admitWakeBehindIssueExecution: vi.fn<ReturnType<typeof createWakeQueue>["admitWakeBehindIssueExecution"]>(),
    },
    activeRunExecutions: new Set<string>(),
    activeRunExecutionPromises: new Set<Promise<void>>(),
    activeWakeupPromises: new Set<Promise<unknown>>(),
    liveRunExecutions: { has: vi.fn(() => false) },
    isHeartbeatRunTerminalStatus: (status: string | null | undefined) => ["succeeded", "failed", "cancelled", "timed_out"].includes(status ?? ""),
    isSameTaskScope: (left: string | null, right: string | null) => left === right,
    runTaskKey: (run: Run) => typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null,
    filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null) => run,
    getSchedulingSuppression: vi.fn(async () => ({ suppressed: false, reason: null } as Awaited<ReturnType<HeartbeatQueueDependencies["getSchedulingSuppression"]>>)),
    canStartNewExternalBotWork: vi.fn(async () => true),
    executeRun: vi.fn(async () => undefined),
    applyWakeQueuePostCommitEffects: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    publishRunLifecyclePluginEvent: vi.fn(),
    cancelRunInternal: vi.fn(async () => undefined),
    cancelActiveForAgentInternal: vi.fn(async () => undefined),
    resumeExecutionWaitComments: vi.fn(async () => undefined),
    resumeQueuedCommentInterrupt: vi.fn(async () => undefined),
    resumeSavedLegacyComments: vi.fn(async () => undefined),
    formatIssueIdentifierLink: (_identifier: string | null, fallback: string) => fallback,
    sweepPendingCleanupLeases: vi.fn<HeartbeatQueueDependencies["sweepPendingCleanupLeases"]>(),
  } satisfies HeartbeatQueueDependencies;
}
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("stranded deferred wakes (PER-1016)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stranded-wakes");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages to warning`);
  }, 120000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages to warning`); await tx.execute(sql`truncate table companies restart identity cascade`); }); });

  async function fixture(status: string) {
    const [company] = await db.insert(companies).values({name: "Stranded queue", issuePrefix: "SQ", defaultResponsibleUserId: "board-user"}).returning();
    const [agent] = await db.insert(agents).values({companyId: company.id, name: "Worker", role: "engineer", status: "idle", adapterType: "process"}).returning();
    const [issue] = await db.insert(issues).values({companyId: company.id, title: "Unlocked task", status, assigneeAgentId: agent.id, responsibleUserId: "board-user"}).returning();
    const [run] = await db.insert(heartbeatRuns).values({companyId: company.id, agentId: agent.id, status: "failed", runtimeMode: "legacy", errorCode: "omnigent_session_not_recovered", finishedAt: new Date(Date.now()-3600000), contextSnapshot: {issueId: issue.id}}).returning();
    await db.insert(issueRecoveryActions).values({companyId:company.id, sourceIssueId:issue.id, kind:"active_run_watchdog", cause:"legacy_execution_requires_reconciliation", fingerprint:`legacy:${run.id}`, status:"resolved", outcome:"restored", resolvedAt:new Date(), nextAction:"Continue normally", evidence:{runId:run.id, executionReconciliation:{runId:run.id, providerStopped:true, actionOutcome:"not_performed", outcomeEvidence:"Provider did not start work"}}});
    const wakes = [];
    for (let i=0;i<3;i++) {
      const [wake] = await db.insert(agentWakeupRequests).values({companyId: company.id, agentId: agent.id, source: "assignment", triggerDetail: "system", reason: "issue_execution_deferred", requestedByActorType: "system", payload: {issueId: issue.id, _paperclipWakeContext: {issueId: issue.id, wakeReason: "issue_assigned", ordinal: i}}, status: "deferred_issue_execution", requestedAt: new Date(Date.now()-600000+i*1000), updatedAt: new Date()}).returning();
      wakes.push(wake);
    }
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings = instanceSettingsService(db) as typeof deps.instanceSettings;
    deps.issuesSvc = issueService(db) as typeof deps.issuesSvc;
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => "board-user", getRoutineEnv: async () => ({routineId:null, env:null, responsibleUserId:null}),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {} as never,
      recovery: {escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {}},
    });
    deps.releaseIssueExecutionAndPromote.mockImplementation(async (source, options) => {
      const result = await wakeQueue.releaseIssueExecution({companyId: source.companyId, runId: source.id, now: new Date(), ...options});
      return result;
    });
    return {company, agent, issue, run, wakes, deps, queue: createHeartbeatQueue(db, deps)};
  }

  it.each(["todo", "in_progress"])("promotes the oldest wake once on an unlocked %s issue despite fresh updated_at", async status => {
    const f = await fixture(status);
    await f.queue.resumeQueuedRuns();
    await f.queue.resumeQueuedRuns();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id));
    expect(runs).toHaveLength(2);
    const successor = runs.find(r=>r.id!==f.run.id)!;
    expect(successor.contextSnapshot?.ordinal).toBe(0);
    const [adopted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakes[0].id));
    expect(adopted.status).toBe("coalesced");
    expect(adopted.runId).toBe(successor.id);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agent.id));
    expect(wakes.filter(w=>w.status==="deferred_issue_execution")).toHaveLength(2);
    expect(f.deps.executeRun).toHaveBeenCalledExactlyOnceWith(successor.id);
  });
  it("two sweepers create only one successor", async () => {
    const f = await fixture("todo");
    const second = createHeartbeatQueue(db, f.deps);
    await Promise.all([f.queue.resumeQueuedRuns(), second.resumeQueuedRuns()]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    expect(runs).toHaveLength(2);
    expect(runs.find(r => r.id !== f.run.id)?.contextSnapshot?.ordinal).toBe(0);
    expect(f.deps.executeRun).toHaveBeenCalledTimes(1);
  });

  it.each(["fresh", "blocked", "approval", "revision", "question", "active_hold", "resolved_no_replay", "live_run", "locked", "reassigned", "stopped", "cleanup", "finalizing"])("keeps %s work gated", async gate => {
    const f = await fixture("todo");
    if (gate === "fresh") await db.update(agentWakeupRequests).set({requestedAt:new Date()}).where(eq(agentWakeupRequests.agentId,f.agent.id));
    if (gate === "blocked") await db.update(issues).set({status:"blocked"}).where(eq(issues.id,f.issue.id));
    if (gate === "locked") await db.update(issues).set({executionRunId:f.run.id}).where(eq(issues.id,f.issue.id));
    if (gate === "reassigned") await db.update(issues).set({assigneeAgentId:null}).where(eq(issues.id,f.issue.id));
    if (gate === "live_run") await db.update(heartbeatRuns).set({status:"running",finishedAt:null}).where(eq(heartbeatRuns.id,f.run.id));
    if (gate === "approval" || gate === "revision") {
      const [approval] = await db.insert(approvals).values({companyId:f.company.id,type:"governed_action",status:gate==="approval"?"pending":"revision_requested",payload:{}}).returning();
      await db.insert(issueApprovals).values({companyId:f.company.id,issueId:f.issue.id,approvalId:approval.id});
    }
    if (gate === "question") await db.insert(issueThreadInteractions).values({companyId:f.company.id,issueId:f.issue.id,kind:"question",status:"pending",payload:{questions:[]} as never});
    if (gate === "active_hold" || gate === "resolved_no_replay") await db.update(issueRecoveryActions).set({status:gate==="active_hold"?"active":"resolved",evidence:{runId:f.run.id,automaticRecovery:{replay:"blocked"}}}).where(eq(issueRecoveryActions.sourceIssueId,f.issue.id));
    if (gate === "stopped") await db.update(heartbeatRuns).set({status:"cancelled",startedAt:new Date(Date.now()-4000000)}).where(eq(heartbeatRuns.id,f.run.id));
    if (gate === "cleanup") await db.insert(environmentLeases).values({companyId:f.company.id,heartbeatRunId:f.run.id,issueId:f.issue.id,status:"pending_cleanup"});
    if (gate === "finalizing") await db.update(heartbeatRuns).set({nativeIssueId:f.issue.id,runtimeMode:"native"}).where(eq(heartbeatRuns.id,f.run.id));
    if (gate === "finalizing") await db.insert(nativeRunFinalizations).values({companyId:f.company.id,runId:f.run.id,issueId:f.issue.id,phase:"pending"});
    await f.queue.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id))).toHaveLength(1);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agent.id))).filter(w=>w.status==="deferred_issue_execution")).toHaveLength(3);
  });

  it("waits for a real blocker, then admits the same oldest saved wake", async () => {
    const f = await fixture("in_progress");
    const [blocker] = await db.insert(issues).values({companyId:f.company.id,title:"Prerequisite",status:"todo"}).returning();
    await db.insert(issueRelations).values({companyId:f.company.id,issueId:blocker.id,relatedIssueId:f.issue.id,type:"blocks"});
    expect((await f.deps.issuesSvc.getDependencyReadiness(f.issue.id)).isDependencyReady).toBe(false);
    await f.queue.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id))).toHaveLength(1);
    await db.update(issues).set({status:"done"}).where(eq(issues.id,blocker.id));
    await f.queue.resumeQueuedRuns();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id));
    expect(runs).toHaveLength(2);
    expect(runs.find(r=>r.id!==f.run.id)?.contextSnapshot?.ordinal).toBe(0);
  });

  async function savedCommentFixture(runtimeMode: string) {
    const fixtureData = await fixture("in_progress");
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixtureData.agent.id));
    await db.update(heartbeatRuns).set({ runtimeMode }).where(eq(heartbeatRuns.id, fixtureData.run.id));
    const [comment] = await db.insert(issueComments).values({ companyId: fixtureData.company.id,
      issueId: fixtureData.issue.id, authorType: "user", authorUserId: "board-user",
      body: "Continue from this saved direction. Do not bypass an approval." }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: fixtureData.company.id,
      agentId: fixtureData.agent.id, source: "assignment", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board-user", status: "deferred_issue_execution",
      requestedAt: new Date(Date.now() - 600000), payload: withQueuedCommentIdsInWakePayload({
        issueId: fixtureData.issue.id, executionWait: { reason: "execution_recovery",
          message: "Waiting for execution recovery. Your message is saved." },
        _paperclipWakeContext: { issueId: fixtureData.issue.id, wakeReason: "issue_commented" },
      }, [comment.id]) }).returning();
    return { ...fixtureData, comment, wake };
  }

  it.each(["native", "legacy"])("admits a resolved recovery comment after a %s run exactly once", async runtimeMode => {
    const fixtureData = await savedCommentFixture(runtimeMode);
    const { comment, wake } = fixtureData;
    const secondQueue = createHeartbeatQueue(db, fixtureData.deps);
    await Promise.all([fixtureData.queue.resumeQueuedRuns(), secondQueue.resumeQueuedRuns()]);
    await fixtureData.queue.resumeQueuedRuns();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixtureData.agent.id));
    expect(runs).toHaveLength(2);
    const successor = runs.find(run => run.id !== fixtureData.run.id)!;
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual([comment.id]);
    expect(fixtureData.deps.executeRun).toHaveBeenCalledTimes(1);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(receipt.status).not.toBe("deferred_issue_execution");
    expect(receipt.runId).toBe(successor.id);
  });

  it("keeps a saved comment behind a resolved no-replay hold with its actual next action", async () => {
    const fixtureData = await savedCommentFixture("native");
    const nextAction = "Inspect the external outcome before authorizing more work.";
    await db.update(issueRecoveryActions).set({ nextAction, evidence: {
      runId: fixtureData.run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
    } }).where(eq(issueRecoveryActions.sourceIssueId, fixtureData.issue.id));
    await fixtureData.queue.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixtureData.agent.id))).toHaveLength(1);
    expect(fixtureData.deps.executeRun).not.toHaveBeenCalled();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixtureData.wake.id));
    expect(receipt.status).toBe("deferred_issue_execution");
    expect(receipt.payload?.executionWait).toMatchObject({ reason: "execution_reconciliation_required", message: nextAction });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixtureData.issue.id));
    expect(action.evidence.automaticRecovery).toEqual({ replay: "blocked", actionOutcome: "unknown" });
  });

  it.each(["deleted", "reassigned", "live_run"])("does not start a successor for a %s saved-comment wake", async gate => {
    const fixtureData = await savedCommentFixture("native");
    if (gate === "deleted") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, fixtureData.comment.id));
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, fixtureData.issue.id));
    if (gate === "live_run") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, fixtureData.run.id));
    await fixtureData.queue.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixtureData.agent.id))).toHaveLength(1);
    expect(fixtureData.deps.executeRun).not.toHaveBeenCalled();
  });

  it("does not let an old generic wake hide newer interaction delivery", async () => {
    const f = await fixture("todo");
    const [approval] = await db.insert(approvals).values({companyId:f.company.id,type:"governed_action",status:"pending",payload:{}}).returning();
    await db.insert(issueApprovals).values({companyId:f.company.id,issueId:f.issue.id,approvalId:approval.id});
    await db.insert(agentWakeupRequests).values({companyId:f.company.id,agentId:f.agent.id,source:"assignment",triggerDetail:"system",reason:"issue_commented",status:"deferred_issue_execution",payload:{issueId:f.issue.id,_paperclipWakeContext:{issueId:f.issue.id,wakeReason:"issue_commented",wakeCommentIds:[f.run.id]}},requestedAt:new Date()});
    await f.queue.resumeQueuedRuns();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({id:f.run.id}),expect.anything());
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

});
