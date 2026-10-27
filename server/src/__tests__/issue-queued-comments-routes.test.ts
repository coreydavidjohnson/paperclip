import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { runningProcesses } from "../adapters/index.js";
import { createHash, randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueThreadInteractions,
  issueRecoveryActions,
  issues,
  principalPermissionGrants,
  runIdentityContexts,
} from "@paperclipai/db";
import { createApiMetrics } from "../api-metrics.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueRoutes } from "../routes/issues.js";
import { getTaskDrainStatus, heartbeatService } from "../services/heartbeat.js";
import { adapterExecutionControls, createAdapterExecutionControl, registerAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { authorizationService } from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { initializeRunIdentity, reconcileSteeredIdentity } from "../services/run-identity.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const steerNativeSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  steerNativeSessionMock.mockImplementation(actual.steerNativeSession);
  return { ...actual, steerNativeSession: steerNativeSessionMock };
});
const nativeSessionExecutor = await import("../services/native-runtime/native-session-executor.js");
const { NativeSessionSteeringError } = nativeSessionExecutor;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-comment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue queued-comment routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comments-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  const testProcesses = new Map<string, ChildProcess>();

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const [id, child] of testProcesses) {
      runningProcesses.delete(id);
      child.kill();
    }
    testProcesses.clear();
    await heartbeatService(db).drainActiveRunExecutions();
    // Each case owns the entire disposable database. Clear the full company
    // graph, including attribution rows and constraints added by migrations.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers).where(eq(authUsers.id, "queue-owner"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, userId = "queue-owner", agentActor?: { agentId: string; runId: string }, metrics?: ReturnType<typeof createApiMetrics>) {
    const testApp = express();
    if (metrics) testApp.use(metrics.middleware);
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: agentActor ? "agent" : "board",
        ...(agentActor ? { ...agentActor, companyId } : {}),
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const commentIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Test Company",
      issuePrefix: "QUE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paperclip Runner",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: "queue-owner",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: "other-operator",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "issue_comment",
      reason: "Follow-up comments arrived during the active run",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "queue-owner",
      payload: {
        issueId,
        commentId: commentIds[1],
        _paperclipWakeContext: {
          commentId: commentIds[1],
          wakeCommentId: commentIds[1],
          wakeCommentIds: commentIds,
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "queue route test",
      status: "running",
      runtimeMode: "native",
      startedAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "QUE-1",
      title: "Queued steering",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });
    await db.insert(issueComments).values(commentIds.map((id, index) => ({
      id,
      companyId,
      issueId,
      authorType: "user" as const,
      authorUserId: "queue-owner",
      body: index === 0 ? "First queued message" : "Second queued message",
      createdAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
      updatedAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
    })));
    return { companyId, agentId, issueId, runId, wakeId, commentIds };
  }

  it("delivers queued comments to their live external run and empties the deferred wake", async () => {
    const seeded = await seedQueue();
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(agents).set({ adapterType: "omnigent" }).where(eq(agents.id, seeded.agentId));
    const agentApp = app(seeded.companyId, "queue-owner", seeded);
    const response = await request(agentApp).post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
    expect(response.status).toBe(200);
    expect(response.body.comments.map((c: { id: string }) => c.id).sort()).toEqual([...seeded.commentIds].sort());
    expect(response.body.deliveredCommentIds.sort()).toEqual([...seeded.commentIds].sort());
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.status).toBe("running");
    for (const id of seeded.commentIds) expect((run.resultJson as any).queuedSteeringAcknowledgements[id]).toMatchObject({
      status: "acknowledged", queueId: seeded.wakeId, delivery: "issue_comments_read",
    });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("cancelled");
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(queue.body.entries).toEqual([]);
    const retry = await request(agentApp).post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.comments).toHaveLength(2);
    expect(retry.body.deliveredCommentIds).toEqual([]);
    expect(steerNativeSessionMock).not.toHaveBeenCalled();
  });

  it("allows a question after external comment delivery, but still fences later user direction", async () => {
    const seeded = await seedQueue();
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId: seeded.issueId, paperclipWake: { comments: [] } },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    const agentApp = app(seeded.companyId, "queue-owner", seeded);
    const scope = { id: seeded.issueId, companyId: seeded.companyId };
    const input = { kind: "ask_user_questions" as const, sourceRunId: seeded.runId,
      payload: { version: 1 as const, questions: [{ id: "scope", prompt: "Which scope?",
        selectionMode: "single" as const, options: [{ id: "one", label: "One" }] }] } };
    const service = issueThreadInteractionService(db);
    await expect(service.create(scope, input, seeded)).rejects.toMatchObject({ status: 409,
      details: { reason: "newer_comment_not_delivered" } });
    const delivered = await request(agentApp).post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
    expect(delivered.status).toBe(200);
    expect(delivered.body.deliveredCommentIds.sort()).toEqual([...seeded.commentIds].sort());
    // A pre-upgrade receipt without a version is not proof until a fresh read.
    const [oldRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const oldReceipts = (oldRun.resultJson as any).queuedSteeringAcknowledgements;
    for (const receipt of Object.values(oldReceipts) as any[]) delete receipt.commentUpdatedAt;
    await db.update(heartbeatRuns).set({ resultJson: { ...oldRun.resultJson, queuedSteeringAcknowledgements: oldReceipts } })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await expect(service.create(scope, input, seeded)).rejects.toMatchObject({ status: 409,
      details: { reason: "newer_comment_not_delivered" } });
    const repeated = await request(agentApp).post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
    expect(repeated.status).toBe(200);
    expect(repeated.body.deliveredCommentIds).toEqual([]);
    expect(await service.create(scope, input, seeded)).toMatchObject({ kind: "ask_user_questions", status: "pending" });
    // Delivery is not approval, and the original launch snapshot stays unchanged.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect((run.contextSnapshot as any).paperclipWake.comments).toEqual([]);
    const [question] = await db.select().from(issueThreadInteractions);
    expect(question.resolvedAt).toBeNull();
    const laterId = randomUUID();
    await db.insert(issueComments).values({ id: laterId, companyId: seeded.companyId, issueId: seeded.issueId,
      authorType: "user", authorUserId: "queue-owner", body: "Do not promote yet." });
    await expect(service.create(scope, input, seeded)).rejects.toMatchObject({ status: 409,
      details: { reason: "newer_comment_not_delivered", commentIds: [laterId] } });
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(1);
    await db.delete(issueComments).where(eq(issueComments.id, laterId));
    await db.update(issueComments).set({ body: "Revised direction not yet read.",
      updatedAt: new Date(Date.now() + 1_000),
    }).where(eq(issueComments.id, seeded.commentIds[0]));
    await expect(service.create(scope, input, seeded)).rejects.toMatchObject({ status: 409,
      details: { reason: "newer_comment_not_delivered", commentIds: [seeded.commentIds[0]] } });
  });

  it.each(["board", "wrong_run", "wrong_agent", "cancelled", "cancelling", "expired", "other_issue", "malformed", "missing_boot", "missing_lease"])(
    "does not acknowledge queued comments for %s", async mode => {
      const seeded = await seedQueue();
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
      if (mode === "missing_boot") await db.update(heartbeatRuns).set({ controllerBootId: null }).where(eq(heartbeatRuns.id, seeded.runId));
      if (mode === "missing_lease") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, seeded.runId));
      if (mode === "cancelled") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, seeded.runId));
      if (mode === "cancelling") await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, seeded.runId));
      if (mode === "expired") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, seeded.runId));
      if (mode === "other_issue") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, seeded.runId));
      const actor = mode === "board" ? undefined : {
        agentId: mode === "wrong_agent" ? randomUUID() : seeded.agentId,
        runId: mode === "malformed" ? "not-a-run" : mode === "wrong_run" ? randomUUID() : seeded.runId,
      };
      const response = await request(app(seeded.companyId, "queue-owner", actor))
        .post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
      // An inaccessible agent must not learn that the issue exists.
      if (mode === "wrong_agent") expect(response.status).toBe(404);
      else expect([403, 409, 422]).toContain(response.status);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(wake.status).toBe("deferred_issue_execution");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect((run.resultJson as any)?.queuedSteeringAcknowledgements).toBeUndefined();
    },
  );

  it("acknowledges every ordinary deferred queue included in the delivered snapshot", async () => {
    const seeded = await seedQueue();
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
    const id = randomUUID();
    await db.insert(issueComments).values({ id, companyId: seeded.companyId, issueId: seeded.issueId,
      authorType: "user", authorUserId: "queue-owner", body: "Another wake" });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.insert(agentWakeupRequests).values({ ...wake, id: randomUUID(),
      payload: { issueId: seeded.issueId, _paperclipWakeContext: { wakeCommentIds: [id] } },
    });
    const response = await request(app(seeded.companyId, "queue-owner", seeded))
      .post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
    expect(response.status).toBe(200);
    expect(response.body.deliveredCommentIds.sort()).toEqual([...seeded.commentIds, id].sort());
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId));
    expect(wakes.map(w => w.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("does not consume a fresh-session approval when its comments are read", async () => {
    const seeded = await seedResponseQueue();
    const response = await request(app(seeded.companyId, "queue-owner", seeded))
      .post(`/api/issues/${seeded.issueId}/comments/delivery`).send({});
    expect(response.status).toBe(200);
    expect(response.body.deliveredCommentIds).toEqual([]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
    expect(wake.payload?.interactionId).toBe(seeded.interactionId);
  });

  it.each(["cancelled", "running"])("rejects a late Done from an interrupted %s task run at the write boundary", async status => {
    const seeded = await seedQueue();
    await db.update(heartbeatRuns).set({ status, resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, seeded.runId));
    // Model a request that passed middleware before cancellation and reached
    // the service after the run lost its authority. Recovery may have released
    // checkout and changed the task to Blocked in the meantime.
    await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await expect(issueService(db).update(seeded.issueId, { status: "done",
      actorAgentId: seeded.agentId, actorRunId: seeded.runId,
    })).rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0].status).toBe("blocked");
    // A board disposition remains authoritative.
    expect(await issueService(db).update(seeded.issueId, { status: "done", actorUserId: "queue-owner" }))
      .toMatchObject({ status: "done" });
  });

  it("delivers a saved Grok interrupt exactly once after remote cleanup, including concurrent restart sweeps", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "grok_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", errorCode: "operator_interrupted",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
      contextSnapshot: { issueId: seeded.issueId, paperclipWorkspace: { remoteExecution: { transport: "sandbox" } } },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: seeded.runId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    const [lease] = await db.insert(environmentLeases).values({ companyId: seeded.companyId,
      issueId: seeded.issueId, heartbeatRunId: seeded.runId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", leasePolicy: "ephemeral",
    }).returning();
    // Occupy the agent's slot on another task so this test never invokes a model.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: null,
    }).expect(200);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    // Cleanup timestamps alone are not proof. A mismatched receipt is not proof either.
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { ...remoteTerminationReceipt(lease, {
        providerLeaseId: lease.providerLeaseId, state: "destroyed",
      }), runId: randomUUID() } },
    }).where(eq(environmentLeases.id, lease.id));
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, {
      providerLeaseId: lease.providerLeaseId, state: "destroyed",
    }) } }).where(eq(environmentLeases.id, lease.id));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(delivered.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: seeded.commentIds, previousRunId: seeded.runId,
      forceFreshSession: true });
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });

  it("allows only the exact task mutation that stopped its own run to commit", async () => {
    const seeded = await seedQueue();
    const stopId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: stopId },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    const data = { status: "todo", actorAgentId: seeded.agentId, actorRunId: seeded.runId };
    await expect(issueService(db).update(seeded.issueId, { ...data, actorRunStopId: randomUUID() }))
      .rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect(await issueService(db).update(seeded.issueId, { ...data, actorRunStopId: stopId }))
      .toMatchObject({ status: "todo" });
    await expect(issueService(db).update(seeded.issueId, { ...data, status: "done" }))
      .rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
  });

  async function nativeHandoffClient(
    target: "human" | "report_agent" = "human", credential: "agent_jwt" | "agent_key" = "agent_jwt",
    observeRequest?: express.RequestHandler,
  ) {
    const seeded = await seedQueue();
    // Real bearer auth requires an existing responsible user and company membership.
    await db.insert(authUsers).values({
      id: "queue-owner", name: "Queue owner", email: "queue-owner@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    });
    // This is an outgoing native task turn, not the legacy human-handoff
    // exception. Do not let unrelated saved input obscure the stop/commit fence.
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(heartbeatRuns).set({ nativeIssueId: seeded.issueId })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ checkoutRunId: seeded.runId, createdByUserId: "queue-owner" })
      .where(eq(issues.id, seeded.issueId));
    const identity = await initializeRunIdentity(db, {
      companyId: seeded.companyId, issueId: seeded.issueId, runId: seeded.runId,
      responsibleUserId: "queue-owner", cause: "dispatch",
    });
    let reportAgentId: string | null = null;
    if (target === "report_agent") {
      reportAgentId = randomUUID();
      await db.update(agents).set({ name: "Task manager", role: "cto" })
        .where(eq(agents.id, seeded.agentId));
      await db.insert(agents).values({
        id: reportAgentId, companyId: seeded.companyId, name: "Permitted report", role: "engineer",
        status: "idle", reportsTo: seeded.agentId, adapterType: "paperclip_runner",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        // Require a real grant, rather than default-open assignment permission.
        permissions: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } },
      });
      await db.insert(companyMemberships).values({
        companyId: seeded.companyId, principalType: "agent", principalId: seeded.agentId,
        status: "active", membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values([
        { principalType: "agent", principalId: seeded.agentId },
        { principalType: "user", principalId: "queue-owner" },
      ].map(principal => ({
        ...principal, companyId: seeded.companyId, permissionKey: "tasks:assign_scope",
        scope: { managedSubtreeAgentIds: [seeded.agentId] }, grantedByUserId: "queue-owner",
      })));
      const scope = { issueId: seeded.issueId, assigneeAgentId: reportAgentId, assigneeUserId: null };
      expect(await authorizationService(db).decide({
        actor: { type: "agent", source: credential, companyId: seeded.companyId,
          agentId: seeded.agentId, runId: seeded.runId, onBehalfOfUserId: "queue-owner" },
        action: "tasks:assign", resource: { type: "issue", companyId: seeded.companyId, ...scope }, scope,
      })).toMatchObject({ allowed: true, reason: "allow_explicit_grant",
        grant: { principalType: "agent", principalId: seeded.agentId, permissionKey: "tasks:assign_scope" } });
      // Keep the report at capacity on unrelated work. Handoff admission can
      // queue its successor, but this test must never invoke a model/provider.
      await db.insert(heartbeatRuns).values({
        companyId: seeded.companyId, agentId: reportAgentId, status: "running", runtimeMode: "legacy",
        runtimeModeResolvedAt: new Date(), controllerBootId: randomUUID(),
        controllerLeaseExpiresAt: new Date(Date.now() + 60_000), contextSnapshot: { issueId: randomUUID() },
      });
    }
    const assignment = { assigneeAgentId: reportAgentId, assigneeUserId: reportAgentId ? null : "queue-owner" };
    let keyId: string | null = null;
    let token: string | null;
    if (credential === "agent_key") {
      token = `handoff-test-${randomUUID()}`;
      keyId = randomUUID();
      await db.insert(agentApiKeys).values({
        id: keyId, companyId: seeded.companyId, agentId: seeded.agentId, name: "Agent Tools fixture",
        keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: "queue-owner",
      });
    } else {
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "native-handoff-route-test-secret");
      token = createLocalAgentJwt(seeded.agentId, seeded.companyId, "paperclip_runner", seeded.runId, "queue-owner");
    }
    expect(token).toBeTruthy();
    const client = express();
    client.use(express.json());
    client.use((_req, res, next) => {
      res.locals.handoffRequestId = randomUUID();
      res.setHeader("X-Handoff-Test-Request-Id", res.locals.handoffRequestId);
      next();
    });
    if (observeRequest) client.use(observeRequest);
    client.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    client.use("/api", issueRoutes(db, {} as any, {}));
    const rawErrors: { requestId: string; method: string; path: string; error: unknown }[] = [];
    const captureRouteError: ErrorRequestHandler = (error, req, res, next) => {
      rawErrors.push({ requestId: res.locals.handoffRequestId, method: req.method, path: req.originalUrl,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error });
      next(error);
    };
    const errorsForRequest = (requestId: string | undefined) => rawErrors.filter(error => error.requestId === requestId);
    const errorsForResponse = (response: request.Response) => errorsForRequest(response.headers["x-handoff-test-request-id"]);
    client.use(captureRouteError);
    client.use(errorHandler);
    return { ...seeded, identity, client, errorsForRequest, errorsForResponse, assignment, reportAgentId, keyId, authorization: `Bearer ${token}` };
  }

  it.each((["human", "report_agent"] as const).flatMap(target => [false, true].map(withOverrides => ({ target, withOverrides }))))(
    "commits the HTTP native self-handoff to $target after stopping its own run, with adapter overrides: $withOverrides", async ({ target, withOverrides }) => {
    const seeded = await nativeHandoffClient(target);
    // Only the provider boundary is simulated. The HTTP auth, route stop token,
    // heartbeat cancellation, issue transaction and comment service stay real.
    const cancel = vi.spyOn(nativeSessionExecutor, "cancelNativeSession").mockImplementation(async (runId, _reason, options) => {
      expect(runId).toBe(seeded.runId);
      expect(options.scope).toBe("run");
      // Heartbeat requires both the run-scope decision and its audit receipt.
      // A null decision tests the unaudited-stop refusal, not a successful stop.
      const decision = nativeSessionExecutor.resolveNativeCancellationStatus({
        scope: "run", priorIssueStatus: "in_progress", agentId: seeded.agentId,
      });
      const receipt = {
        schema: "paperclip.native-cancellation.v1", runId, companyId: seeded.companyId,
        issueId: seeded.issueId, scope: "run", reasonCode: "cancellation_run_only",
        dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      };
      await options.db.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ nativeCancellation: receipt })}::jsonb`,
      }).where(eq(heartbeatRuns.id, runId));
      return { dispatched: true, decision, decisionId: randomUUID(), auditId: receipt.acknowledgementAuditId };
    });
    const body = {
      ...seeded.assignment, status: "todo",
      comment: target === "report_agent"
        ? "Handing this same task to my permitted report."
        : "Handing this same task back for the human decision.",
      ...(withOverrides ? { assigneeAdapterOverrides: { useProjectWorkspace: false } } : {}),
    };
    const response = await request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", seeded.authorization).send(body);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    // Check cancellation before the HTTP assertion so a RED distinguishes
    // request admission failure from a failure after a confirmed stop.
    const responseDiagnostic = `HTTP ${response.status}: ${JSON.stringify({ body: response.body, errors: seeded.errorsForResponse(response) })}`;
    expect(cancel, responseDiagnostic).toHaveBeenCalledTimes(1);
    expect(run, responseDiagnostic).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned",
      activeIdentityContextId: seeded.identity.id, responsibleUserId: "queue-owner",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: expect.any(String) },
    });
    expect(response.status, responseDiagnostic).toBe(200);
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task).toMatchObject({ id: seeded.issueId, ...seeded.assignment, status: "todo",
      checkoutRunId: null, executionRunId: null,
      assigneeAdapterOverrides: withOverrides ? { useProjectWorkspace: false } : null,
    });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments.filter(comment => comment.body === body.comment)).toEqual([
      expect.objectContaining({ authorType: "agent", authorAgentId: seeded.agentId,
        createdByRunId: seeded.runId, onBehalfOfUserId: "queue-owner" }),
    ]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId))).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.companyId, seeded.companyId))).toHaveLength(1);
    if (seeded.reportAgentId) {
      // The route enqueues assignment after commit. Observe that bounded
      // asynchronous work before teardown, without dispatching the successor.
      await vi.waitFor(async () => {
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.reportAgentId!));
        const wake = wakes.find(row => row.payload?.issueId === seeded.issueId);
        expect(wake).toMatchObject({ reason: "issue_assigned", requestedByActorType: "agent", requestedByActorId: seeded.agentId });
        expect(wake?.runId).toEqual(expect.any(String));
        const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
        expect(successor).toMatchObject({ agentId: seeded.reportAgentId, status: "queued",
          contextSnapshot: { issueId: seeded.issueId } });
      }, { timeout: 5_000 });
    }
    // The server-only stop token cannot authorize a replay or a later report.
    await request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", seeded.authorization).send(body).expect(403);
    await request(seeded.client).post(`/api/issues/${seeded.issueId}/comments`)
      .set("Authorization", seeded.authorization).send({ body: "Late report from the stopped turn" }).expect(403);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(comments.length);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each((["human", "report_agent"] as const).flatMap(target =>
    (["cancelled", "cancelling", "changed_owner"] as const).map(mode => ({ target, mode }))))(
    "refuses HTTP native handoff to $target from a $mode source without partial edits", async ({ target, mode }) => {
    const seeded = await nativeHandoffClient(target);
    const cancel = vi.spyOn(nativeSessionExecutor, "cancelNativeSession");
    if (mode === "changed_owner") {
      const ownerId = randomUUID();
      await db.insert(agents).values({ id: ownerId, companyId: seeded.companyId,
        name: "New task owner", role: "engineer", status: "idle", adapterType: "paperclip_runner" });
      await db.update(issues).set({ assigneeAgentId: ownerId, checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, seeded.issueId));
    } else {
      await db.update(heartbeatRuns).set(mode === "cancelled"
        ? { status: "cancelled", errorCode: "issue_reassigned", resultJson: {
            reassignmentStopConfirmed: true, issueMutationStopId: randomUUID(),
          } }
        : { resultJson: { executionCancellation: { state: "requested" } } })
        .where(eq(heartbeatRuns.id, seeded.runId));
    }
    const [before] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const response = await request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", seeded.authorization).send({
        ...seeded.assignment, status: "todo",
        comment: "This stale handoff must not land.",
        assigneeAdapterOverrides: { useProjectWorkspace: false },
      });
    expect(response.status, JSON.stringify({ body: response.body, errors: seeded.errorsForResponse(response) }))
      .toBe(mode === "changed_owner" ? 409 : 403);
    if (mode === "changed_owner") expect(response.body.details?.code).toBe("issue_write_assignee_run_lock");
    else expect(response.body.code).toBe("agent_run_cancelled");
    expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  async function ownedAdapterHandoffClient(observeRequest?: express.RequestHandler) {
    const seeded = await nativeHandoffClient("report_agent", "agent_key", observeRequest);
    await db.update(agents).set({ adapterType: "omnigent" }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), nativeIssueId: null,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    const control = createAdapterExecutionControl();
    let reportStop!: () => void;
    const stopRequested = new Promise<void>(resolve => { reportStop = resolve; });
    control.controller.signal.addEventListener("abort", reportStop, { once: true });
    await registerAdapterExecutionControl(seeded.runId, control);
    // Simulate only the owned adapter's provider acknowledgement and cleanup.
    // No adapter/provider is launched. The real route, auth, Stop and terminal
    // transaction retain their own ordering and cancellation metadata.
    const acknowledgeStop = async () => {
      expect(control.controller.signal.aborted).toBe(true);
      const [requested] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      return terminalizeLegacyExecution({ db, run: requested, status: "cancelled", reconcileIfNeeded: true,
        patch: { finishedAt: new Date(), resultJson: { ...requested.resultJson,
          executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() },
          executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
        } },
      });
    };
    const waitForQueuedHandoff = async () => {
      await vi.waitFor(async () => {
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.reportAgentId!));
        const wake = wakes.find(row => row.payload?.issueId === seeded.issueId);
        expect(wake).toMatchObject({ reason: "issue_assigned", runId: expect.any(String) });
        const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
        expect(successor).toMatchObject({ status: "queued", agentId: seeded.reportAgentId, contextSnapshot: { issueId: seeded.issueId } });
      }, { timeout: 5_000 });
    };
    return { ...seeded, control, stopRequested, acknowledgeStop, waitForQueuedHandoff };
  }

  it.each([false, true])(
    "characterizes agent-key owned-adapter HTTP handoff after Stop acknowledgement and settlement, with overrides: %s", async withOverrides => {
    const seeded = await ownedAdapterHandoffClient();
    const nativeCancel = vi.spyOn(nativeSessionExecutor, "cancelNativeSession");
    const body = { ...seeded.assignment, status: "todo", comment: "Handing the same task to my permitted report via Agent Tools.",
      ...(withOverrides ? { assigneeAdapterOverrides: { useProjectWorkspace: false } } : {}),
    };
    const [before] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id);
    let returned = false;
    const handoff = request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", seeded.authorization).set("X-Paperclip-Run-Id", seeded.runId).send(body)
      .then(response => { returned = true; return response; });
    try {
      const boundary = await Promise.race([
        seeded.stopRequested.then(() => ({ phase: "stop_requested" })),
        handoff.then(response => ({ phase: "response", status: response.status, body: response.body, errors: seeded.errorsForResponse(response) })),
      ]);
      expect(boundary, JSON.stringify(boundary)).toEqual({ phase: "stop_requested" });
      expect(adapterExecutionControls.get(seeded.runId)).toBe(seeded.control);
      const [requested] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(requested).toMatchObject({ status: "running", errorCode: "issue_reassigned", resultJson: {
        reassignmentStopConfirmed: true, issueMutationStopId: expect.any(String), executionCancellation: { state: "requested" },
      } });
      expect(returned).toBe(false);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id)).toEqual(commentsBefore);
      const stopped = await seeded.acknowledgeStop();
      expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned", resultJson: {
        issueMutationStopId: requested.resultJson!.issueMutationStopId, executionCancellation: { state: "acknowledged" },
      } });
      // A terminal receipt alone cannot release the route before owner cleanup.
      expect(returned).toBe(false);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
      seeded.control.finish();
      const response = await handoff;
      const diagnostic = `HTTP ${response.status}: ${JSON.stringify({ body: response.body, errors: seeded.errorsForResponse(response) })}`;
      expect(response.status, diagnostic).toBe(200);
      expect((await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, seeded.keyId!)))[0].lastUsedAt).toBeInstanceOf(Date);
      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(task).toMatchObject({ ...seeded.assignment, status: "todo", checkoutRunId: null, executionRunId: null,
        assigneeAdapterOverrides: withOverrides ? { useProjectWorkspace: false } : null,
      });
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id);
      expect(comments.filter(comment => comment.body === body.comment)).toEqual([
        expect.objectContaining({ authorType: "agent", authorAgentId: seeded.agentId,
          createdByRunId: seeded.runId, onBehalfOfUserId: "queue-owner" }),
      ]);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId))).toEqual([]);
      await seeded.waitForQueuedHandoff();
      const replay = await request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
        .set("Authorization", seeded.authorization).set("X-Paperclip-Run-Id", seeded.runId).send(body);
      expect.soft(replay.status, JSON.stringify({ body: replay.body, errors: seeded.errorsForResponse(replay) })).toBe(403);
      const late = await request(seeded.client).post(`/api/issues/${seeded.issueId}/comments`)
        .set("Authorization", seeded.authorization).set("X-Paperclip-Run-Id", seeded.runId)
        .send({ body: "Late report from the stopped Agent Tools turn" });
      expect.soft(late.status, JSON.stringify({ body: late.body, errors: seeded.errorsForResponse(late) })).toBe(403);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(task);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id)).toEqual(comments);
      expect(nativeCancel).not.toHaveBeenCalled();
    } finally {
      seeded.control.finish();
      try { await handoff; } finally { adapterExecutionControls.delete(seeded.runId); }
    }
  });

  it("commits agent-key owned-adapter HTTP handoff after client disconnect between Stop acknowledgement and settlement", async () => {
    let disconnected = false;
    let observedRequest = false;
    let requestId: string | undefined;
    const responseAttempts: { status: number; body: unknown }[] = [];
    const seeded = await ownedAdapterHandoffClient((req, res, next) => {
      if (req.header("X-Handoff-Test-Phase") === "disconnect") {
        observedRequest = true;
        requestId = res.locals.handoffRequestId;
        res.on("close", () => { disconnected = !res.writableFinished; });
        // Observe the original handler's completion even without a client socket.
        const json = res.json.bind(res);
        res.json = body => {
          responseAttempts.push({ status: res.statusCode, body });
          return json(body);
        };
      }
      next();
    });
    const server = createServer(seeded.client);
    const body = { ...seeded.assignment, status: "todo",
      comment: "The admitted same-task handoff must survive its tool client disconnecting.",
      assigneeAdapterOverrides: { useProjectWorkspace: false },
    };
    const [before] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id);
    let outgoing: ReturnType<typeof httpRequest> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected an isolated HTTP test server");
      const payload = JSON.stringify(body);
      outgoing = httpRequest({ host: "127.0.0.1", port: address.port,
        path: `/api/issues/${seeded.issueId}`, method: "PATCH", agent: false,
        headers: { Authorization: seeded.authorization, "X-Paperclip-Run-Id": seeded.runId,
          "X-Handoff-Test-Phase": "disconnect", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      });
      const clientResult = new Promise<{ event: string; status?: number; error?: string }>(resolve => {
        outgoing!.on("response", response => {
          response.resume();
          resolve({ event: "response", status: response.statusCode });
        });
        outgoing!.on("error", error => resolve({ event: "error", error: error.message }));
        outgoing!.on("close", () => resolve({ event: "close" }));
      });
      outgoing.end(payload);
      const boundary = await Promise.race([
        seeded.stopRequested.then(() => ({ phase: "stop_requested" })),
        clientResult.then(result => ({ phase: "client_result", ...result })),
      ]);
      expect(boundary, JSON.stringify({ boundary, responseAttempts })).toEqual({ phase: "stop_requested" });
      const stopped = await seeded.acknowledgeStop();
      expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned", resultJson: {
        reassignmentStopConfirmed: true, issueMutationStopId: expect.any(String), executionCancellation: { state: "acknowledged" },
      } });
      expect(responseAttempts).toEqual([]);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
      outgoing.destroy();
      expect((await clientResult).event).not.toBe("response");
      await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 5_000 });
      // The actual socket is gone while owner settlement is still held.
      expect(responseAttempts).toEqual([]);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id)).toEqual(commentsBefore);
      seeded.control.finish();
      await vi.waitFor(() => expect(responseAttempts,
        JSON.stringify({ responseAttempts, errors: seeded.errorsForRequest(requestId) })).toEqual([
        { status: 200, body: expect.objectContaining({ id: seeded.issueId, ...seeded.assignment, status: "todo" }) },
      ]), { timeout: 5_000 });
      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(task).toMatchObject({ ...seeded.assignment, status: "todo", checkoutRunId: null, executionRunId: null,
        assigneeAdapterOverrides: { useProjectWorkspace: false },
      });
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id);
      expect(comments).toHaveLength(commentsBefore.length + 1);
      expect(comments.filter(comment => comment.body === body.comment)).toEqual([
        expect.objectContaining({ authorType: "agent", authorAgentId: seeded.agentId,
          createdByRunId: seeded.runId, onBehalfOfUserId: "queue-owner" }),
      ]);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId))).toEqual([]);
      await seeded.waitForQueuedHandoff();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.reportAgentId!));
      expect(wakes.filter(wake => wake.payload?.issueId === seeded.issueId)).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "issue_reassigned",
          resultJson: { issueMutationStopId: stopped!.resultJson!.issueMutationStopId } });
      const replay = await request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
        .set("Authorization", seeded.authorization).set("X-Paperclip-Run-Id", seeded.runId).send(body);
      expect(replay.status, JSON.stringify({ body: replay.body, errors: seeded.errorsForResponse(replay) })).toBe(403);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(task);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id)).toEqual(comments);
    } finally {
      outgoing?.destroy();
      seeded.control.finish();
      try {
        // Drain the admitted handler before this case's database is truncated.
        if (observedRequest) await vi.waitFor(() => expect(responseAttempts.length).toBeGreaterThan(0), { timeout: 5_000 });
      } finally {
        adapterExecutionControls.delete(seeded.runId);
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      }
    }
  });

  it.each(["cancelled", "cancelling", "changed_owner"] as const)(
    "refuses agent-key owned-adapter HTTP handoff from a %s source without partial edits", async mode => {
    const seeded = await ownedAdapterHandoffClient();
    if (mode === "changed_owner") {
      const ownerId = randomUUID();
      await db.insert(agents).values({ id: ownerId, companyId: seeded.companyId,
        name: "Explicit new owner", role: "engineer", status: "idle", adapterType: "paperclip_runner" });
      await db.update(issues).set({ assigneeAgentId: ownerId, checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, seeded.issueId));
    } else {
      await db.update(heartbeatRuns).set(mode === "cancelled"
        ? { status: "cancelled", finishedAt: new Date(), errorCode: "issue_reassigned", resultJson: {
          reassignmentStopConfirmed: true, issueMutationStopId: randomUUID(), executionCancellation: { state: "acknowledged" },
        } }
        : { resultJson: { executionCancellation: { state: "requested" } } })
        .where(eq(heartbeatRuns.id, seeded.runId));
    }
    if (mode === "cancelled") {
      // Model completed owner settlement, not stale terminal locks whose normal
      // cleanup is independent of assignment/status mutation admission.
      await db.update(issues).set({ checkoutRunId: null, executionRunId: null,
        executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, seeded.issueId));
    }
    const [before] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const [runBefore] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id);
    const handoff = request(seeded.client).patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", seeded.authorization).set("X-Paperclip-Run-Id", seeded.runId).send({
        ...seeded.assignment, status: "todo", comment: "Stale Agent Tools handoff must not land.",
        assigneeAdapterOverrides: { useProjectWorkspace: false },
      }).then(response => response);
    try {
      const boundary = await Promise.race([
        handoff.then(response => ({ phase: "response", response })),
        seeded.stopRequested.then(() => ({ phase: "stop_requested", response: null })),
      ]);
      if (boundary.phase === "stop_requested") {
        // Unexpected Stop is a failure, but settle the fake owner so diagnostics
        // do not spend the real 60-second response budget or leak a request.
        await seeded.acknowledgeStop();
        seeded.control.finish();
      }
      const response = await handoff;
      if (response.status === 200) await seeded.waitForQueuedHandoff();
      const diagnostic = `HTTP ${response.status}: ${JSON.stringify({ body: response.body, errors: seeded.errorsForResponse(response), phase: boundary.phase })}`;
      expect.soft(response.status, diagnostic).toBe(mode === "changed_owner" ? 409 : 403);
      if (mode === "changed_owner") expect.soft(response.body.details?.code, diagnostic).toBe("issue_write_assignee_run_lock");
      else expect.soft(response.body.code ?? response.body.details?.code, diagnostic).toBe("agent_run_cancelled");
      expect.soft(seeded.control.controller.signal.aborted, diagnostic).toBe(false);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]).toEqual(runBefore);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId)).orderBy(issueComments.id)).toEqual(commentsBefore);
    } finally {
      seeded.control.finish();
      try { await handoff; } finally { adapterExecutionControls.delete(seeded.runId); }
    }
  });

  it.each(["questions", "verdicts"] as const)("rejects admitted %s responses after Stop revokes the run", async kind => {
    const seeded = await seedQueue();
    const service = issueThreadInteractionService(db);
    const issue = { id: seeded.issueId, companyId: seeded.companyId };
    const interaction = await service.create(issue, kind === "questions" ? {
      kind: "ask_user_questions", resolverPolicy: "board_or_agents", payload: { version: 1,
        questions: [{ id: "scope", prompt: "Choose scope", selectionMode: "single", options: [{ id: "first", label: "First" }] }],
      },
    } : {
      kind: "request_item_verdicts", resolverPolicy: "board_or_agents", payload: { version: 1,
        prompt: "Review the work",
        items: [{ id: "work", label: "Work" }],
      },
    }, { userId: "queue-owner" });
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const actor = { agentId: seeded.agentId, runId: seeded.runId };
    const responding = kind === "questions"
      ? service.answerQuestions(issue, interaction.id, { answers: [{ questionId: "scope", optionIds: ["first"] }] }, actor)
      : service.submitItemVerdicts(issue, interaction.id, { verdicts: [{ id: "work", verdict: "approve" }] }, actor);
    await expect(responding).rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status)
      .toBe("pending");
  });

  it.each((["request_confirmation", "request_checkbox_confirmation", "ask_user_questions"] as const)
    .flatMap(kind => (["legacy", "native"] as const).map(runtime => ({ kind, runtime }))))(
    "queues $kind resolution while its $runtime source run is still running",
    async ({ kind, runtime }) => {
      const seeded = await seedQueue();
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      if (runtime === "legacy") {
        await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, seeded.agentId));
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      testProcesses.set(seeded.runId, child);
      runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
        kind, status: "pending", createdByAgentId: seeded.agentId, sourceRunId: seeded.runId,
        continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
        payload: kind === "ask_user_questions"
          ? { version: 1, questions: [{ id: "runtime", prompt: "Which runtime?", selectionMode: "single", required: true,
              options: [{ id: "node", label: "Node.js" }, { id: "python", label: "Python" }] }] }
          : kind === "request_checkbox_confirmation"
            ? { version: 1, prompt: "Accept scope", options: [{ id: "scope", label: "Build the app" }] }
            : { version: 1, prompt: "Build the app?", detailsMarkdown: "Create exactly one child task." },
      });
      const client = app(seeded.companyId);
      await request(client).post(`/api/issues/${seeded.issueId}/interactions/${interactionId}/${kind === "ask_user_questions" ? "respond" : "accept"}`)
        .send(kind === "ask_user_questions" ? { answers: [{ questionId: "runtime", optionIds: ["node"] }] }
          : kind === "request_checkbox_confirmation" ? { selectedOptionIds: ["scope"] } : {}).expect(200);
      await vi.waitFor(async () => {
        const receipts = await db.select().from(agentWakeupRequests);
        expect(receipts.some(row => row.status === "deferred_issue_execution")).toBe(true);
      });
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(queue.body.entries).toHaveLength(1);
      expect(queue.body.entries[0]).toMatchObject({
        source: { kind: "interaction", interactionId, interactionKind: kind },
        canEdit: false, canDiscard: false,
      });
      expect(queue.body.targetRunId).toBe(seeded.runId);
      expect(queue.body.entries[0].comment.body).toContain(kind === "ask_user_questions" ? "Node.js" : "Accepted");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]!.status).toBe("running");
      const wakes = await db.select().from(agentWakeupRequests);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    },
  );

  async function seedResponseQueue(native = false) {
    const seeded = await seedQueue();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "request_confirmation", status: "accepted", createdByAgentId: seeded.agentId,
      sourceRunId: seeded.runId, resolvedByUserId: "queue-owner", resolvedAt: new Date(),
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      title: "Build the app", payload: { version: 1, prompt: "Build the app?" },
      result: { decision: "accepted" },
    });
    const context = { issueId: seeded.issueId, interactionId, interactionKind: "request_confirmation",
      interactionStatus: "accepted", planReviewInteraction: { id: interactionId,
        acceptedTargetRevision: { documentId: "plan-1", revisionId: "revision-1" } } };
    await db.update(agentWakeupRequests).set({ payload: { issueId: seeded.issueId,
      mutation: "interaction", interactionId, interactionStatus: "accepted", _paperclipWakeContext: context },
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    if (!native) {
      await db.update(agents).set({ adapterType: "claude_local",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, seeded.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
    }
    return { ...seeded, interactionId, context };
  }

  it("keeps messages and approvals in separate durable queues in either arrival order", async () => {
    const seeded = await seedResponseQueue();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    const client = app(seeded.companyId);
    await request(client).post(`/api/issues/${seeded.issueId}/comments`)
      .send({ body: "Keep this message too" }).expect(201);
    await vi.waitFor(async () => expect(await db.select().from(agentWakeupRequests)).toHaveLength(2));
    let wakes = await db.select().from(agentWakeupRequests);
    expect(wakes.find(w => w.id === seeded.wakeId)?.payload).not.toHaveProperty("commentId");
    // A second resolved card must not overwrite either existing receipt.
    const nextId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: nextId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "request_confirmation", status: "pending", createdByAgentId: seeded.agentId,
      sourceRunId: seeded.runId, continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit", payload: { version: 1, prompt: "Second approval?" },
    });
    await request(client).post(`/api/issues/${seeded.issueId}/interactions/${nextId}/accept`).send({}).expect(200);
    wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(3);
    expect(wakes.filter(w => w.payload?.mutation === "interaction").map(w => w.payload?.interactionId).sort())
      .toEqual([seeded.interactionId, nextId].sort());
    expect(wakes.find(w => w.payload?.commentId)?.payload?._paperclipWakeContext).not.toHaveProperty("interactionId");
  });

  it("recovers an approval acknowledged before the steering transaction failed without redelivery", async () => {
    const seeded = await seedResponseQueue(true);
    await seedDispatchIdentity(seeded);
    // Reconstruct the durable state after acknowledgement and HTTP rollback.
    const [pending] = await db.insert(runIdentityContexts).values({
      companyId: seeded.companyId, runId: seeded.runId, revision: 2,
      cause: "steering", correlationId: `interaction:${seeded.interactionId}`,
      messageId: seeded.interactionId, responsibleUserId: "queue-owner", status: "pending",
    }).returning();
    await db.insert(heartbeatRunEvents).values({
      companyId: seeded.companyId, runId: seeded.runId, agentId: seeded.agentId,
      seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "approval-ack", itemId: `approval-ack:steer:${seeded.interactionId}`,
        payload: { kind: "steering_acknowledgement" } } },
    });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const body = { queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision };
    const endpoint = `/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`;
    const count = steerNativeSessionMock.mock.calls.length;
    await request(client).post(endpoint).send(body).expect(200);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(count);
    expect((await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, pending.id)))[0].status).toBe("accepted");
  });

  it("interrupts an active legacy run and delivers the exact approval once", async () => {
    const seeded = await seedResponseQueue();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    await db.update(heartbeatRuns).set({ processPid: child.pid }).where(eq(heartbeatRuns.id, seeded.runId));
    // Occupy another task to inspect admission without invoking a paid provider.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision }).expect(200);
    runningProcesses.delete(seeded.runId);
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(["queued", "coalesced"]).toContain(wake.status);
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.status).toBe("queued");
    expect(successor.contextSnapshot).toMatchObject(seeded.context);
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  it("steers a saved approval only on click and acknowledges retries once", async () => {
    const seeded = await seedResponseQueue(true);
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "approval-turn" });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const body = { queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision };
    const endpoint = `/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`;
    await request(client).post(endpoint).send(body).expect(200);
    const delivered = steerNativeSessionMock.mock.calls.at(-1)![0];
    expect(delivered.message).toContain(seeded.interactionId);
    expect(delivered.message).toContain('"status": "accepted"');
    expect((await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.messageId, seeded.interactionId)))[0])
      .toMatchObject({ status: "accepted", responsibleUserId: "queue-owner", cause: "steering" });
    const callCount = steerNativeSessionMock.mock.calls.length;
    await request(client).post(endpoint).send(body).expect(200);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(callCount);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status).toBe("cancelled");
    expect(await db.select().from(issueComments)).toHaveLength(2); // no forged approval comment
  });

  it.each([false, true])("lets the source run finish review after acceptance, before wake persistence: %s", async (beforeWake) => {
    const seeded = await seedResponseQueue();
    if (beforeWake) await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const client = app(seeded.companyId, "queue-owner", { agentId: seeded.agentId, runId: seeded.runId });
    const result = await request(client).patch(`/api/issues/${seeded.issueId}`).send({ status: "in_review", reviewInteractionId: seeded.interactionId });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task.assigneeAgentId).toBe(seeded.agentId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  it.each(["legacy", "native"] as const)("resumes a queued plan approval across a stopped %s run only after cleanup", async (runtime) => {
    const seeded = await seedResponseQueue(runtime === "native");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, seeded.agentId));
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...receipt.payload,
      _paperclipWakeContext: { ...seeded.context, forceFreshSession: true } },
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "process_lost", processPid: process.pid })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: runtime === "legacy" ? "legacy_execution_requires_reconciliation" : "native_continuation_requires_reconciliation",
      fingerprint: seeded.runId, status: "resolved", outcome: "blocked", nextAction: "Inspect stopped execution",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`)
      .send({ queueId: seeded.wakeId, targetRunId: null, revision: queue.body.revision }).expect(200);
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(waiting.status).toBe("deferred_issue_execution");
    expect(waiting.payload?.executionWait).toMatchObject({ reason: "process_running" });
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, seeded.runId));
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot).toMatchObject({ ...seeded.context, forceFreshSession: true, previousRunId: seeded.runId });
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  it("keeps queued approval content immutable through comment mutation endpoints", async () => {
    const seeded = await seedResponseQueue();
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const body = { queueId: seeded.wakeId, revision: queue.body.revision };
    await request(client).patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}`)
      .send({ ...body, body: "Reject instead" }).expect(409);
    await request(client).delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}`).send(body).expect(409);
    await request(client).put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({ ...body, orderedCommentIds: [seeded.interactionId] }).expect(409);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, seeded.interactionId)))[0].status).toBe("accepted");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status).toBe("deferred_issue_execution");
  });

  it("does not let a viewer steer someone else's approval", async () => {
    const seeded = await seedResponseQueue(true);
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, "queue-owner"));
    const calls = steerNativeSessionMock.mock.calls.length;
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision }).expect(403);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(calls);
  });

  it("does not steer a plan approval that requires a fresh execution session", async () => {
    const seeded = await seedResponseQueue(true);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      _paperclipWakeContext: { ...seeded.context, forceFreshSession: true } } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries[0].source.requiresFreshSession).toBe(true);
    const calls = steerNativeSessionMock.mock.calls.length;
    const result = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision }).expect(409);
    expect(result.body.details.code).toBe("queued_response_requires_fresh_session");
    expect(steerNativeSessionMock.mock.calls).toHaveLength(calls);
  });

  it("rejects stale agent handback without cancelling the accepted proposal's run", async () => {
    const seeded = await seedResponseQueue();
    await db.update(issues).set({ createdByUserId: "queue-owner" }).where(eq(issues.id, seeded.issueId));
    const client = app(seeded.companyId, "queue-owner", { agentId: seeded.agentId, runId: seeded.runId });
    const result = await request(client).patch(`/api/issues/${seeded.issueId}`)
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: "queue-owner" }).expect(409);
    expect(result.body.details.code).toBe("interaction_response_queued");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  it("promotes an approval after normal completion without a click", async () => {
    const seeded = await seedResponseQueue();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    await heartbeatService(db).resumeQueuedRuns();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("queued");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot).toMatchObject(seeded.context);
    await heartbeatService(db).resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  it.each(["stale revision", "native run", "different issue"] as const)(
    "rejects queued interruption for a %s without stopping the run",
    async (scenario) => {
      const seeded = await seedQueue();
      if (scenario !== "native run") {
        await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, seeded.agentId));
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      if (scenario === "different issue") {
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
        queueId: seeded.wakeId, targetRunId: seeded.runId,
        revision: scenario === "stale revision" ? "stale" : queue.body.revision,
      }).expect(409);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]!.status).toBe("running");
    },
  );

  it("does not accept interruption authority from an agent wake payload", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, seeded.runId));
    await heartbeatService(db).wakeup(seeded.agentId, {
      source: "on_demand", reason: "issue_commented",
      requestedByActorType: "agent", requestedByActorId: seeded.agentId,
      payload: { issueId: seeded.issueId, commentId: seeded.commentIds[1],
        queuedCommentInterrupt: { actorId: "other-operator", requestedAt: new Date().toISOString() } },
      contextSnapshot: { issueId: seeded.issueId, wakeCommentId: seeded.commentIds[1] },
    });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId));
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes.every(wake => !wake.payload?.queuedCommentInterrupt)).toBe(true);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId));
    expect(runs.find(run => run.id === seeded.runId)?.status).toBe("running");
    expect(runs.every(run => !run.contextSnapshot?.explicitUserContinuation)).toBe(true);
  });

  it("denies a viewer's interrupt before persisting intent or cancelling a run", async () => {
    const seeded = await seedQueue();
    await db.update(companyMemberships).set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.principalId, "other-operator"));
    const client = app(seeded.companyId, "other-operator");
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: seeded.runId,
    }).expect(403);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.payload?.queuedCommentInterrupt).toBeUndefined();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  it.each([null, "stopped-target", "system-receipt"])("sends a stopped legacy queue once with target %s", async (target) => {
    const seeded = await seedQueue();
    if (target === "system-receipt") await db.update(agentWakeupRequests).set({
      requestedByActorType: "system", requestedByActorId: "heartbeat",
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    // Occupy this agent on a different task so the actual successor remains
    // queued and the test never launches a provider.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const client = app(seeded.companyId, "other-operator");
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.targetRunId).toBeNull();
    const body = { queueId: seeded.wakeId, revision: queue.body.revision,
      targetRunId: target === "stopped-target" ? seeded.runId : null };
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send(body).expect(200);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.status).toBe("queued");
    expect(successor.responsibleUserId).toBe("other-operator");
    const identity = await initializeRunIdentity(db, {
      companyId: seeded.companyId, issueId: seeded.issueId,
      runId: successor.id, messageIds: seeded.commentIds, responsibleUserId: "queue-owner", cause: "dispatch",
    });
    expect(identity.responsibleUserId).toBe("other-operator");
    expect(identity.cause).toBe("queued_comment_interrupt");
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send(body).expect(409);
  });

  it.each([
    ["other", "running"], ["other", "queued"], ["other", "scheduled_retry"],
    ["same", "running"], ["same", "queued"], ["same", "scheduled_retry"],
  ] as const)("scopes interrupted queue successors to its agent: %s agent %s", async (owner, status) => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      queuedCommentInterrupt: { actorId: "other-operator", requestedAt: new Date().toISOString() },
    } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    // Keep this agent at capacity so successful delivery queues a successor
    // without launching a provider. The independent run shares only the task.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const successorAgentId = owner === "same" ? seeded.agentId : randomUUID();
    if (owner === "other") await db.insert(agents).values({ id: successorAgentId,
      companyId: seeded.companyId, name: "Independent agent", role: "engineer",
      status: "idle", adapterType: "claude_local",
    });
    const [existingRun] = await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: successorAgentId,
      status, contextSnapshot: { issueId: seeded.issueId },
    }).returning();

    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId, { retryCleanup: true });
    if (owner === "other" && status !== "scheduled_retry") {
      // Another agent is not this queue's successor, but ordinary admission
      // must still preserve the task execution lock until its work stops.
      const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(waiting.status).toBe("deferred_issue_execution");
      expect(task.executionRunId).toBe(existingRun.id);
      expect(waiting.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "other-operator" });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, existingRun.id));
      await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId, { retryCleanup: true });
    }
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(receipt.status).toBe(owner === "same" ? "deferred_issue_execution" : "coalesced");
    if (owner === "other") {
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
      expect(successor).toMatchObject({ agentId: seeded.agentId, status: "queued", responsibleUserId: "other-operator" });
      expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    }
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId, { retryCleanup: true });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId)))
      .toHaveLength(owner === "same" ? 3 : 4);
  });

  it.each(["user", "system"])("keeps stopped-run interruption intent on a %s receipt across restart until the process stops, then delivers once", async (actorType) => {
    const seeded = await seedQueue();
    await db.update(agentWakeupRequests).set({ requestedByActorType: actorType })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed",
      processPid: process.pid, errorCode: "process_lost",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: seeded.runId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const client = app(seeded.companyId, "other-operator");
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: null,
    }).expect(200);
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(waiting.status).toBe("deferred_issue_execution");
    expect(waiting.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "other-operator" });
    expect(waiting.payload?.executionWait).toMatchObject({ reason: "process_running" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(2);
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    // New service instances have no memory of the HTTP request. Concurrent
    // periodic workers must consume its durable receipt exactly once.
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(delivered.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: seeded.commentIds,
      previousRunId: seeded.runId, forceFreshSession: true });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });

  it.each(["user", "system", "manual_receipt_other_actor", "rejected_admission", "consumed_first", "consumed_last", "deleted_first", "agent_first", "cancelled_queued"])("delivers saved user messages on a %s queue after automatic recovery stopped, without another click", async (actorType) => {
    const seeded = await seedQueue();
    await db.update(agentWakeupRequests).set({ requestedByActorType: actorType === "user" ? "user" : "system" })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    if (actorType === "manual_receipt_other_actor") {
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      await db.update(agentWakeupRequests).set({ requestedByActorType: "user", requestedByActorId: "other-operator",
        payload: { ...saved.payload, manualUserWake: true },
      }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    }
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed",
      processPid: process.pid, errorCode: "process_lost", finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: seeded.runId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    // Leave the agent's only slot occupied on another task so dispatch stays queued.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    await heartbeatService(db).resumeQueuedRuns();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, seeded.runId));
    const excludedIndex = actorType === "consumed_last" ? 1 : 0;
    const filtersInput = ["consumed_first", "consumed_last", "deleted_first", "agent_first"].includes(actorType);
    if (actorType.startsWith("consumed_")) await db.update(heartbeatRuns).set({
      contextSnapshot: { issueId: seeded.issueId, wakeCommentIds: [seeded.commentIds[excludedIndex]] },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    if (actorType === "deleted_first") await db.update(issueComments).set({ deletedAt: new Date() })
      .where(eq(issueComments.id, seeded.commentIds[0]));
    if (actorType === "agent_first") await db.update(issueComments).set({
      authorType: "agent", authorUserId: null, authorAgentId: seeded.agentId,
    }).where(eq(issueComments.id, seeded.commentIds[0]));
    const expectedIds = seeded.commentIds.filter((_, index) => !filtersInput || index !== excludedIndex);
    if (actorType === "cancelled_queued") await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId, agentId: seeded.agentId, status: "cancelled", runtimeMode: "legacy",
      errorCode: "agent_paused", createdAt: new Date(0), finishedAt: new Date(1),
      contextSnapshot: { issueId: seeded.issueId, wakeCommentIds: [seeded.commentIds[0]] },
    });
    if (actorType === "rejected_admission") {
      await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
        status: "cancelled", runtimeMode: "legacy", errorCode: "execution_reconciliation_required",
        contextSnapshot: { issueId: seeded.issueId }, finishedAt: new Date(),
      });
    }
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(delivered.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: expectedIds,
      previousRunId: seeded.runId, forceFreshSession: true });
    if (actorType === "manual_receipt_other_actor") {
      const [dispatch] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor.wakeupRequestId!));
      expect(dispatch.requestedByActorId).toBe("queue-owner");
      expect(dispatch.payload?.manualUserWake).toBeUndefined();
      expect(successor.responsibleUserId).toBe("queue-owner");
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(["rejected_admission", "cancelled_queued"].includes(actorType) ? 4 : 3);
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    expect(recovery.evidence.automaticRecovery).toMatchObject({ actionOutcome: "unknown" });
  });

  it("recovers a message deferred after legacy finalization released the task lock", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    await heartbeatService(db).resumeQueuedRuns();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("queued");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    await heartbeatService(db).resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });

  async function promoteQueue(seeded: Awaited<ReturnType<typeof seedQueue>>) {
    const queueRunId = randomUUID();
    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    const wakeContext = (wake?.payload as any)?._paperclipWakeContext ?? {};
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-08-22T15:05:00.000Z") })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(heartbeatRuns).values({
      id: queueRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "issue_comment",
      triggerDetail: "queue route promotion test",
      status: "queued",
      runtimeMode: "native",
      wakeupRequestId: seeded.wakeId,
      contextSnapshot: {
        issueId: seeded.issueId,
        wakeReason: "issue_reopened_via_comment",
        ...wakeContext,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ status: "queued", runId: queueRunId })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db
      .update(issues)
      .set({ executionRunId: queueRunId })
      .where(eq(issues.id, seeded.issueId));
    return queueRunId;
  }

  it("projects the recovery wait reason only while the message is deferred", async () => {
    const seeded = await seedQueue();
    const executionWait = { reason: "remote_cleanup", message: "Waiting for the previous environment to stop." };
    await db.update(agentWakeupRequests).set({
      payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ executionWait })}::jsonb`,
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const waiting = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(waiting.status).toBe(200);
    expect(waiting.body.executionWait).toEqual(executionWait);
    await promoteQueue(seeded);
    const admitted = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(admitted.status).toBe(200);
    expect(admitted.body.executionWait).toBeUndefined();
  });

  it("returns the authoritative order, preserves full Markdown edits, and rejects stale revisions", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body).toMatchObject({
      issueId: seeded.issueId,
      queueId: seeded.wakeId,
      state: "deferred",
      targetRunId: seeded.runId,
      protocol: "paperclip_runner_v1",
      entries: [
        { position: 0, canEdit: true, canDiscard: true, comment: { id: seeded.commentIds[0] } },
        { position: 1, canEdit: true, canDiscard: true, comment: { id: seeded.commentIds[1] } },
      ],
    });

    const markdown = "  Keep **all** Markdown.  \n";
    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: markdown });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.entries[0].comment.body).toBe(markdown);
    expect(edited.body.revision).not.toBe(initial.body.revision);
    const stored = await db.select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(stored?.body).toBe(markdown);

    const stale = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "stale" });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.code).toBe("queued_comment_revision_conflict");
  });

  it("writes one activity log row for each successful queue mutation, and none for a rejected one", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "edited body" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const staleEdit = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "stale" });
    expect(staleEdit.status).toBe(409);

    const editRows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_edited"));
    expect(editRows).toHaveLength(1);
    expect(editRows[0]?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      queueId: seeded.wakeId,
      revision: edited.body.revision,
    });

    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: edited.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    const reorderRow = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comments_reordered"))
      .then((rows) => rows[0]);
    expect(reorderRow?.details).toMatchObject({
      queueId: seeded.wakeId,
      revision: reordered.body.revision,
      orderedCommentIds: [...seeded.commentIds].reverse(),
    });

    const discarded = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[1]}`)
      .send({ queueId: seeded.wakeId, revision: reordered.body.revision });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    const discardRow = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_discarded"))
      .then((rows) => rows[0]);
    expect(discardRow?.details).toMatchObject({
      commentId: seeded.commentIds[1],
      queueId: seeded.wakeId,
      revision: discarded.body.revision,
      cancelledRunId: null,
    });
  });

  it("preserves reordered messages across promotion and cancels the queued run after final trash", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: initial.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: any) => entry.comment.id)).toEqual([...seeded.commentIds].reverse());

    const queueRunId = await promoteQueue(seeded);
    const promoted = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(promoted.body).toMatchObject({
      queueId: seeded.wakeId,
      state: "queued",
      targetRunId: null,
      revision: reordered.body.revision,
    });

    const afterFirstTrash = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[1]}`)
      .send({ queueId: seeded.wakeId, revision: promoted.body.revision });
    expect(afterFirstTrash.status, JSON.stringify(afterFirstTrash.body)).toBe(200);
    expect(afterFirstTrash.body.entries.map((entry: any) => entry.comment.id)).toEqual([seeded.commentIds[0]]);
    const queuedRunAfterFirstTrash = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queueRunId))
      .then((rows) => rows[0]);
    expect((queuedRunAfterFirstTrash?.contextSnapshot as any)?.wakeCommentIds).toEqual([
      seeded.commentIds[0],
    ]);

    const emptied = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: afterFirstTrash.body.revision });
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
    expect(emptied.body.entries).toEqual([]);
    const wake = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("cancelled");
    const [queueRun, storedIssue] = await Promise.all([
      db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]),
      db.select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0]),
    ]);
    expect(queueRun?.status).toBe("cancelled");
    expect(storedIssue?.executionRunId).toBeNull();

    // Two discards happen in this scenario (the first trash, then the final
    // one that empties the queue), so match the row by its own commentId
    // instead of assuming insertion order.
    const discardRows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_discarded"));
    const finalDiscardRow = discardRows.find(
      (row) => (row.details as { commentId?: string } | null)?.commentId === seeded.commentIds[0],
    );
    expect(finalDiscardRow?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      cancelledRunId: queueRunId,
    });
  });

  it("keeps a mutation response's steering disposition in step with a fresh GET after promotion", async () => {
    const seeded = await seedQueue();
    await promoteQueue(seeded);
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.body.steeringDisposition).toBe("temporarily_unavailable");

    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "edited during promotion" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const afterEdit = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(edited.body.steeringDisposition).toBe(afterEdit.body.steeringDisposition);

    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: edited.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    const afterReorder = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(reordered.body.steeringDisposition).toBe(afterReorder.body.steeringDisposition);
  });

  it("returns entry objects with the same keys as the GET endpoint", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "edited body" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(Object.keys(edited.body.entries[0]).sort()).toEqual(Object.keys(initial.body.entries[0]).sort());
  });

  it("cancels the deferred wake when the final message is discarded before promotion", async () => {
    const seeded = await seedQueue();
    await db.delete(issueComments).where(eq(issueComments.id, seeded.commentIds[1]));
    await db
      .update(agentWakeupRequests)
      .set({
        payload: {
          issueId: seeded.issueId,
          commentId: seeded.commentIds[0],
          _paperclipWakeContext: {
            commentId: seeded.commentIds[0],
            wakeCommentId: seeded.commentIds[0],
            wakeCommentIds: [seeded.commentIds[0]],
          },
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const discarded = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    const [wake, runs] = await Promise.all([
      db.select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns),
    ]);
    expect(wake?.status).toBe("cancelled");
    expect(runs.map((run) => run.id)).toEqual([seeded.runId]);
  });

  it("routes legacy queued-comment cancellation through the promoted queue", async () => {
    const seeded = await seedQueue();
    const queueRunId = await promoteQueue(seeded);
    const cancelled = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.id).toBe(seeded.commentIds[0]);
    const [wake, queueRun] = await Promise.all([
      db.select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
      db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]),
    ]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual([
      seeded.commentIds[1],
    ]);
    expect((queueRun?.contextSnapshot as any)?.wakeCommentIds).toEqual([
      seeded.commentIds[1],
    ]);
  });

  it("reports an explicit conflict after queued-run dispatch has begun", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const queueRunId = await promoteQueue(seeded);
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, queueRunId));

    const discard = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discard.status).toBe(409);
    expect(discard.body.details?.code).toBe("queued_comment_already_dispatching");
    const comment = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(comment?.id).toBe(seeded.commentIds[0]);
  });

  it("limits edit and trash to the comment owner", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId, "other-operator"))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.status).toBe(200);
    expect(initial.body.entries[0]).toMatchObject({ canEdit: false, canDiscard: false });

    const edit = await request(app(seeded.companyId, "other-operator"))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "not mine" });
    expect(edit.status).toBe(403);
    const discard = await request(app(seeded.companyId, "other-operator"))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discard.status).toBe(403);
  });

  it("leaves the selected row queued when no native steering session is attached", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.body.steeringDisposition).toBe("temporarily_unavailable");

    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({
      code: "steering_temporarily_unavailable",
      retryable: true,
    });
    const queueAfterFailure = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(queueAfterFailure.body.entries.map((entry: any) => entry.comment.id)).toEqual(seeded.commentIds);
  });

  it("returns the persisted acknowledgement when the final steering response is retried", async () => {
    const seeded = await seedQueue();
    await db.delete(issueComments).where(eq(issueComments.id, seeded.commentIds[1]));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: new Date("2026-08-22T15:04:00.000Z"),
        payload: {
          issueId: seeded.issueId,
          commentId: seeded.commentIds[0],
          _paperclipWakeContext: {
            commentId: seeded.commentIds[0],
            wakeCommentId: seeded.commentIds[0],
            wakeCommentIds: [seeded.commentIds[0]],
          },
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          queuedSteeringAcknowledgements: {
            [seeded.commentIds[0]]: {
              status: "acknowledged",
              queueId: seeded.wakeId,
              turnId: "turn-acknowledged",
              acknowledgedAt: "2026-08-22T15:04:00.000Z",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const retried = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({
        queueId: seeded.wakeId,
        targetRunId: seeded.runId,
        revision: "response-was-lost-before-the-client-stored-the-revision",
      });

    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({
      issueId: seeded.issueId,
      queueId: null,
      state: null,
      entries: [],
    });
    const activity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_steered"))
      .then((rows) => rows[0]);
    expect(activity?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      targetRunId: seeded.runId,
      turnId: "turn-acknowledged",
      duplicate: true,
    });
  });

  it("does not reuse an acknowledgement from a different queue", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          queuedSteeringAcknowledgements: {
            [seeded.commentIds[0]]: {
              status: "acknowledged",
              queueId: randomUUID(),
              turnId: "turn-from-another-queue",
              acknowledgedAt: "2026-08-22T15:04:00.000Z",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({
        queueId: seeded.wakeId,
        targetRunId: seeded.runId,
        revision: initial.body.revision,
      });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({
      code: "steering_temporarily_unavailable",
      retryable: true,
    });
    const queueAfterFailure = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(queueAfterFailure.body.entries.map((entry: any) => entry.comment.id))
      .toEqual(seeded.commentIds);
  });

  it("keeps queue edits available during handoff but rejects stale same-turn steering", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-08-22T15:05:00.000Z") })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const edit = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({
        queueId: seeded.wakeId,
        revision: initial.body.revision,
        body: "edited during handoff",
      });

    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const stored = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(stored?.body).toBe("edited during handoff");
    const steer = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({
        queueId: seeded.wakeId,
        targetRunId: seeded.runId,
        revision: edit.body.revision,
      });
    expect(steer.status).toBe(409);
    expect(steer.body.details?.code).toBe("queued_comment_stale_target");
    const wake = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual(seeded.commentIds);
  });

  it("cancels a queued continuation whose comments disappeared before claim", async () => {
    const seeded = await seedQueue();
    const queueRunId = await promoteQueue(seeded);
    await db.delete(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await heartbeat.resumeQueuedRuns();

    const [queueRun, wake] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]),
      db.select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
    ]);
    expect(queueRun).toMatchObject({
      status: "cancelled",
      errorCode: "queued_comment_discarded",
    });
    expect(wake?.status).toBe("cancelled");
  });

  it("keeps a persisted legacy queue on the legacy protocol after the agent changes adapters", async () => {
    const seeded = await seedQueue();
    const queueRunId = await promoteQueue(seeded);
    await db
      .update(heartbeatRuns)
      .set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, queueRunId));

    const queued = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body).toMatchObject({
      queueId: seeded.wakeId,
      state: "queued",
      targetRunId: null,
      protocol: "legacy",
      steeringDisposition: "unsupported",
    });
  });

  it.each(["paperclip_runner", "codex_local"])("keeps Steer during native preparation even after agent settings change to %s", async adapterType => {
    const seeded = await seedQueue();
    const steeringCalls = steerNativeSessionMock.mock.calls.length;
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(agents).set({ adapterType }).where(eq(agents.id, seeded.agentId));
    const client = app(seeded.companyId);
    const initial = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(initial.body).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "temporarily_unavailable" });
    const edited = await request(client).patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "Updated direction" }).expect(200);
    expect(edited.body).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "temporarily_unavailable" });
    expect(steerNativeSessionMock.mock.calls).toHaveLength(steeringCalls);
  });

  it("serializes discard against queued-run claim", async () => {
    const seeded = await seedQueue();
    await db.delete(issueComments).where(eq(issueComments.id, seeded.commentIds[1]));
    await db
      .update(agentWakeupRequests)
      .set({
        payload: {
          issueId: seeded.issueId,
          commentId: seeded.commentIds[0],
          _paperclipWakeContext: {
            commentId: seeded.commentIds[0],
            wakeCommentId: seeded.commentIds[0],
            wakeCommentIds: [seeded.commentIds[0]],
          },
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const queueRunId = await promoteQueue(seeded);
    await db
      .update(agents)
      .set({
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      })
      .where(eq(agents.id, seeded.agentId));
    await db
      .update(heartbeatRuns)
      .set({ runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, queueRunId));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    const [discard] = await Promise.all([
      request(app(seeded.companyId))
        .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
        .send({ queueId: seeded.wakeId, revision: initial.body.revision }),
      heartbeat.resumeQueuedRuns(),
    ]);

    const queueRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queueRunId))
      .then((rows) => rows[0]);
    if (discard.status === 200) {
      expect(queueRun?.status).toBe("cancelled");
    } else {
      expect(discard.status, JSON.stringify(discard.body)).toBe(409);
      expect(discard.body.details?.code).toBe("queued_comment_already_dispatching");
      expect(queueRun?.status).not.toBe("queued");
    }
    await heartbeat.drainActiveRunExecutions();
  }, 30_000);

  async function seedDispatchIdentity(seeded: Awaited<ReturnType<typeof seedQueue>>) {
    const [identity] = await db.insert(runIdentityContexts).values({
      companyId: seeded.companyId,
      runId: seeded.runId,
      revision: 1,
      cause: "dispatch",
      correlationId: "dispatch",
      status: "accepted",
      acceptedAt: new Date("2026-08-22T15:00:00.000Z"),
    }).returning();
    await db.update(heartbeatRuns)
      .set({ activeIdentityContextId: identity!.id })
      .where(eq(heartbeatRuns.id, seeded.runId));
    return identity!;
  }

  it("writes the identity acceptance, the wake payload, the run acknowledgement, and the activity row on a successful steering transaction", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "turn-1" });

    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status, JSON.stringify(steered.body)).toBe(200);

    const steeringIdentity = await db
      .select()
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.messageId, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(steeringIdentity).toMatchObject({
      status: "accepted",
      responsibleUserId: "queue-owner",
      cause: "steering",
    });

    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual([seeded.commentIds[1]]);

    const run = await db
      .select({ resultJson: heartbeatRuns.resultJson, activeIdentityContextId: heartbeatRuns.activeIdentityContextId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect((run?.resultJson as any)?.queuedSteeringAcknowledgements?.[seeded.commentIds[0]]).toMatchObject({
      status: "acknowledged",
      queueId: seeded.wakeId,
      turnId: "turn-1",
    });
    expect(run?.activeIdentityContextId).toBe(steeringIdentity!.id);

    const activity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_steered"))
      .then((rows) => rows[0]);
    expect(activity?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      targetRunId: seeded.runId,
      turnId: "turn-1",
      duplicate: false,
    });
  });

  it("allows the runner to persist its acknowledgement while steering, preserving concurrent run updates", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    const originalProfile = { adapterDispatch: { adapterType: "paperclip_runner" },
      nativeExecutionInput: { provider: { kind: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" } } };
    await db.update(heartbeatRuns).set({ runnerProfileJson: originalProfile }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ assigneeAdapterOverrides: { model: "gpt-6-sol", reasoningEffort: "xhigh" } })
      .where(eq(issues.id, seeded.issueId));
    steerNativeSessionMock.mockImplementationOnce(async () => {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1000ms'`);
        await appendHeartbeatRunEvent(tx as unknown as typeof db, {
          companyId: seeded.companyId, agentId: seeded.agentId, runId: seeded.runId,
          eventType: "item.completed", payload: { kind: "steering_acknowledgement" },
        });
        await tx.update(heartbeatRuns).set({ resultJson: { concurrentProviderReceipt: "preserve" } })
          .where(eq(heartbeatRuns.id, seeded.runId));
      });
      return { turnId: "turn-before-model-change" };
    });
    const initial = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });
    expect(steered.status, JSON.stringify(steered.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.status).toBe("running");
    expect(run.runnerProfileJson).toEqual(originalProfile);
    expect(steerNativeSessionMock).toHaveBeenCalledWith(expect.objectContaining({ runId: seeded.runId,
      message: "First queued message", correlationId: seeded.commentIds[0] }));
    expect(run.resultJson).toMatchObject({ concurrentProviderReceipt: "preserve", queuedSteeringAcknowledgements: {
      [seeded.commentIds[0]]: { status: "acknowledged", turnId: "turn-before-model-change" },
    } });
    expect(steered.body.entries.map((entry: any) => entry.comment.id)).toEqual([seeded.commentIds[1]]);
  });

  it.each(["cancelled", "failed", "succeeded"] as const)("preserves queued input when the run stops during acknowledgement (%s)", async status => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockImplementationOnce(async () => {
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date(), resultJson: { terminalReceipt: "preserve" } })
        .where(eq(heartbeatRuns.id, seeded.runId));
      return { turnId: "turn-that-stopped" };
    });
    const initial = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    const response = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "queued_comment_stale_target" });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
    expect((wake.payload as any)._paperclipWakeContext.wakeCommentIds).toEqual(seeded.commentIds);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.resultJson).toEqual({ terminalReceipt: "preserve" });
    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "issue.queued_comment_steered"));
    expect(activity).toHaveLength(0);
  });

  it("keeps the identity pending after a steering timeout, then reconciles it on a later acknowledgement", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockRejectedValueOnce(
      new NativeSessionSteeringError("steering_timeout", "The provider did not acknowledge steering in time."),
    );

    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({ code: "steering_timeout", retryable: true });

    const pending = await db
      .select()
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.messageId, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(pending?.status).toBe("pending");

    await reconcileSteeredIdentity(db, pending!);

    const reconciled = await db
      .select({ status: runIdentityContexts.status })
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.id, pending!.id))
      .then((rows) => rows[0]);
    expect(reconciled?.status).toBe("accepted");
    const run = await db
      .select({ activeIdentityContextId: heartbeatRuns.activeIdentityContextId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect(run?.activeIdentityContextId).toBe(pending!.id);
  });

  it("sets the identity to rejected on a definite steering rejection", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockRejectedValueOnce(
      new NativeSessionSteeringError("steering_rejected", "The provider rejected the steering message."),
    );

    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({ code: "steering_rejected", retryable: true });

    const rejected = await db
      .select({ status: runIdentityContexts.status })
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.messageId, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(rejected?.status).toBe("rejected");
  });

  it("throws queued_comment_order_mismatch and changes no row for an invalid reorder set", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    const invalid = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: initial.body.revision,
        orderedCommentIds: [seeded.commentIds[0], randomUUID()],
      });

    expect(invalid.status, JSON.stringify(invalid.body)).toBe(409);
    expect(invalid.body.details?.code).toBe("queued_comment_order_mismatch");

    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual(seeded.commentIds);
    const after = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(after.body.entries.map((entry: any) => entry.comment.id)).toEqual(seeded.commentIds);
  });
  it.each(["other_issue", "indexed_conflict", "other_agent", "missing", "old_receipt", "discarded", "reassigned", "terminal"])(
    "does not stop a run from an invalid or stale durable interrupt: %s", async (kind) => {
      const seeded = await seedQueue();
      await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, seeded.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
      // Fence paid dispatch even if a guard regression admits a successor.
      await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
        status: "running", contextSnapshot: { issueId: randomUUID() },
      });
      const targetId = ["other_issue", "other_agent", "missing"].includes(kind) ? randomUUID() : seeded.runId;
      const otherAgentId = randomUUID();
      if (kind === "other_agent" || kind === "reassigned") await db.insert(agents).values({
        id: otherAgentId, companyId: seeded.companyId, name: "Other", role: "engineer", adapterType: "claude_local",
      });
      if (kind === "other_issue" || kind === "other_agent") await db.insert(heartbeatRuns).values({
        id: targetId, companyId: seeded.companyId, agentId: kind === "other_agent" ? otherAgentId : seeded.agentId,
        status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: kind === "other_issue" ? randomUUID() : seeded.issueId },
      });
      // Indexed identity wins even when a historical JSON key claims this issue.
      if (kind === "indexed_conflict") {
        const [otherIssue] = await db.insert(issues).values({ companyId: seeded.companyId,
          title: "Indexed identity owns this other task", status: "in_progress", assigneeAgentId: seeded.agentId,
        }).returning();
        await db.update(heartbeatRuns).set({ issueId: otherIssue.id,
          contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, seeded.issueId));
      if (kind === "terminal") await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      await db.update(agentWakeupRequests).set({ status: kind === "discarded" ? "cancelled" : wake.status,
        payload: { ...wake.payload, queuedCommentInterrupt: { actorId: "queue-owner", requestedAt: new Date().toISOString(),
          ...(kind === "old_receipt" ? {} : { targetRunId: targetId }),
        } },
      }).where(eq(agentWakeupRequests.id, seeded.wakeId));
      await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
      for (const run of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))) {
        expect(run.status).toBe("running");
      }
    },
  );

  it.each(["issueId", "taskId", "indexed"])("keeps a deferred interrupt on its terminal original, not an active successor: %s", async (contextKey) => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ status: "cancelled", runtimeMode: "legacy", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", runtimeMode: "legacy", issueId: contextKey === "indexed" ? seeded.issueId : null, contextSnapshot: contextKey === "indexed" ? {} : { [contextKey]: seeded.issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, seeded.issueId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      queuedCommentInterrupt: { actorId: "queue-owner", targetRunId: seeded.runId },
    } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await Promise.all([heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId),
      heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId)]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id)))[0].status).toBe("running");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(2);
  });


  it("keeps durable original interrupt delivery fenced without a verified process stop", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      queuedCommentInterrupt: { actorId: "queue-owner", targetRunId: seeded.runId },
    } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(waiting.status).toBe("deferred_issue_execution");
    expect(waiting.payload?.executionWait).toMatchObject({ reason: "process_identity_missing" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(2);
  });

  it.each(["issueId", "taskId", "indexed"])("resumes the durable original interrupt target after a restart before cancellation: %s", async (contextKey) => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: child.pid,
      issueId: contextKey === "indexed" ? seeded.issueId : null, contextSnapshot: contextKey === "indexed" ? {} : { [contextKey]: seeded.issueId },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    // Occupy the only slot: the test must not launch a model or adapter.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const [before] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    // Exact crash boundary: the route committed intent, but never called cancelRun.
    await db.update(agentWakeupRequests).set({ payload: { ...before.payload,
      queuedCommentInterrupt: { actorId: "queue-owner", requestedAt: new Date().toISOString(), targetRunId: seeded.runId },
    }, updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    // Use the production periodic scanner, including concurrent fresh controllers.
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(stopped.status).toBe("cancelled");
    expect(stopped.resultJson).toMatchObject({ operatorInterrupted: true,
      interruptedIssueId: seeded.issueId, queuedCommentInterruptQueueId: seeded.wakeId });
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const runStates = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId)))
      .map(run => ({ id: run.id, status: run.status, context: run.contextSnapshot, result: run.resultJson }));
    expect(["queued", "coalesced"], JSON.stringify({ delivered, runStates })).toContain(delivered.status);
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor).toMatchObject({ status: "queued", agentId: seeded.agentId });
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    // Replays through new controllers cannot interrupt that successor.
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successor.id));
    await Promise.all([heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId),
      heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId)]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id)))[0].status).toBe("running");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });


  it.each([false, true])("does not stop a successor on normal keyed comment replay (conflicting body: %s)", async conflicting => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    const clientRequestId = randomUUID();
    const saved = await issueService(db).addComment(seeded.issueId, "Saved original input", {
      userId: "queue-owner",
    }, { clientRequestId, authorType: "user" });
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "legacy", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const successorId = randomUUID();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(successorId, child);
    runningProcesses.set(successorId, { child, graceSec: 1, processGroupId: null });
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", runtimeMode: "legacy", processPid: child.pid,
      issueId: seeded.issueId, contextSnapshot: { issueId: seeded.issueId },
    });
    await db.update(issues).set({ executionRunId: successorId }).where(eq(issues.id, seeded.issueId));

    const response = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments`).send({
      body: conflicting ? "Different input under the old key" : saved.body,
      clientRequestId, interrupt: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(conflicting ? 409 : 201);
    if (!conflicting) expect(response.body.id).toBe(saved.id);
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(original.status).toBe("succeeded");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId));
    expect(successor.status).toBe("running");
    expect(successor.resultJson?.executionCancellation).toBeUndefined();
    expect(child.exitCode).toBeNull();
    const keyedComments = await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId));
    expect(keyedComments).toHaveLength(1);
    expect(keyedComments[0].body).toBe(saved.body);
  });

  it("tracks queued interrupt recovery until the task drain completes", async () => {
    const seeded = await seedQueue();
    const heartbeat = heartbeatService(db);
    const pending = heartbeat.resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    try {
      expect(getTaskDrainStatus().pendingWakes).toBeGreaterThan(0);
    } finally {
      await pending;
    }
    await heartbeat.drainActiveRunExecutions();
    expect(getTaskDrainStatus().pendingWakes).toBe(0);
  });

  it.each(["comments", "comments/replay-safe"])("serializes concurrent same-key normal comments into one durable operation (%s)", async path => {
    const seeded = await seedQueue();
    const clientRequestId = randomUUID();
    const body = { clientRequestId, body: "One durable comment" };
    const [first, second] = await Promise.all([
      request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/${path}`).send(body),
      request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/${path}`).send(body),
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(first.body.id).toBe(second.body.id);
    const comments = await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId));
    expect(comments).toHaveLength(1);
    const receipts = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.source, "issue_comment_operation"));
    expect(receipts.filter(row => row.payload?.issueId === seeded.issueId)).toHaveLength(1);
  });

  it("rejects changed control and attachment fields without reapplying them", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: child.pid })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const clientRequestId = randomUUID();
    const first = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments`).send({
      clientRequestId, body: "Keep the run active",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    for (const changed of [
      { interrupt: true },
      { reopen: true },
      { resume: true },
      { attachmentIds: [randomUUID()] },
      { authorType: "agent" },
    ]) {
      const replay = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments`).send({
        clientRequestId, body: "Keep the run active", ...changed,
      });
      expect(replay.status, JSON.stringify(replay.body)).toBe(409);
      expect(replay.body.details?.code).toBe("comment_operation_key_conflict");
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.status).toBe("running");
    expect(run.resultJson?.executionCancellation).toBeUndefined();
    expect(child.exitCode).toBeNull();
  });

  it.each(["comments", "comments/replay-safe"])("rolls back the comment, receipt, interrupt wake, and audit as one operation (%s)", async path => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: child.pid })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const clientRequestId = randomUUID();
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION fail_issue_comment_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action = 'issue.comment_added' THEN RAISE EXCEPTION 'forced comment audit failure'; END IF;
        RETURN NEW;
      END; $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_issue_comment_audit
      BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_issue_comment_audit()`));
    try {
      const response = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/${path}`).send({
        clientRequestId, body: "Must roll back with its receipt and stop intent", interrupt: true,
      });
      expect(response.status).toBe(500);
      expect(await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId))).toHaveLength(0);
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "issue_comment_operation"));
      expect(receipts.filter(row => row.payload?.issueId === seeded.issueId)).toHaveLength(0);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "issue_comment"));
      expect(wakes.filter(row => row.idempotencyKey?.startsWith("issue-comment-interrupt:") &&
        row.payload?.issueId === seeded.issueId)).toHaveLength(0);
      const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
      expect(activities.filter(row => row.action === "issue.comment_added")).toHaveLength(0);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
      expect(child.exitCode).toBeNull();
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS fail_issue_comment_audit ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS fail_issue_comment_audit()"));
    }
    if (path === "comments/replay-safe") {
      const retry = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/${path}`).send({
        clientRequestId, body: "Must roll back with its receipt and stop intent", interrupt: true,
      });
      expect(retry.status, JSON.stringify(retry.body)).toBe(201);
      expect(await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId))).toHaveLength(1);
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "issue_comment_operation"));
      expect(receipts.filter(row => row.payload?.issueId === seeded.issueId)).toHaveLength(1);
      expect(receipts.find(row => row.payload?.issueId === seeded.issueId)?.payload?.originalTargetRunId).toBe(seeded.runId);
    }
  });

  it.each(["comments", "comments/replay-safe"])("persists the original run target for comment interrupt recovery (%s)", async path => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: child.pid })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const clientRequestId = randomUUID();
    const response = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/${path}`).send({
      clientRequestId, body: "Interrupt only the run that received this request", interrupt: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const rows = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.source, "issue_comment_operation"));
    const receipt = rows.find(row => row.payload?.issueId === seeded.issueId && row.payload?.commentId === response.body.id);
    expect(receipt?.payload?.originalTargetRunId).toBe(seeded.runId);
    const wakeId = receipt?.payload?.interruptWakeId;
    expect(typeof wakeId).toBe("string");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId as string));
    expect((wake.payload as any)?.queuedCommentInterrupt?.targetRunId).toBe(seeded.runId);
    expect((wake.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual([response.body.id]);

    await heartbeatService(db).drainActiveRunExecutions();
    const successorId = randomUUID();
    const successor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(successorId, successor);
    runningProcesses.set(successorId, { child: successor, graceSec: 1, processGroupId: null });
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: seeded.companyId,
      agentId: seeded.agentId, status: "running", runtimeMode: "legacy", processPid: successor.pid,
      issueId: seeded.issueId, contextSnapshot: { issueId: seeded.issueId },
    });
    await db.update(issues).set({ executionRunId: successorId }).where(eq(issues.id, seeded.issueId));
    const replay = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/${path}`).send({
      clientRequestId, body: "Interrupt only the run that received this request", interrupt: true,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(response.body.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId)))[0].status).toBe("running");
    expect(successor.exitCode).toBeNull();
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.source, "issue_comment_operation")))
      .filter(row => row.payload?.issueId === seeded.issueId)).toHaveLength(1);
  });


  it.each(["comments", "comments/replay-safe"])("keeps bounded request metrics on the normal and replay-safe routes (%s)", async path => {
    const metrics = createApiMetrics();
    const response = await request(app(randomUUID(), "queue-owner", undefined, metrics))
      .post(`/api/issues/${randomUUID()}/${path}`).send({});
    expect(response.status).toBe(400);
    expect(metrics.render()).toContain(`route="/api/issues/:id/${path}",status="400"`);
    expect(metrics.render()).not.toContain('route="unmatched"');
  });

  it.each(["unassigned", "reopen", "resume", "review", "runner-interrupt", "conversation"])(
    "rejects an unsupported replay-safe operation before comment/control effects (%s)", async variant => {
      const seeded = await seedQueue();
      const clientRequestId = randomUUID();
      if (variant === "unassigned") await db.update(issues).set({ assigneeAgentId: null, executionRunId: null }).where(eq(issues.id, seeded.issueId));
      if (variant === "reopen" || variant === "resume") await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seeded.issueId));
      if (variant === "review") await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, seeded.issueId));
      if (variant === "conversation") await db.update(issues).set({ conversationAgentId: seeded.agentId, conversationUserId: "queue-owner", conversationState: "active" }).where(eq(issues.id, seeded.issueId));
      const before = (await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0];
      const response = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments/replay-safe`).send({
        clientRequestId, body: "Must not enter an unsafe control path",
        ...(variant === "reopen" ? { reopen: true } : {}),
        ...(variant === "resume" ? { resume: true } : {}),
        ...(variant === "runner-interrupt" ? { interrupt: true } : {}),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.details?.code).toBe("comment_operation_not_replay_safe");
      expect(await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0]).toEqual(before);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
    },
  );

  it.each(["missing-key", "agent"])("requires a keyed authenticated board user on the replay-safe route (%s)", async variant => {
    const seeded = await seedQueue();
    const response = await request(app(seeded.companyId, "queue-owner", variant === "agent" ? seeded : undefined))
      .post(`/api/issues/${seeded.issueId}/comments/replay-safe`).send({
        body: "Do not accept an unbound request", ...(variant === "agent" ? { clientRequestId: randomUUID() } : {}),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(variant === "agent" ? 403 : 422);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(2);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId))).toHaveLength(0);
  });

  it("refuses a legacy content-only receipt on the replay-safe route without repeating control effects", async () => {
    const seeded = await seedQueue();
    const clientRequestId = randomUUID();
    await issueService(db).addComment(seeded.issueId, "Legacy content is not a control-operation receipt", { userId: "queue-owner" }, { clientRequestId, authorType: "user" });
    const response = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments/replay-safe`).send({
      clientRequestId, body: "Legacy content is not a control-operation receipt", interrupt: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details?.code).toBe("comment_operation_retry_disabled");
    expect(await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId))).toHaveLength(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  it("replays a safe committed receipt through a fresh router after the issue becomes unsupported", async () => {
    const seeded = await seedQueue();
    const body = { clientRequestId: randomUUID(), body: "The response can be lost after commit" };
    const first = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments/replay-safe`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seeded.issueId));
    const replay = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments/replay-safe`).send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0].status).toBe("done");
    expect(await db.select().from(issueComments).where(eq(issueComments.clientRequestId, body.clientRequestId))).toHaveLength(1);
    const conflict = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments/replay-safe`).send({ ...body, interrupt: true });
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    expect(conflict.body.details?.code).toBe("comment_operation_key_conflict");
  });

  it.each(["before-save", "after-commit"] as const)("recovers the same replay-safe operation after a real HTTP socket loss (%s)", async boundary => {
    const seeded = await seedQueue();
    const payload = { clientRequestId: randomUUID(), body: "Recover the original immutable request" };
    const wireBody = JSON.stringify(payload);
    let attempts = 0;
    let droppedReceipt: { id: string } | null = null;
    const fixture = express();
    fixture.use((req, res, next) => {
      attempts++;
      if (attempts === 1 && boundary === "before-save") {
        req.socket.destroy();
        return;
      }
      if (attempts === 1) {
        // The actual route has committed before producing its JSON receipt.
        // Destroy the real socket, not a simulated HTTP 500 response.
        res.json = value => {
          droppedReceipt = value;
          res.destroy();
          return res;
        };
      }
      next();
    });
    fixture.use(app(seeded.companyId));
    const server = fixture.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve); server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
      const url = `http://127.0.0.1:${address.port}/api/issues/${seeded.issueId}/comments/replay-safe`;
      const send = () => fetch(url, { method: "POST", body: wireBody,
        headers: { "Content-Type": "application/json", "X-Paperclip-Expected-User-Id": "queue-owner",
          "X-Paperclip-Expected-Company-Id": seeded.companyId }, signal: AbortSignal.timeout(10_000) });
      await expect(send()).rejects.toThrow();
      expect(attempts).toBe(1);
      const afterLoss = await db.select().from(issueComments).where(eq(issueComments.clientRequestId, payload.clientRequestId));
      expect(afterLoss).toHaveLength(boundary === "before-save" ? 0 : 1);
      if (boundary === "after-commit") {
        expect(droppedReceipt).toMatchObject({ id: afterLoss[0].id, clientRequestId: payload.clientRequestId });
        // A later terminal state must not turn recovery into a new transition.
        await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seeded.issueId));
      } else {
        expect(droppedReceipt).toBeNull();
        expect(await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId))).toHaveLength(0);
      }
      const response = await send();
      expect(response.status).toBe(201);
      const confirmed = await response.json();
      expect(confirmed).toMatchObject({ body: payload.body, clientRequestId: payload.clientRequestId,
        companyId: seeded.companyId, issueId: seeded.issueId, authorUserId: "queue-owner" });
      expect(attempts).toBe(2);
      const comments = await db.select().from(issueComments).where(eq(issueComments.clientRequestId, payload.clientRequestId));
      expect(comments).toHaveLength(1);
      expect(confirmed.id).toBe(comments[0].id);
      if (boundary === "after-commit") {
        expect(confirmed.id).toBe(afterLoss[0].id);
        expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0].status).toBe("done");
      }
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "issue_comment_operation"));
      expect(receipts.filter(row => row.payload?.issueId === seeded.issueId)).toHaveLength(1);
      const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
      expect(audit.filter(row => row.action === "issue.comment_added")).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(["user", "company"])("refuses a replay-safe request after the expected %s identity changes", async field => {
    const seeded = await seedQueue();
    const clientRequestId = randomUUID();
    const response = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments/replay-safe`)
      .set("X-Paperclip-Expected-User-Id", field === "user" ? "previous-user" : "queue-owner")
      .set("X-Paperclip-Expected-Company-Id", field === "company" ? randomUUID() : seeded.companyId)
      .send({ clientRequestId, body: "Do not send under a new login" });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await db.select().from(issueComments).where(eq(issueComments.clientRequestId, clientRequestId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId))).toHaveLength(0);
  });
  it("preserves initial reopen behavior while disabling unsafe transition replay", async () => {
    const seeded = await seedQueue();
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seeded.issueId));
    const clientRequestId = randomUUID();
    const body = { clientRequestId, body: "Please reopen this task", reopen: true };
    const first = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const [reopened] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(reopened.status).toBe("todo");
    const activityCount = (await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId)))
      .filter(row => row.action === "issue.updated").length;
    const replay = await request(app(seeded.companyId)).post(`/api/issues/${seeded.issueId}/comments`).send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0].status).toBe("todo");
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId)))
      .filter(row => row.action === "issue.updated")).toHaveLength(activityCount);
  });


});
