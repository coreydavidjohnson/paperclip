import { randomUUID } from "node:crypto";
import { issueService } from "../issues.js";
import { instanceSettingsService } from "../instance-settings.js";
import { claimNativeSessionResumptions } from "../native-runtime/native-finalization-reconciler.js";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "./queue.js";

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
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected queue database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat queue module boundary", () => {
  it("constructs without querying, dispatching, or registering background work", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatQueue(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(deps.activeWakeupPromises.size).toBe(0);
  });

  it.each(["startNextQueuedRunForAgent", "resumeQueuedRuns"] as const)("honors suppression before %s reads or resumes work", async (operation) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const queue = createHeartbeatQueue(database.db, deps);
    await queue[operation]("agent");
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.resumeExecutionWaitComments).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("tracks pending wakes across instances and clears each rejected wake", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    let rejectFirst!: (reason: Error) => void;
    let rejectSecond!: (reason: Error) => void;
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
    const first = createHeartbeatQueue(database.db, deps).trackWakeup("first");
    const second = createHeartbeatQueue(database.db, deps).trackWakeup("second");
    const firstCheck = expect(first).rejects.toThrow("first lookup failed");
    const secondCheck = expect(second).rejects.toThrow("second lookup failed");
    expect(deps.activeWakeupPromises).toEqual(new Set([first, second]));
    rejectFirst(new Error("first lookup failed"));
    await firstCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises).toEqual(new Set([second]));
    rejectSecond(new Error("second lookup failed"));
    await secondCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises.size).toBe(0);
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("uses the same policy limits for dispatch and execution", () => {
    const database = guardedDatabase();
    const queue = createHeartbeatQueue(database.db, callbacks(database.db));
    const agent = { adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 20, maxDailyRuns: 3.8 } } } as unknown as typeof agents.$inferSelect;
    expect(queue.parseHeartbeatPolicy(agent)).toMatchObject({ maxConcurrentRuns: 1, maxDailyRuns: 3 });
    expect(queue.parseHeartbeatPolicy({ ...agent, adapterConfig: { provider: "codex" } })).toMatchObject({ maxConcurrentRuns: 20, maxDailyRuns: 3 });
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping queue module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat queue database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queue-module");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(status = "running") {
    const [company] = await db.insert(companies).values({ name: "Queue module", issuePrefix: "QM" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Queue task", status: "todo", assigneeAgentId: agent.id }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed", claimedAt: new Date() }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status, invocationSource: "assignment", wakeupRequestId: wake.id, startedAt: status === "running" ? new Date() : null, contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: run.id, executionAgentNameKey: agent.name, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    return { company, agent, issue, wake, run };
  }

  it("adopts a completed liveness wake receipt instead of creating another run", async () => {
    const { run, issue, agent, company } = await fixture("succeeded");
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null }).where(eq(issues.id, issue.id));
    const key = `liveness:${run.id}`;
    await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
      source: "automation", status: "completed", idempotencyKey: key, runId: run.id, payload: { issueId: issue.id } });
    const deps = callbacks(db); deps.getAgent.mockResolvedValue(agent);
    await db.update(companies).set({ defaultResponsibleUserId: "queue-test-user" }).where(eq(companies.id, company.id));
    deps.instanceSettings.getExperimental.mockResolvedValue({} as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    const result = await createHeartbeatQueue(db, deps).enqueueWakeup(agent.id, { source: "automation", triggerDetail: "system",
      reason: "external_session_gone", idempotencyKey: key, payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
    expect(result?.id).toBe(run.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agent.id))).toHaveLength(1);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("serializes concurrent liveness redelivery into exactly one admitted run", async () => {
    const {run,issue,agent,company}=await fixture("failed");
    await db.update(companies).set({defaultResponsibleUserId:"queue-test-user"}).where(eq(companies.id,company.id));
    await db.update(issues).set({executionRunId:null,executionLockedAt:null,responsibleUserId:"queue-test-user"}).where(eq(issues.id,issue.id));
    const deps=callbacks(db);deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({} as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    deps.issuesSvc.getDependencyReadiness.mockResolvedValue({isDependencyReady:true} as never);
    const queue=createHeartbeatQueue(db,deps);
    const opts={source:"automation" as const,triggerDetail:"system" as const,reason:"external_session_gone",requestedByActorType:"system" as const,requestedByActorId:"external-liveness",idempotencyKey:`liveness:${run.id}`,payload:{issueId:issue.id},contextSnapshot:{issueId:issue.id}};
    const results=await Promise.all([queue.enqueueWakeup(agent.id,opts),queue.enqueueWakeup(agent.id,opts)]);
    expect(results[0]?.id).toBeTruthy();expect(results[1]?.id).toBe(results[0]?.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agent.id))).toHaveLength(2);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,opts.idempotencyKey)))).toHaveLength(1);
    expect(deps.executeRun).toHaveBeenCalledTimes(1);
  });

  async function runBudgetFixture(priorRuns: number, status = "succeeded") {
    const seeded = await fixture(status);
    const { issue, agent, company } = seeded;
    await db.update(companies).set({ defaultResponsibleUserId: "queue-test-user" }).where(eq(companies.id, company.id));
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null,
      responsibleUserId: "queue-test-user" }).where(eq(issues.id, issue.id));
    if (priorRuns > 1) await db.insert(heartbeatRuns).values(Array.from({ length: priorRuns - 1 }, () => ({
      companyId: company.id, agentId: agent.id, status: "succeeded", invocationSource: "assignment",
      issueId: issue.id, scopeKind: "issue" as const, finishedAt: new Date(),
    })));
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({} as never);
    deps.issuesSvc.getDependencyReadiness.mockResolvedValue({ isDependencyReady: true } as never);
    return { ...seeded, deps, queue: createHeartbeatQueue(db, deps) };
  }

  it("allows the tenth issue run", async () => {
    const { issue, agent, queue } = await runBudgetFixture(9);
    const result = await queue.enqueueWakeup(agent.id, { source: "assignment", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
    expect(result?.id).toBeTruthy();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
  });

  it("does not charge another company or issue against this issue", async () => {
    const { issue, agent, company, queue } = await runBudgetFixture(9);
    const [otherCompany] = await db.insert(companies).values({ name: "Other budget", issuePrefix: "OB" }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: otherCompany.id, name: "Other agent", role: "engineer" }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId: company.id, title: "Other task" }).returning();
    await db.insert(heartbeatRuns).values(Array.from({ length: 10 }, () => ({
      companyId: otherCompany.id, agentId: otherAgent.id, nativeIssueId: issue.id, status: "succeeded",
    })));
    await db.insert(heartbeatRuns).values(Array.from({ length: 10 }, () => ({
      companyId: company.id, agentId: agent.id, issueId: otherIssue.id, scopeKind: "issue" as const, status: "succeeded",
    })));
    expect((await queue.enqueueWakeup(agent.id, { source: "assignment", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } }))?.id).toBeTruthy();
  });

  it.each(["assignment", "automation", "on_demand"] as const)("stops %s wakes after ten issue runs with one judging note", async (source) => {
    const { issue, agent, queue, deps } = await runBudgetFixture(10);
    await db.update(issues).set({ monitorNextCheckAt: new Date(), monitorWakeRequestedAt: new Date() })
      .where(eq(issues.id, issue.id));
    const opts = { source, reason: source === "automation" ? "issue_monitor" : "issue_continuation_needed",
      requestedByActorType: "system" as const, payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } };
    expect(await queue.enqueueWakeup(agent.id, opts)).toBeNull();
    const firstBlocked = (await db.select().from(issues).where(eq(issues.id, issue.id)))[0];
    expect(await queue.enqueueWakeup(agent.id, opts)).toBeNull();
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0])
      .toMatchObject({ status: "blocked", statusVersion: issue.statusVersion + 1, updatedAt: firstBlocked.updatedAt,
        monitorNextCheckAt: null, monitorWakeRequestedAt: null });
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("needs judging: 10 runs");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, issue.companyId))).toHaveLength(10);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["issueId", "taskId"] as const)("stops a queued retry with %s from starting the eleventh issue run", async (binding) => {
    const { issue, agent, company, queue, deps } = await runBudgetFixture(10);
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "queued", responsibleUserId: "queue-test-user", invocationSource: "automation",
      issueId: binding === "issueId" ? issue.id : null, scopeKind: "issue", contextSnapshot: { [binding]: issue.id } }).returning();
    expect(await queue.claimQueuedRun(retry)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)))[0])
      .toMatchObject({ status: "cancelled", errorCode: "issue.run_budget_exhausted" });
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: retry.id }),
      { suppressImmediateRecovery: true });
  });

  it("counts new runs at exactly the trusted release timestamp", async () => {
    const { issue, agent, company, queue } = await runBudgetFixture(10);
    const releasedAt = new Date();
    await db.insert(activityLog).values({ companyId: company.id, actorType: "user", actorId: "board-reviewer",
      action: "issue.updated", entityType: "issue", entityId: issue.id, createdAt: releasedAt,
      details: { status: "todo", _previous: { status: "blocked" } } });
    await db.insert(heartbeatRuns).values(Array.from({ length: 10 }, () => ({ companyId: company.id,
      agentId: agent.id, issueId: issue.id, scopeKind: "issue" as const, status: "succeeded", createdAt: releasedAt })));
    expect(await queue.enqueueWakeup(agent.id, { source: "assignment", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } })).toBeNull();
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)))[0].body)
      .toContain("needs judging: 10 runs");
  });

  it("counts runs queued before a reset when they start after the reset", async () => {
    const { issue, agent, company, queue } = await runBudgetFixture(10);
    const releasedAt = new Date();
    await db.insert(activityLog).values({ companyId: company.id, actorType: "user", actorId: "board-reviewer",
      action: "issue.updated", entityType: "issue", entityId: issue.id, createdAt: releasedAt,
      details: { status: "todo", _previous: { status: "blocked" } } });
    await db.update(heartbeatRuns).set({ startedAt: new Date(releasedAt.getTime() + 1) })
      .where(eq(heartbeatRuns.companyId, company.id));
    expect(await queue.enqueueWakeup(agent.id, { source: "assignment", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } })).toBeNull();
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)))[0].body)
      .toContain("needs judging: 10 runs");
  });

  it("preserves a guarded board status repair when the queued run budget is exhausted", async () => {
    const { issue, agent, company, queue } = await runBudgetFixture(10);
    await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: issue.id,
      kind: "deliberate_wait_without_target", cause: "deliberate_wait_without_target", ownerType: "board",
      fingerprint: "run-budget-board-hold", nextAction: "A board decision is required",
      evidence: { terminalReason: "unchanged_source_state_exhausted" }, wakePolicy: { type: "board_escalation" } });
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "queued", responsibleUserId: "queue-test-user", issueId: issue.id, scopeKind: "issue",
      contextSnapshot: { issueId: issue.id } }).returning();
    await expect(queue.claimQueuedRun(retry)).rejects.toMatchObject({ details: { code: "recovery_status_repair_required" } });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("todo");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
  });

  it("resets ten-run allowance only when a board user releases the judging hold", async () => {
    const { issue, agent, queue } = await runBudgetFixture(10);
    const opts = { source: "assignment" as const, reason: "issue_assigned", requestedByActorType: "system" as const,
      payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } };
    expect(await queue.enqueueWakeup(agent.id, opts)).toBeNull();
    for (const actorType of ["agent", "user"] as const) {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue.id));
      await db.insert(activityLog).values({ companyId: issue.companyId, actorType, actorId: "board-reviewer",
        action: "issue.updated", entityType: "issue", entityId: issue.id,
        details: { status: "todo", _previous: { status: "blocked" } } });
      const result = await queue.enqueueWakeup(agent.id, opts);
      if (actorType === "agent") expect(result).toBeNull();
      else expect(result?.id).toBeTruthy();
    }
  });

  it.each(["claimed", "cancelled"] as const)("releases a running claim while preserving a %s wake", async (wakeStatus) => {
    const { run, issue, wake } = await fixture();
    await db.update(agentWakeupRequests).set({ status: wakeStatus }).where(eq(agentWakeupRequests.id, wake.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [releasedIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [releasedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(released).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    expect(releasedIssue).toMatchObject({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect(releasedWake.status).toBe(wakeStatus === "cancelled" ? "cancelled" : "queued");
    if (wakeStatus === "claimed") expect(releasedWake.claimedAt).toBeNull();
  });

  it("preserves a newer execution owner when releasing an old claim", async () => {
    const { run, issue, agent, company } = await fixture();
    const [newOwner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", invocationSource: "assignment" }).returning();
    await db.update(issues).set({ executionRunId: newOwner.id }).where(eq(issues.id, issue.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(current.executionRunId).toBe(newOwner.id);
  });

  it.each(["running", "failed"])("resumes the %s native owner before promoting its queued waiter", async status => {
    const { run, issue, agent, company } = await fixture(status);
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id, runnerProfileJson: {
      nativeExecutionInput: { binding: { runId: run.id } },
      sessionCheckpoint: { providerSessionId: "original-session" },
    } }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: company.id,
      issueId: issue.id, phase: "retryable_failure", attempt: 1 });
    const [waiter] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "queued", invocationSource: "assignment", responsibleUserId: "queue-test-user", contextSnapshot: { issueId: issue.id },
    }).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableNativeRunner: true } as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.claimQueuedRun(waiter)).toBeNull();
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "owner", runIds: [run.id] });
    expect(claims.map(claim => claim.runId)).toEqual([run.id]);
    expect(await queue.claimQueuedRun(waiter)).toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issue.id));
    expect(await queue.claimQueuedRun(waiter)).toMatchObject({ id: waiter.id, status: "running" });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].executionRunId).toBe(waiter.id);
  });

  it.each(["direct", "batch"] as const)("keeps fresh work queued across a held external connection on the %s path", async path => {
    const { run, agent, issue, wake } = await fixture("queued");
    await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue({ ...agent, adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot" } });
    const queue = createHeartbeatQueue(db, deps);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (path === "direct") expect(await queue.claimQueuedRun({ ...run, responsibleUserId: "queue-test-user" })).toBeNull();
      else expect(await queue.startNextQueuedRunForAgent(agent.id)).toEqual([]);
    }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe(wake.status);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("todo");
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(deps.setRunStatus).not.toHaveBeenCalled();
  });

  it("admits the same queued input after the external connection is repaired", async () => {
    const { run, agent } = await fixture("queued");
    await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue(agent);
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.startNextQueuedRunForAgent(agent.id)).toEqual([]);
    deps.canStartNewExternalBotWork.mockResolvedValue(true);
    expect(await queue.startNextQueuedRunForAgent(agent.id)).toEqual([expect.objectContaining({ id: run.id, status: "running" })]);
    expect(deps.executeRun).toHaveBeenCalledExactlyOnceWith(run.id);
  });

  it("rechecks the connection hold when Stop races the queue scan", async () => {
    const { run, agent } = await fixture("queued");
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue(agent);
    deps.canStartNewExternalBotWork.mockResolvedValueOnce(true);
    expect(await createHeartbeatQueue(db, deps).startNextQueuedRunForAgent(agent.id)).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    expect(deps.canStartNewExternalBotWork).toHaveBeenCalledTimes(2);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps admitted resumptions outside the fresh external connection gate", async () => {
    const { run, agent } = await fixture("queued");
    await db.update(heartbeatRuns).set({ startedAt: new Date(), responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    const [admitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue(agent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(admitted)).toMatchObject({ id: run.id, status: "running" });
    expect(deps.canStartNewExternalBotWork).not.toHaveBeenCalled();
  });

  it("cancels at the daily run cap before claiming or dispatching", async () => {
    const { run, agent } = await fixture("queued");
    const cappedAgent = { ...agent, runtimeConfig: { heartbeat: { maxDailyRuns: 0 } } };
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(cappedAgent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(run)).toBeNull();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "heartbeat.daily_run_limit" });
    expect(deps.setWakeupStatus).toHaveBeenCalledWith(run.wakeupRequestId, "skipped", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(cancelled, { suppressImmediateRecovery: true });
    expect(deps.treeControlSvc.getActivePauseHoldGate).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["sequential", "overlapping"] as const)(
    "does not starve direction behind fifty safely stopped receipts (%s)",
    async mode => {
      const companyId = randomUUID(), agentId = randomUUID(), targetId = randomUUID();
      const priorId = randomUUID(), commentId = randomUUID(), wakeId = randomUUID();
      const old = new Date(Date.now() - 900_000), saved = new Date(Date.now() - 300_000);
      await db.insert(companies).values({ id: companyId, name: "Fair delivery", issuePrefix: "FAIR", defaultResponsibleUserId: "board" });
      const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Fair worker", role: "engineer", status: "idle", adapterType: "process" }).returning();
      await db.insert(issues).values({ id: targetId, companyId, title: "Idle target", status: "in_progress", assigneeAgentId: agentId, monitorNextCheckAt: new Date("2026-10-28T14:00Z") });
      await db.insert(heartbeatRuns).values({ id: priorId, companyId, agentId, status: "succeeded", runtimeMode: "legacy", finishedAt: old, contextSnapshot: { issueId: targetId } });
      await db.insert(issueComments).values({ id: commentId, companyId, issueId: targetId, authorType: "user", authorUserId: "board", body: "Saved direction for the existing task" });
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId, source: "automation", reason: "issue_execution_deferred",
        status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
        requestedAt: saved, updatedAt: saved,
        payload: { issueId: targetId, mutation: "comment", commentId, resumeIntent: true, followUpRequested: true,
          _paperclipWakeContext: { issueId: targetId, wakeReason: "issue_commented", wakeCommentIds: [commentId], resumeIntent: true, followUpRequested: true } },
      });
      // These receipts remain safely held. Fair scanning must not grant them
      // new Stop/restart authority just to reach the later runnable receipt.
      for (let n = 0; n < 50; n++) {
        const issueId = randomUUID(), runId = randomUUID(), stoppedCommentId = randomUUID();
        await db.insert(issues).values({ id: issueId, companyId, title: "Stopped older work", status: "in_progress", assigneeAgentId: agentId });
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", runtimeMode: "legacy", finishedAt: old,
          contextSnapshot: { issueId }, resultJson: { executionCancellation: { state: "acknowledged" } } });
        await db.insert(issueComments).values({ id: stoppedCommentId, companyId, issueId, authorType: "user", authorUserId: "board", body: "Saved before Stop; no restart authority" });
        await db.insert(agentWakeupRequests).values({
          companyId, agentId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: "board", requestedAt: old, updatedAt: old,
          payload: { issueId, mutation: "comment", commentId: stoppedCommentId,
            _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [stoppedCommentId] } },
        });
      }
      const wakeQueue = createWakeQueue(db, {
        resolveResponsibleUserId: async () => "board",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => "retained-task-session",
        wakeAdmissionHelpers: {} as never,
        recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
      });
      const deps = {
        ...callbacks(db),
        instanceSettings: instanceSettingsService(db),
        issuesSvc: issueService(db),
        releaseIssueExecutionAndPromote: vi.fn<HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"]>(async (source, options) => {
          await wakeQueue.releaseIssueExecution({ companyId: source.companyId, runId: source.id, now: new Date(), ...options });
        }),
      };
      deps.getAgent.mockResolvedValue(agent);
      const queue = createHeartbeatQueue(db, deps);
      if (mode === "sequential") {
        await queue.resumeQueuedRuns();
        await createHeartbeatQueue(db, deps).resumeQueuedRuns();
      } else {
        await Promise.all([queue.resumeQueuedRuns(), createHeartbeatQueue(db, deps).resumeQueuedRuns()]);
        await queue.resumeQueuedRuns();
      }
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
      expect(wake).toMatchObject({ status: "claimed", runId: expect.any(String) });
      await queue.resumeQueuedRuns();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      const stopped = runs.filter(run => run.status === "cancelled");
      expect(stopped).toHaveLength(50);
      for (const run of stopped) expect(run.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
      expect(runs).toHaveLength(52);
      const successor = runs.find(run => run.id === wake.runId);
      expect(successor).toMatchObject({ sessionIdBefore: "retained-task-session", contextSnapshot: { wakeCommentIds: [commentId] } });
      expect(deps.executeRun).toHaveBeenCalledExactlyOnceWith(successor!.id);
    },
  );

  it("skips locked receipts without locking their joined task, then revisits after release", async () => {
    const { company, agent, issue } = await fixture("cancelled");
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issue.id));
    const before = new Date(Date.now() - 900_000);
    const ids = Array.from({ length: 51 }, () => randomUUID()).sort();
    await db.insert(agentWakeupRequests).values(ids.map(id => ({
      id, companyId: company.id, agentId: agent.id, source: "automation", status: "deferred_issue_execution",
      requestedAt: before, updatedAt: before, payload: { issueId: issue.id, mutation: "interaction" },
    })));
    let unlock!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
      await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, ids[0])).for("update");
      locked();
      await released;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ready;
      await Promise.race([
        createHeartbeatQueue(db, callbacks(db)).resumeQueuedRuns(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("scan waited on joined task or locked receipt")), 3000); }),
      ]);
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
      expect(rows.filter(row => row.updatedAt > before).map(row => row.id).sort()).toEqual(ids.slice(1));
    } finally {
      clearTimeout(timer);
      unlock();
      await holder;
    }
    await createHeartbeatQueue(db, callbacks(db)).resumeQueuedRuns();
    const [revisited] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, ids[0]));
    expect(revisited.updatedAt > before).toBe(true);
  });

  it.each(["generic", "interaction", "comment"] as const)(
    "rotates all selected %s receipts, including early returns, with stable ties across queue recreation",
    async (kind) => {
      const { company, agent, issue } = await fixture("cancelled");
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issue.id));
      const before = new Date(Date.now() - 900_000);
      const ids = Array.from({ length: 51 }, () => randomUUID()).sort();
      await db.insert(agentWakeupRequests).values(ids.map(id => ({
        id, companyId: company.id, agentId: agent.id, source: "automation",
        reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedAt: before, updatedAt: before,
        payload: { issueId: issue.id, ...(kind === "generic" ? {} : kind === "interaction"
          ? { mutation: "interaction" }
          : { _paperclipWakeContext: { wakeCommentIds: [randomUUID()] } }) },
      })));
      const deps = callbacks(db);
      // Generic admission fails before any delivery. Other paths return before
      // finding an interaction, or use the ordinary terminal-source callback.
      await createHeartbeatQueue(db, deps).resumeQueuedRuns();
      let rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
      expect(rows.filter(row => row.updatedAt > before).map(row => row.id).sort()).toEqual(ids.slice(0, 50));
      expect(rows.find(row => row.id === ids[50])?.updatedAt).toEqual(before);
      await createHeartbeatQueue(db, deps).resumeQueuedRuns();
      rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
      expect(rows).toHaveLength(51);
      expect(rows.every(row => row.updatedAt > before)).toBe(true);
      expect(deps.executeRun).not.toHaveBeenCalled();
    },
  );
});
