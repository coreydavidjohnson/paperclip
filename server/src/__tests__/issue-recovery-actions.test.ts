import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  costEvents,
  agents,
  agentRuntimeState,
  authUsers,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  workspaceOperations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { buildExecutionContinuation } from "../services/execution-continuation.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { admitReconciledUserContinuation, deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { workspaceOperationService, isNativeWorkspaceFinalizationOperationActive } from "../services/workspace-operations.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import * as routineServices from "../services/routines.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { recoveryService } from "../services/recovery/service.js";
import { deliverGuardedStatusRepairs } from "../services/guarded-status-repair.js";
import { issueService } from "../services/issues.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { noticeMetadataReferencesRecoveryAction } from "../services/recovery/successful-run-handoff.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it.each([
    ["issue_recovery_actions_active_source_uq", true],
    ["issue_recovery_actions_active_fingerprint_uq", true],
    ["unrelated_unique_constraint", false],
  ])("handles wrapped uniqueness conflicts only for %s", async (constraintName, retryExpected) => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action" });
    const selectResults = [[], [existingRow]];
    const error = new Error("Failed query", {
      cause: { code: "23505", constraint_name: constraintName },
    });
    const fakeDb = {
      select: vi.fn(() => ({
        from() { return this; },
        where() { return this; },
        orderBy() { return this; },
        limit() { return Promise.resolve(selectResults.shift() ?? [existingRow]); },
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => { throw error; }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [existingRow]),
          })),
        })),
      })),
    };
    const result = issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });
    if (retryExpected) {
      expect(await result).toMatchObject({ id: "existing-action", status: "active" });
      expect(fakeDb.select).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toBe(error);
      expect(fakeDb.select).toHaveBeenCalledTimes(1);
    }
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });

  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let operationLogRoot: string;
  const priorOperationLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;

  beforeAll(async () => {
    operationLogRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-recovery-operation-logs-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = operationLogRoot;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (priorOperationLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorOperationLogRoot;
    await fs.rm(operationLogRoot, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  async function seedNativeFinalizationRecovery(status: string) {
    const fixture = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      status,
      runtimeMode: "native",
      nativeIssueId: fixture.sourceIssueId,
      nativePhase: "finalizing",
      // Native coordinator retries resume this original run, without creating
      // the legacy scheduled_retry_reason projection.
      scheduledRetryReason: null,
      contextSnapshot: { issueId: fixture.sourceIssueId },
    });
    const svc = issueRecoveryActionService(db);
    await svc.upsertSourceScoped({
      companyId: fixture.companyId,
      sourceIssueId: fixture.sourceIssueId,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: fixture.coderId,
      cause: "native_finalization_invalid",
      fingerprint: `native:${runId}`,
      nextAction: "Finish the existing run.",
      wakePolicy: { kind: "resume_native_run", runId, notBefore: "2020-01-01T00:00:00Z" },
      maxAttempts: 3,
    });
    return { ...fixture, runId, svc };
  }

  it.each(["queued", "running"])("projects the exact %s native run without a legacy scheduled retry", async (status) => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery(status);
    const expected = { runId, status, workspaceOperationId: null };
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toEqual(expected);
    expect((await svc.listActiveForIssues(companyId, [sourceIssueId])).get(sourceIssueId)?.nativeRunActivity).toEqual(expected);
    const response = await request(createApp()).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(response.body.scheduledRetry).toBeNull();
    expect(response.body.activeRecoveryAction.nativeRunActivity).toEqual(expected);
  });

  it("projects an actual long-running export while its original heartbeat remains failed, then clears it", async () => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const work = workspaceOperationService(db).createRecorder({ companyId, issueId: sourceIssueId, heartbeatRunId: runId }).recordOperation({
      phase: "workspace_finalize", metadata: { owningService: "native_workspace_finalizer" },
      run: async () => { started(); await held; return { status: "succeeded" }; },
    });
    await entered;
    let operationId: string;
    try {
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      operationId = operation!.id;
      // A slow callback remains live independently of elapsed wall-clock time.
      await db.update(workspaceOperations).set({ startedAt: new Date("2000-01-01T00:00:00Z") }).where(eq(workspaceOperations.id, operationId));
      const scope = { companyId, issueId: sourceIssueId, runId, operationId };
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(true);
      expect(isNativeWorkspaceFinalizationOperationActive({ ...scope, companyId: randomUUID() })).toBe(false);
      expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toEqual({
        runId, status: "running", workspaceOperationId: operationId,
      });
    } finally { release(); await work; }
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
    // Even a stranded DB row cannot turn a joined callback back into activity.
    await db.update(workspaceOperations).set({ status: "running", finishedAt: null }).where(eq(workspaceOperations.id, operationId!));
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it("keeps the activity claim until a timed-out export callback actually joins", async () => {
    const { companyId, sourceIssueId, runId } = await seedNativeFinalizationRecovery("failed");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const work = workspaceOperationService(db).createRecorder({ companyId, issueId: sourceIssueId, heartbeatRunId: runId }).recordOperation({
      phase: "workspace_finalize", metadata: { owningService: "native_workspace_finalizer" }, timeoutMs: 10,
      run: async () => { await held; return { status: "succeeded" }; },
    });
    try {
      await expect(work).rejects.toThrow("exceeded");
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      const scope = { companyId, issueId: sourceIssueId, runId, operationId: operation!.id };
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(true);
      release();
      await held;
      await new Promise((resolve) => setImmediate(resolve));
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(false);
    } finally { release(); }
  });

  it("does not treat an orphaned running export record as live after controller loss", async () => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
    await db.insert(workspaceOperations).values({
      companyId, issueId: sourceIssueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "running",
      metadata: { owningService: "native_workspace_finalizer" },
    });
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it.each(["company", "issue", "legacy", "finished"])("rejects an apparently live run with the wrong %s authority", async (mismatch) => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("running");
    const other = await seedCompany();
    // Exercise service rejection of historical corruption behind the immutable binding trigger.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(heartbeatRuns).set({
      ...(mismatch === "company" ? { companyId: other.companyId, agentId: other.coderId } : {}),
      ...(mismatch === "issue" ? { nativeIssueId: other.sourceIssueId } : {}),
      ...(mismatch === "legacy" ? { runtimeMode: "legacy" } : {}),
      ...(mismatch === "finished" ? { finishedAt: new Date() } : {}),
    }).where(eq(heartbeatRuns.id, runId));
    });
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it.each(["company", "issue", "run", "phase", "owner", "finished"])(
    "does not borrow native finalization activity with a different %s binding", async (mismatch) => {
      const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
      const other = await seedNativeFinalizationRecovery("running");
      await db.insert(workspaceOperations).values({
        companyId: mismatch === "company" ? other.companyId : companyId,
        issueId: mismatch === "issue" ? other.sourceIssueId : sourceIssueId,
        heartbeatRunId: mismatch === "run" ? other.runId : runId,
        phase: mismatch === "phase" ? "workspace_prepare" : "workspace_finalize",
        status: "running", finishedAt: mismatch === "finished" ? new Date() : null,
        metadata: { owningService: mismatch === "owner" ? "different_service" : "native_workspace_finalizer" },
      });
      expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
      expect((await svc.listActiveForIssues(companyId, [sourceIssueId, other.sourceIssueId])).get(sourceIssueId)?.nativeRunActivity).toBeNull();
    },
  );

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("enforces maxAttempts once and removes every automatic recovery path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const base = {
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      returnOwnerAgentId: managerId,
      cause: "process_lost",
      fingerprint: "run-process-lost",
      nextAction: "Resume the same run.",
      wakePolicy: { kind: "resume_native_run", runId: "run-1" },
      monitorPolicy: { kind: "watch_run", runId: "run-1" },
      maxAttempts: 3,
    };

    const first = await svc.upsertSourceScoped(base);
    const second = await svc.upsertSourceScoped(base);
    const exhausted = await svc.upsertSourceScoped(base);
    const replay = await svc.upsertSourceScoped(base);

    expect(first.attemptCount).toBe(1);
    expect(second.attemptCount).toBe(2);
    expect(exhausted).toMatchObject({
      id: first.id,
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      returnOwnerAgentId: managerId,
      attemptCount: 3,
      maxAttempts: 3,
      wakePolicy: null,
      monitorPolicy: null,
      outcome: "escalated",
      evidence: {
        recoveryBudget: {
          state: "exhausted",
          attemptsUsed: 3,
          maxAttempts: 3,
        },
      },
    });
    expect(replay).toEqual(exhausted);
  });

  it("preserves legacy recovery ownership when new evidence is folded into an active action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const legacy = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the execution path.",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: managerId, attempt: 1, maxAttempts: 5 },
      attemptCount: 1,
      maxAttempts: 5,
    });

    const updated = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-2" },
      evidenceOnCreate: { routingPolicy: "board_escalation_no_takeover_v1" },
      nextAction: "Board decision required.",
      wakePolicy: { type: "board_escalation" },
      preserveExistingOwner: true,
    });

    expect(updated).toMatchObject({
      id: legacy.id,
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      attemptCount: 2,
      maxAttempts: 5,
      nextAction: "Repair the execution path.",
      evidence: expect.objectContaining({ latestRunId: "run-2" }),
      wakePolicy: expect.objectContaining({ type: "bounded_recovery_owner" }),
    });
    expect(updated.evidence).not.toHaveProperty("routingPolicy");
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    const outcomes = await Promise.all([
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      evidence: expect.objectContaining({
        routingPolicy: "board_escalation_no_takeover_v1",
      }),
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(updatedIssue?.assigneeAgentId).toBe(coderId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // Model the production payload: `requestedRef` keeps the operator spelling,
  // and the fingerprint carries the canonical remote ref. Two equivalent
  // spellings of one remote branch share `identityRef`, so they share one
  // fingerprint. A different branch gets a different `identityRef`.
  const makeUnresolvedBaseRefRun = (agentId: string, issueId: string) =>
    (requestedRef: string, identityRef: string) =>
      ({
        id: randomUUID(),
        agentId,
        status: "failed",
        error: `Configured workspace base ref "${requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
        errorCode: "configuration_incomplete",
        contextSnapshot: { issueId },
        livenessState: "needs_followup",
        resultJson: {
          configurationIncomplete: {
            reason: "workspace_base_ref_unresolved",
            requestedRef,
            attemptedRefs: [identityRef],
            fingerprint: `workspace_base_ref:${identityRef}`,
          },
        },
      }) as const;

  it("bounds configuration-incomplete recovery by the unresolved base ref fingerprint", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // Two reconciliations with the same unresolved ref reuse one active action.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0],
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    // The fingerprint carries the canonical remote ref, so the same branch stays
    // one action and a different branch would make a distinct fingerprint.
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );
  });

  it("keeps equivalent spellings of one unresolved base ref under one recovery identity", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // The operator retries the same remote branch under two spellings. Both map
    // to the canonical `origin/fix/foo` identity, so recovery must not reset the
    // attempt count. Each failed run still needs its own actionable notice.
    const firstRun = makeRun("fix/foo", "origin/fix/foo");
    const secondRun = makeRun("origin/fix/foo", "origin/fix/foo");
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstRun,
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0],
      previousStatus: "in_progress",
      latestRun: secondRun,
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // One identity, one active action, the attempt count advances.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );

    // Each run gets one notice bound to the same action; reconciling the
    // latest run again must not duplicate its notice.
    await recovery.escalateStrandedAssignedIssue({
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0], previousStatus: "in_progress", latestRun: secondRun,
      recoveryCause: "configuration_incomplete",
    });
    const notices = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      notices.filter((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, actions[0]!.id),
      ),
    ).toHaveLength(2);
    expect(notices.map((row) => row.metadata?.sourceRunId).sort()).toEqual([firstRun.id, secondRun.id].sort());
  });

  it("gives a distinct recovery identity and a new operator notice when the unresolved base ref changes", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0],
      previousStatus: "in_progress",
      latestRun: makeRun("fix/bar", "origin/fix/bar"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // The prior ref keeps its own record and the new ref gets a fresh identity.
    expect(actions).toHaveLength(2);
    const priorAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/foo"),
    );
    const newAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/bar"),
    );
    expect(priorAction?.status).toBe("cancelled");
    expect(priorAction?.outcome).toBe("cancelled");
    expect(newAction?.status).toBe("active");
    expect(newAction?.attemptCount).toBe(1);
    expect(newAction?.id).not.toBe(priorAction?.id);

    // The operator gets one notice per distinct ref, each bound to its action.
    const systemComments = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, priorAction!.id),
      ),
    ).toBe(true);
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, newAction!.id),
      ),
    ).toBe(true);
  });

  it.each([
    ["process_lost", undefined],
    ["adapter_failed", "successful_run_missing_state"],
    ["codex_output_inactivity_monitor", undefined],
    ["workspace_validation_failed", "workspace_validation_failed"],
    ["adapter_failed", undefined],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause) => {
      const { coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: coderId,
        returnOwnerAgentId: coderId,
        evidence: expect.objectContaining({
          routingPolicy: "board_escalation_no_takeover_v1",
        }),
        wakePolicy: expect.objectContaining({
          type: "board_escalation",
          preservesSourceAssignee: true,
        }),
      });
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stands down while the latest run was cancelled by a board operator", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled by a board operator",
      errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stands down after an operator interrupt cancellation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Interrupted by board comment",
      errorCode: "operator_interrupted",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still recovers system-cancelled runs with no operator attribution", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled because the workspace lease expired",
      errorCode: "cancelled",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(0);
    expect(result.escalated).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
    })]);
  });

  it("schedules a provider-quota monitor for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorScheduledBy: "assignee",
      monitorNotes: "Provider usage quota reached; retry the original assignee at the provider reset time.",
    });
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: runId,
        maxAttempts: null,
        recoveryPolicy: "wake_owner",
      },
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("schedules another provider-quota monitor after a prior quota monitor fired", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        maxAttempts: null,
        externalRef: runId,
      },
    });
  });

  it("skips provider-quota monitor scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota monitor cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("schedules a quota monitor for a cross-agent active review participant", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: expect.any(Date),
      monitorNotes: "Provider usage quota reached; retry the active review participant after the default recovery backoff.",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not restamp an in_review quota monitor when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [monitoredIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const firstNextCheckAt = monitoredIssue?.monitorNextCheckAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(monitoredIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(unchangedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 0, escalated: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
      evidence: expect.objectContaining({ runId: participantRunId }),
    })]);
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNotes: "Provider usage quota reached; retry the original assignee after the default recovery backoff.",
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      // A later reconciliation must observe the current source version.
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0],
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    // Prove dedupe uses the structured recovery-action reference rather than
    // depending only on the legacy body marker.
    await db
      .update(issueComments)
      .set({ body: "Workspace recovery was already escalated." })
      .where(eq(issueComments.issueId, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      // A later reconciliation must observe the current source version.
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0],
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "board_escalation",
        reason: "workspace_validation_failed",
        preservesSourceAssignee: true,
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const escalationComments = comments.filter((comment) =>
      noticeMetadataReferencesRecoveryAction(comment.metadata, actionRows[0]!.id),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      // A later reconciliation must observe the current source version.
      issue: (await db.select().from(issues).where(eq(issues.id, sourceIssue.id)))[0],
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    // Dedupe for structured notices is metadata-based: the short body no longer
    // carries the `Recovery action: \`id\`` marker line.
    expect(comments[0]?.body).not.toContain("Recovery action:");
    expect(noticeMetadataReferencesRecoveryAction(comments[0]?.metadata, actionRows[0]!.id)).toBe(true);
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("lists a settled reconciliation hold that still blocks replay", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      returnOwnerAgentId: coderId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();

    const list = await request(createApp()).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);

    expect(list.body.active).toBeNull();
    expect(list.body.actions).toEqual([
      expect.objectContaining({
        id: action!.id,
        status: "resolved",
        cause: "legacy_execution_requires_reconciliation",
        evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      }),
    ]);
  });

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it.each(["resolved", "cancelled"])("omits %s recovery instructions when the original worker resumes", async (status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "stranded_assigned_issue", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "stranded_assigned_issue", fingerprint: "finished-recovery",
      evidence: { failureSummary: "Retry budget exhausted during cleanup." },
      nextAction: "Repair the runtime, then retry the original owner.", wakePolicy: null,
    });
    await db.update(issueRecoveryActions).set({ status, outcome: "handed_back", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, action.id));
    const payload = await buildPaperclipWakePayload({ db, companyId, contextSnapshot: {
      issueId: sourceIssueId, wakeReason: "issue_recovery_action_restored",
      recoveryActionId: action.id, recoveryCause: action.cause,
    } });
    expect(payload?.issue?.id).toBe(sourceIssueId);
    expect(payload?.recovery).toBeNull();
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("Implement backend recovery");
    expect(prompt).not.toContain("Recovery contract:");
    expect(prompt).not.toContain(action.nextAction);
    expect(prompt).not.toContain("Do not produce the deliverable");
  });

  it.each(["runId", "sourceRunId"])("reconciles older resolved duplicates through the board route (%s) without replay", async sourceKey => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const duplicates = await db.insert(issueRecoveryActions).values([1, 2].map(index => ({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action",
      fingerprint: runId + index, nextAction: "Old duplicate hold",
      createdAt: new Date(action!.createdAt.getTime() - 60_000),
      evidence: { [sourceKey]: runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }))).returning();
    const app = createApp();
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the action was never submitted; the stopped process has no remaining effects." } };
    // A retry without new evidence cannot clear the hold or reopen the task.
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...body, executionReconciliation: undefined }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("todo");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(recorded!.evidence).not.toHaveProperty("automaticRecovery");
    expect(recorded!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "pending" });
    expect(await getExecutionBlocker(db, companyId, sourceIssueId)).toBeNull();
    for (const duplicate of duplicates) {
      const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, duplicate.id));
      expect(settled!.evidence).not.toHaveProperty("automaticRecovery");
      expect(settled!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "not_requested" });
    }
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(recorded);
    // Exercise real admission and a lost ACK after the board-route repair.
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Recovery operator", email: responsibleUserId + "@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId }).where(eq(companies.id, companyId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, coderId));
    await seedHeartbeatRun({ companyId, agentId: coderId, runId: randomUUID(), status: "running" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    let successorId: string | undefined;
    await deliverReconciledExecutions(db, async (...args) => {
      const successor = await heartbeat.wakeup(...args);
      expect(successor).not.toBeNull();
      successorId = successor!.id;
      throw new Error("Lost acknowledgement after committed successor");
    });
    expect(successorId).toBeDefined();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successorId!));
    await Promise.all([deliverReconciledExecutions(db, heartbeat.wakeup), deliverReconciledExecutions(db, heartbeat.wakeup)]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${action!.id}`));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.runId).toBe(successorId);

  });

  it.each(["run", "workspace", "newer", "owner"])("board reconciliation preserves a %s sibling hold", async scope => {
    const { companyId, coderId, managerId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const row = { companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Inspect this source", evidence: { runId, automaticRecovery: { replay: "blocked" } } };
    const [action] = await db.insert(issueRecoveryActions).values(row).returning();
    const [protectedHold] = await db.insert(issueRecoveryActions).values({ ...row, fingerprint: runId + scope,
      returnOwnerAgentId: scope === "owner" ? managerId : coderId,
      createdAt: new Date(action!.createdAt.getTime() + (scope === "newer" ? 60_000 : -60_000)),
      evidence: { ...row.evidence, runId: scope === "run" ? randomUUID() : runId,
        ...(scope === "workspace" ? { workspaceRestoreRecovery: { schema: "retained-workspace" } } : {}) },
    }).returning();
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "The exact selected execution is stopped and no action was submitted." },
    }).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, protectedHold!.id)))[0]).toEqual(protectedHold);
    expect(await getExecutionBlocker(db, companyId, sourceIssueId)).not.toBeNull();
  });

  it.each(["unchanged", "human_reblock", "human_edit", "no_proof"])("guards resolved compression restoration under the issue lock (%s)", async (mode) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", errorCode: "omnigent_context_compression_failed" }).where(eq(heartbeatRuns.id, runId));
    const [blocked] = await db.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(eq(issues.id, sourceIssueId)).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "legacy_execution_requires_reconciliation", fingerprint: runId,
      nextAction: "Preserve the stopped compression session.", evidence: { runId,
        originalFailureCode: "omnigent_context_compression_failed",
        ...(mode === "no_proof" ? {} : { managedCompressionBlock: {
          runId, statusVersion: blocked!.statusVersion, updatedAt: blocked!.updatedAt.toISOString(),
        } }), automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked" } } }).returning();
    // The helper's earlier read saw `blocked`. A later edit must win even if
    // restoration arrives with otherwise valid source and provider evidence.
    if (mode === "human_reblock") {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    } else if (mode === "human_edit") {
      await db.update(issues).set({ updatedAt: new Date(blocked!.updatedAt.getTime() + 1000) }).where(eq(issues.id, sourceIssueId));
    }
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: "The original session completed managed compaction; prior work remains preserved and must not be replayed." } };
    const app = createApp();
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(mode === "unchanged" ? 200 : 409);
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    if (mode === "unchanged") {
      expect(after!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "pending" });
      await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(after);
    } else {
      expect(after).toEqual(action);
      expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    }
  });

  it("reconciles a settled execution hold while preserving dependencies and approvals without replay", async () => {
    const { companyId, coderId, managerId, sourceIssueId, prefix } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(heartbeatRuns).set({ errorCode: "omnigent_rotation_not_ready", runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Real dependency", status: "blocked",
      assigneeAgentId: managerId, issueNumber: 2, identifier: `${prefix}-2` });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: sourceIssueId, type: "blocks" });
    const [approval] = await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId,
      kind: "request_confirmation", status: "pending", createdByAgentId: coderId,
      payload: { version: 1, prompt: "Approve the separate sensitive action." } }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "legacy_execution_requires_reconciliation", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.", evidence: { runId,
        automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const before = (await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0];
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action!.id, outcome: "blocked", sourceIssueStatus: "blocked",
      resolutionNote: "Only the obsolete execution hold is cleared; the dependency and approval remain.",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "The dispatch was rejected before a new turn; the historical runner is offline and cannot resume." } };
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({ ...body, executionReconciliation: undefined }).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(action);
    const competing = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId,
      kind: "missing_disposition", ownerType: "board", cause: "successful_run_missing_issue_disposition",
      fingerprint: "different-current-action", nextAction: "Preserve this separate action." });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, competing.id));
    const queuedRunId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId: queuedRunId, issueId: sourceIssueId, status: "queued" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    // Protected terminal states and detached controllers must keep their hold.
    for (const protectedRun of [
      { status: "cancelled", errorCode: "omnigent_cancelled" },
      { status: "interrupted", errorCode: "omnigent_interrupted" },
      { status: "failed", errorCode: "omnigent_controller_detached" },
    ]) {
      await db.update(heartbeatRuns).set(protectedRun).where(eq(heartbeatRuns.id, runId));
      await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(action);
    }
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "omnigent_rotation_not_ready" }).where(eq(heartbeatRuns.id, runId));
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, sourceIssueId));
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: sourceIssueId, type: "blocks" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...body,
      executionReconciliation: { ...body.executionReconciliation, runId: randomUUID() } }).expect(409);
    // Keep the dependency relation itself locked until reconciliation commits.
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reconciled = new Promise<void>((resolve) => { entered = resolve; });
    const transaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) =>
      transaction(async (tx) => {
        const result = await callback(tx);
        entered();
        await held;
        return result;
      }, config));
    const resolving = request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).then((response) => response);
    try {
      await reconciled;
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
        await tx.delete(issueRelations).where(eq(issueRelations.relatedIssueId, sourceIssueId));
      })).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      release();
      transactionSpy.mockRestore();
    }
    expect((await resolving).status).toBe(200);
    expect((await request(app).get(`/api/issues/${sourceIssueId}`).expect(200)).body.executionBlocker).toBeNull();
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toEqual(before);
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, sourceIssueId)))
      .toEqual([expect.objectContaining({ issueId: blockerId, type: "blocks" })]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, approval!.id)))[0]).toEqual(approval);
    const recorded = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]!;
    expect(recorded.evidence).not.toHaveProperty("automaticRecovery");
    expect(recorded.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "not_requested" });
    await deliverReconciledExecutions(db, wake);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(recorded);
    expect(wake).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  async function seedReconciledDelivery() {
    const fixture = await seedCompany();
    const { companyId, coderId, sourceIssueId } = fixture;
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Recovery operator",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(companies)
      .set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, companyId));
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, coderId));
    const previousRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: previousRunId,
      issueId: sourceIssueId,
      status: "failed",
    });
    // Occupy the agent's only dispatch slot, independently of this issue. These
    // tests exercise real wake admission, but cannot launch a provider process.
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: randomUUID(),
      status: "running",
    });
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "restored",
        ownerType: "board",
        returnOwnerAgentId: coderId,
        cause: "uncertain_external_action",
        fingerprint: previousRunId,
        nextAction: "Continue from the verified reconciliation.",
        evidence: {
          runId: previousRunId,
          continuationDelivery: "pending",
          executionReconciliation: {
            runId: previousRunId,
            providerStopped: true,
            actionOutcome: "not_performed",
            outcomeEvidence: "Verified absent provider effect.",
          },
        },
      })
      .returning();
    return {
      ...fixture,
      previousRunId,
      responsibleUserId,
      action: action!,
      heartbeat: heartbeatService(db, { runtimeEnv: {} }),
    };
  }

  it("adopts pending native reconciliation into a later user comment once, retaining the original conversation", async () => {
    const { companyId, coderId, sourceIssueId, previousRunId, responsibleUserId, action, heartbeat } = await seedReconciledDelivery();
    const sessionId = "7a78e671acfa45ed9861e84121b9bb2e";
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", finishedAt: new Date(Date.now() - 1000),
      errorCode: "omnigent_session_not_recovered", resultJson: { session_id: sessionId } }).where(eq(heartbeatRuns.id, previousRunId));
    // Exercise the actual board route, then a normal saved user comment. The
    // reconciler has not won admission yet; neither the caller nor the adapter
    // may invent a recovery envelope or clear somebody else's execution claim.
    await db.update(issueRecoveryActions).set({ evidence: { runId: previousRunId,
      automaticRecovery: { replay: "blocked" } } }).where(eq(issueRecoveryActions.id, action.id));
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: vi.fn(async () => null) });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId: previousRunId, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: "The last attempt sent no prompt. The old runner is offline; inspect earlier effects before changing anything." },
    }).expect(200);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: sourceIssueId,
      authorType: "user", authorUserId: responsibleUserId, body: "Continue from saved work without repeating unknown actions." }).returning();
    const opts = { source: "on_demand" as const, triggerDetail: "manual" as const, reason: "issue_commented",
      payload: { issueId: sourceIssueId, commentId: comment!.id }, requestedByActorType: "user", requestedByActorId: responsibleUserId,
      contextSnapshot: { issueId: sourceIssueId, wakeCommentId: comment!.id } };
    const successor = await heartbeat.wakeup(coderId, opts);
    expect(successor).not.toBeNull();
    expect(successor!.contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId,
      paperclipPreviousSessionId: sessionId, recoveryActionId: action.id,
      explicitUserContinuation: { previousRunId, commentId: comment!.id } });
    expect(successor!.retryOfRunId).toBe(previousRunId);
    const recorded = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]!;
    expect(recorded.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: successor!.id,
      executionReconciliation: { actionOutcome: "mixed" },
      explicitUserContinuation: { runId: successor!.id, actorId: responsibleUserId, commentId: comment!.id } });
    const continuation = await buildExecutionContinuation({ db, companyId, issueId: sourceIssueId, agentId: coderId,
      runId: successor!.id, context: successor!.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(continuation.originCommentIds).toContain(comment!.id);
    expect(continuation.recoveryOutcomes).toContainEqual(expect.objectContaining({ recoveryActionId: action.id }));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    // Lost acknowledgement, even after the successor finishes, cannot replay it.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor!.id));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, sourceIssueId));
    expect((await heartbeat.wakeup(coderId, opts))?.id).toBe(successor!.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, previousRunId))).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]).toEqual(recorded);
  });

  it.each(["question", "approval", "dependency", "live_process", "current_owner", "not_requested", "wrong_actor", "wrong_run", "newer_run"])(
    "preserves %s while considering pending reconciliation for user input", async (mode) => {
    const { companyId, coderId, sourceIssueId, previousRunId, responsibleUserId, action } = await seedReconciledDelivery();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 2000), runtimeMode: "legacy",
      errorCode: "omnigent_session_not_recovered", resultJson: { session_id: "original-conversation" },
      ...(mode === "live_process" ? { processPid: process.pid } : {}) }).where(eq(heartbeatRuns.id, previousRunId));
    await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence,
      continuationDelivery: mode === "not_requested" ? "not_requested" : "pending",
      executionReconciliation: { ...(action.evidence.executionReconciliation as object),
        recordedAt: new Date(Date.now() - 1000).toISOString(),
        ...(mode === "wrong_run" ? { runId: randomUUID() } : {}),
      } } }).where(eq(issueRecoveryActions.id, action.id));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: sourceIssueId,
      authorType: "user", authorUserId: responsibleUserId, body: "Continue the existing work." }).returning();
    if (mode === "question" || mode === "approval") await db.insert(issueThreadInteractions).values({
      companyId, issueId: sourceIssueId, kind: mode === "question" ? "ask_user_questions" : "request_confirmation",
      status: "pending", createdByAgentId: coderId, payload: { version: 1, prompt: "Preserve this decision." },
    });
    if (mode === "current_owner") await db.update(issues).set({ executionRunId: previousRunId, checkoutRunId: previousRunId })
      .where(eq(issues.id, sourceIssueId));
    if (mode === "newer_run") await seedHeartbeatRun({ companyId, agentId: coderId, issueId: sourceIssueId,
      runId: randomUUID(), status: "running" });
    const before = (await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0];
    const recorded = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0];
    const candidate = await db.transaction(tx => admitReconciledUserContinuation({ db: tx as unknown as typeof db,
      companyId, issueId: sourceIssueId, agentId: coderId, actorType: "user",
      actorId: mode === "wrong_actor" ? randomUUID() : responsibleUserId, reason: "issue_commented",
      commentId: comment!.id, successorRunId: randomUUID(), dependencyReady: mode !== "dependency" }));
    if (["question", "approval", "dependency", "live_process", "current_owner"].includes(mode))
      expect(candidate?.kind).toBe("blocked");
    else expect(candidate).toBeNull();
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toEqual(before);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]).toEqual(recorded);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("does not redeliver pending reconciliation after a newer accepted source", async () => {
    const { companyId, coderId, sourceIssueId, previousRunId, action, heartbeat } = await seedReconciledDelivery();
    await seedHeartbeatRun({ companyId, agentId: coderId, issueId: sourceIssueId, runId: randomUUID(), status: "succeeded" });
    const before = await db.select().from(heartbeatRuns);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(await db.select().from(heartbeatRuns)).toEqual(before);
    const recorded = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]!;
    expect(recorded.evidence).toMatchObject({ continuationDelivery: "invalidated", executionReconciliation: { runId: previousRunId } });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("delivers a reconciled execution once across concurrent sweeps without a deferred duplicate", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake: typeof heartbeat.wakeup = async (...args) => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return heartbeat.wakeup(...args);
    };
    await Promise.all([
      deliverReconciledExecutions(db, wake),
      deliverReconciledExecutions(db, wake),
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: wakes[0]!.runId,
    });
  });

  it.each(["open", "closed", "reassigned", "newer_success"] as const)("reconciles a lost wake acknowledgement after the exact successor finished with %s source state", async (sourceState) => {
    const { action, heartbeat, companyId, previousRunId, sourceIssueId, coderId, managerId } =
      await seedReconciledDelivery();
    let successorId: string | undefined;
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      successorId = run!.id;
      expect(run!.retryOfRunId).toBe(previousRunId);
      throw new Error("fixture lost post-commit wake acknowledgement");
    });
    expect(successorId).toBeDefined();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, successorId!));
    if (sourceState === "closed") {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    } else if (sourceState === "reassigned") {
      await db.update(issues).set({ assigneeAgentId: managerId }).where(eq(issues.id, sourceIssueId));
    } else if (sourceState === "newer_success") {
      await seedHeartbeatRun({ companyId, agentId: coderId, issueId: sourceIssueId, runId: randomUUID(), status: "succeeded" });
    }
    const wake = vi.fn(heartbeat.wakeup);
    await deliverReconciledExecutions(db, wake);
    expect(wake).not.toHaveBeenCalled();
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    const [successor] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, successorId!),
        ),
      );
    expect(successor).toMatchObject({
      status: "succeeded",
      retryOfRunId: previousRunId,
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: successorId,
    });
  });

  it.each(["owner", "source", "decision", "actor"] as const)(
    "does not acknowledge a committed recovery receipt with mismatched %s",
    async (mismatch) => {
      const { action, heartbeat, sourceIssueId, managerId } = await seedReconciledDelivery();
      let successorId: string | undefined;
      await deliverReconciledExecutions(db, async (...args) => {
        const run = await heartbeat.wakeup(...args);
        successorId = run!.id;
        throw new Error("fixture lost post-commit wake acknowledgement");
      });
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId!));
      const [wakeRecord] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successorId!));
      if (mismatch === "owner") {
        await db.update(heartbeatRuns).set({ agentId: managerId }).where(eq(heartbeatRuns.id, successorId!));
      } else if (mismatch === "source") {
        await db.update(agentWakeupRequests).set({
          payload: { ...wakeRecord!.payload, issueId: randomUUID() },
        }).where(eq(agentWakeupRequests.id, wakeRecord!.id));
      } else if (mismatch === "decision") {
        await db.update(heartbeatRuns).set({
          contextSnapshot: { ...successor!.contextSnapshot, previousRunId: randomUUID() },
        }).where(eq(heartbeatRuns.id, successorId!));
      } else {
        await db.update(agentWakeupRequests).set({
          requestedByActorId: "different-actor",
        }).where(eq(agentWakeupRequests.id, wakeRecord!.id));
      }
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
      const wake = vi.fn(heartbeat.wakeup);
      await deliverReconciledExecutions(db, wake);
      expect(wake).not.toHaveBeenCalled();
      const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(recorded!.evidence).toMatchObject({ continuationDelivery: "invalidated" });
      expect(await db.select().from(agentWakeupRequests).where(
        eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${action.id}`),
      )).toHaveLength(1);
    },
  );

  it.each(["owner", "status", "decision"] as const)(
    "rechecks the current reconciliation %s after the sweep read",
    async (changed) => {
      const { action, heartbeat, sourceIssueId, managerId } =
        await seedReconciledDelivery();
      await deliverReconciledExecutions(db, async (...args) => {
        if (changed === "owner")
          await db
            .update(issues)
            .set({ assigneeAgentId: managerId })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "status")
          await db
            .update(issues)
            .set({ status: "done" })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "decision")
          await db
            .update(issueRecoveryActions)
            .set({
              evidence: {
                ...action.evidence,
                executionReconciliation: {
                  ...(action.evidence.executionReconciliation as object),
                  runId: randomUUID(),
                },
              },
            })
            .where(eq(issueRecoveryActions.id, action.id));
        return heartbeat.wakeup(...args);
      });
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(
            eq(
              agentWakeupRequests.idempotencyKey,
              `execution-reconciliation:${action.id}`,
            ),
          ),
      ).toHaveLength(0);
      const [receipt] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(receipt!.evidence.continuationDelivery).toBe("pending");
    },
  );

  it("preserves newer issue work and invalidates the superseded reconciliation without another outbox", async () => {
    const { action, heartbeat, sourceIssueId, companyId, coderId } =
      await seedReconciledDelivery();
    const occupiedRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: occupiedRunId,
      issueId: sourceIssueId,
      status: "queued",
    });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(
          eq(
            agentWakeupRequests.idempotencyKey,
            `execution-reconciliation:${action.id}`,
          ),
        ),
    ).toHaveLength(0);
    const [occupied] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, occupiedRunId));
    expect(occupied!.contextSnapshot).toEqual({ issueId: sourceIssueId });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, occupiedRunId));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    // New accepted work wins even after it finishes. Replaying an old
    // reconciliation here would rotate the already-advanced conversation.
    expect(wakes).toHaveLength(0);
    const [receipt] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence.continuationDelivery).toBe("invalidated");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, occupiedRunId)))[0]!.status).toBe("succeeded");
  });

  it("does not overwrite a newer reconciliation decision after a prior wake commits", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    const newerEvidence = {
      ...action.evidence,
      continuationDelivery: "invalidated",
      operatorNote: "Do not continue after new evidence.",
    };
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      await db
        .update(issueRecoveryActions)
        .set({ evidence: newerEvidence })
        .where(eq(issueRecoveryActions.id, action.id));
      return run;
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toEqual(newerEvidence);
  });

  it("bounds recovery history and never returns another source or company action", async () => {
    const fixture = await seedCompany();
    const other = await seedCompany();
    const rows = Array.from({ length: 51 }, (_, index) => makeRecoveryActionRow({
      companyId: fixture.companyId, sourceIssueId: fixture.sourceIssueId, ownerAgentId: fixture.coderId,
      status: "resolved", outcome: "restored", fingerprint: `per422:history:${index}`,
    }));
    await db.insert(issueRecoveryActions).values(rows as any);
    const foreign = makeRecoveryActionRow({ companyId: other.companyId, sourceIssueId: other.sourceIssueId, ownerAgentId: other.coderId,
      status: "resolved", outcome: "restored", resolutionNote: "Other company evidence" });
    await db.insert(issueRecoveryActions).values(foreign as any);
    const app = createApp();
    const history = await request(app).get(`/api/issues/${fixture.sourceIssueId}/recovery-actions`).expect(200);
    expect(history.body.active).toBeNull();
    expect(history.body.actions).toHaveLength(50);
    expect(history.body.hasMore).toBe(true);
    expect(history.body.actions.every((row: any) => row.companyId === fixture.companyId && row.sourceIssueId === fixture.sourceIssueId)).toBe(true);
    await request(app).get(`/api/issues/${fixture.sourceIssueId}/recovery-actions`).query({ actionId: foreign.id }).expect(404);
    await request(app).post(`/api/issues/${fixture.sourceIssueId}/recovery-actions/resolve`).send({
      actionId: foreign.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Must not alter another company record.",
    }).expect(404);
  });

  it("keeps restored wake actions discoverable and records a late disposition note without replay", async () => {
    const { companyId, coderId, sourceIssueId, prefix } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const service = issueRecoveryActionService(db);
    const action = await service.upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target", fingerprint: "per422:fixture",
      nextAction: "Repair the disposition.", wakePolicy: { type: "board_escalation" },
    });
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const originalNote = "Restored to the original owner for disposition repair.";
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: originalNote,
    }).expect(200);
    for (const ref of [sourceIssueId, `${prefix}-1`]) {
      const history = await request(app).get(`/api/issues/${ref}/recovery-actions`).expect(200);
      expect(history.body.active).toBeNull();
      expect(history.body.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: action.id, status: "resolved", resolutionNote: originalNote }),
      ]));
      const exact = await request(app).get(`/api/issues/${ref}/recovery-actions`).query({ actionId: action.id }).expect(200);
      expect(exact.body.actions.map((row: any) => row.id)).toEqual([action.id]);
    }
    await db.update(issues).set({ status: "blocked", unblockDescriptor: {
      owner: { agentId: coderId }, action: "Complete the separate prerequisite delivery task.",
    }}).where(eq(issues.id, sourceIssueId));
    const lateNote = "Source now waits for the prerequisite delivery task; no execution was repeated.";
    const payload = { actionId: action.id, outcome: "blocked", sourceIssueStatus: "blocked", resolutionNote: lateNote };
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(payload).expect(200);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(payload).expect(200);
    const exact = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).query({ actionId: action.id }).expect(200);
    expect(exact.body.actions[0]).toMatchObject({
      id: action.id, status: "resolved", outcome: "handed_back", resolutionNote: originalNote + String.fromCharCode(10, 10) + lateNote,
    });
    const source = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(source.body).toMatchObject({ status: "blocked", assigneeAgentId: coderId,
      unblockDescriptor: { owner: { agentId: coderId } } });
    expect(wake).toHaveBeenCalledTimes(1);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(logs.filter(entry => entry.action === "issue.recovery_action_note_added")).toHaveLength(1);
    await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).query({ actionId: randomUUID() }).expect(404);
    await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).query({ actionId: "invalid" }).expect(400);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "New request must not change the source.",
    }).expect(409);
    const newer = await service.upsertSourceScoped({ companyId, sourceIssueId, kind: "missing_disposition",
      cause: "successful_run_missing_issue_disposition", fingerprint: "per422:newer", nextAction: "Preserve this new action." });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...payload,
      resolutionNote: "Must not write while a different recovery action is active." }).expect(409);
    expect(await service.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: newer.id });
  });

  it("retains original empty paragraphs and deduplicates whole late notes across intervening annotations", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target", fingerprint: "per436:late-notes",
      nextAction: "Repair the disposition.", wakePolicy: { type: "board_escalation" },
    });
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const separator = String.fromCharCode(10, 10);
    const originalNote = "Original disposition." + separator + separator + "Retain the original empty paragraph.";
    const endpoint = `/api/issues/${sourceIssueId}/recovery-actions/resolve`;
    await request(app).post(endpoint).send({
      actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: originalNote,
    }).expect(200);
    const [originalAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    const [originalIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(originalAction.resolutionNote).toBe(originalNote);
    const firstNote = "Verified the source disposition." + separator + "No execution was repeated.";
    // This distinct note contains the first verbatim; containment is not identity.
    const secondNote = firstNote + " A separate observation.";
    const payload = (resolutionNote: string) => ({
      actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote,
    });
    await request(app).post(endpoint).send(payload(firstNote)).expect(200);
    await request(app).post(endpoint).send(payload(secondNote)).expect(200);
    // Concurrent retries must also share the durable identity under the issue lock.
    await Promise.all([firstNote, firstNote, secondNote, originalNote].map(async (note) => {
      await request(app).post(endpoint).send(payload(note)).expect(200);
    }));
    const [annotated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    const [source] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect.soft(annotated.resolutionNote).toBe(originalNote + separator + firstNote + separator + secondNote);
    expect.soft(annotated).toEqual({ ...originalAction, resolutionNote: annotated.resolutionNote });
    expect.soft(source).toEqual(originalIssue);
    expect.soft(wake).toHaveBeenCalledTimes(1);
    const annotations = logs.filter(entry => entry.action === "issue.recovery_action_note_added");
    expect.soft(annotations).toHaveLength(2);
    for (const note of [firstNote, secondNote]) {
      expect.soft(annotations.filter(entry => entry.details?.resolutionNote === note && entry.details?.recoveryActionId === action.id)).toHaveLength(1);
    }
    expect.soft(logs.filter(entry => entry.action === "issue.recovery_action_resolved")).toHaveLength(1);
  });

  async function seedDispositionNoteRecovery() {
    const fixture = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: fixture.companyId, sourceIssueId: fixture.sourceIssueId,
      kind: "deliberate_wait_without_target", ownerType: "board", returnOwnerAgentId: fixture.coderId,
      cause: "deliberate_wait_without_target", fingerprint: "per436:note-digest",
      nextAction: "Repair the disposition.", wakePolicy: { type: "board_escalation" },
    });
    const wake = vi.fn(async () => null);
    return { ...fixture, action, wake, endpoint: `/api/issues/${fixture.sourceIssueId}/recovery-actions/resolve` };
  }

  it.each(["synthetic JWT", "current username"])("deduplicates whole notes after audit redaction of %s", async (redaction) => {
    const { companyId, sourceIssueId, action, wake, endpoint } = await seedDispositionNoteRecovery();
    const settings = instanceSettingsService(db);
    const priorSettings = await settings.getGeneral();
    await settings.updateGeneral({ censorUsernameInLogs: true });
    try {
      const username = os.userInfo().username;
      const jwtHeader = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
      const syntheticJwt = (subject: string) => `${jwtHeader}.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.c3ludGhldGlj`;
      const originalNote = redaction === "synthetic JWT" ? syntheticJwt("original") : `Original disposition by ${username} (operator).`;
      const firstNote = redaction === "synthetic JWT" ? syntheticJwt("first") : `Verified disposition by ${username} (operator).`;
      const secondNote = redaction === "synthetic JWT" ? syntheticJwt("second") : "A separate observation.";
      const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
      const payload = (resolutionNote: string) => ({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote });
      await request(app).post(endpoint).send(payload(originalNote)).expect(200);
      const [originalAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const [originalIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await request(app).post(endpoint).send(payload(firstNote)).expect(200);
      await request(app).post(endpoint).send(payload(secondNote)).expect(200);
      await Promise.all([firstNote, firstNote, originalNote, secondNote].map(async note => {
        await request(app).post(endpoint).send(payload(note)).expect(200);
      }));
      const [annotated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const [source] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      const logs = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, sourceIssueId)));
      expect.soft(annotated.resolutionNote).toBe([originalNote, firstNote, secondNote].join("\n\n"));
      expect.soft(annotated).toEqual({ ...originalAction, resolutionNote: annotated.resolutionNote });
      expect.soft(source).toEqual(originalIssue);
      expect.soft(wake).toHaveBeenCalledTimes(1);
      const resolved = logs.filter(entry => entry.action === "issue.recovery_action_resolved");
      const annotations = logs.filter(entry => entry.action === "issue.recovery_action_note_added");
      expect.soft(resolved).toHaveLength(1);
      expect.soft(annotations).toHaveLength(2);
      // Read the persisted digest, not just its pre-sanitization input.
      for (const [note, entries] of [[originalNote, resolved], [firstNote, annotations], [secondNote, annotations]] as const) {
        const digest = createHash("sha256").update(note).digest("hex");
        expect.soft(entries.filter(entry => entry.details?.resolutionNoteDigest === digest && entry.details?.recoveryActionId === action.id)).toHaveLength(1);
      }
      expect.soft(resolved[0]?.details?.resolutionNote).not.toBe(originalNote);
      expect.soft(annotations.every(entry => entry.details?.resolutionNote !== firstNote)).toBe(true);
    } finally {
      await settings.updateGeneral({ censorUsernameInLogs: priorSettings.censorUsernameInLogs });
    }
  });

  it("retains original whole-note identity across a real route post-commit failure and A/B/A retry", async () => {
    const { companyId, sourceIssueId, action, wake, endpoint } = await seedDispositionNoteRecovery();
    const originalFactory = routineServices.routineService;
    const sync = vi.fn(async () => { throw new Error("fixture post-commit routines failure"); });
    const factory = vi.spyOn(routineServices, "routineService").mockImplementation((...args) => ({
      ...originalFactory(...args), syncRunStatusForIssue: sync,
    }));
    const publishedReads: Promise<unknown>[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      if (event.type === "activity.logged" && event.payload.action === "issue.recovery_action_resolved") {
        publishedReads.push(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then(rows => rows[0]));
      }
    });
    try {
      const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
      const originalNote = "Original committed disposition.";
      const lateNote = "Later evidence without another execution.";
      const payload = (resolutionNote: string) => ({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote });
      await request(app).post(endpoint).send(payload(originalNote)).expect(500);
      expect(sync).toHaveBeenCalledTimes(1);
      const [originalAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const [originalIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(originalAction).toMatchObject({ status: "resolved", outcome: "handed_back", resolutionNote: originalNote });
      // B commits after A, while A's response failed before its old audit write.
      await request(app).post(endpoint).send(payload(lateNote)).expect(200);
      await request(app).post(endpoint).send(payload(originalNote)).expect(200);
      const [annotated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const [source] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
      expect.soft(annotated.resolutionNote).toBe(originalNote + "\n\n" + lateNote);
      expect.soft(annotated).toEqual({ ...originalAction, resolutionNote: annotated.resolutionNote });
      expect.soft(source).toEqual(originalIssue);
      const resolved = logs.filter(entry => entry.action === "issue.recovery_action_resolved");
      expect.soft(resolved).toHaveLength(1);
      expect.soft(resolved[0]?.details?.resolutionNoteDigest).toBe(createHash("sha256").update(originalNote).digest("hex"));
      expect.soft(logs.filter(entry => entry.action === "issue.recovery_action_note_added")).toHaveLength(1);
      expect.soft(await Promise.all(publishedReads)).toEqual([originalAction]);
      expect.soft(wake).not.toHaveBeenCalled();
      expect.soft(sync).toHaveBeenCalledTimes(1);
    } finally {
      factory.mockRestore();
      unsubscribe();
    }
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
    expect(
      await db
        .select()
        .from(issueInboxArchives)
        .where(eq(issueInboxArchives.issueId, sourceIssueId)),
    ).toHaveLength(1);

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it.each(["ask_user_questions", "request_confirmation"] as const)("does not retry past a new pending %s", async (kind) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target", fingerprint: "disposition:pending-interaction",
      nextAction: "Review the outcome.", wakePolicy: { type: "board_escalation" },
    });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: sourceIssueId, kind, status: "pending", createdByAgentId: coderId,
      payload: kind === "request_confirmation"
        ? { version: 1, prompt: "Confirm the next step." }
        : { version: 1, questions: [{ id: "next", prompt: "Which step?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
    }).returning();
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" };
    const denied = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    expect(denied.body.details?.code).toBe("disposition_recovery_interaction_pending");
    expect(wake).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([
      expect.objectContaining({ status: "blocked", assigneeAgentId: coderId }),
    ]);
    expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: action.id });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction!.id))).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);
    // A settled interaction must not leave a permanent retry veto.
    await db.update(issueThreadInteractions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, interaction!.id));
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("hands a current agent-owned disposition repair back once with persisted history (PER-1091)", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, issueId: sourceIssueId, runId });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "agent",
      ownerAgentId: coderId, previousOwnerAgentId: coderId, returnOwnerAgentId: coderId,
      cause: "deliberate_wait_without_target", fingerprint: "disposition_repair:v1:per1091",
      evidence: { reason: "deliberate_wait_without_target", sourceRunId: runId },
      nextAction: "Restore the owner's work path.",
      wakePolicy: { type: "bounded_owner_disposition_repair", retryAgentId: coderId, attempt: 1, maxAttempts: 2 },
      maxAttempts: 2,
    });
    const wake = vi.fn(async () => null);
    const app = createApp({ type: "agent", companyId, agentId: coderId, runId, source: "agent_key" }, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Owner work path restored." };
    const first = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(first.body.issue).toMatchObject({ status: "todo", assigneeAgentId: coderId, activeRecoveryAction: null });
    expect(first.body.issue).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect(first.body.recoveryAction).toMatchObject({ id: action.id, status: "resolved", outcome: "handed_back", fingerprint: action.fingerprint, evidence: action.evidence });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(coderId, expect.objectContaining({
      reason: "issue_recovery_action_restored", payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
    }));
    const stored = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(stored).toEqual([expect.objectContaining({ status: "resolved", outcome: "handed_back", fingerprint: action.fingerprint, evidence: action.evidence })]);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(logs.filter(entry => entry.action === "issue.recovery_action_resolved")).toHaveLength(1);
    expect(logs.filter(entry => entry.action === "issue.updated")).toHaveLength(1);
    // Replaying an existing note does not authorize an agent to append a new one.
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      ...body, resolutionNote: "Unapproved new evidence.",
    }).expect(403);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id))).toEqual(stored);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toEqual(logs);
    // Once the board annotates, whole-note audit identity must still admit the
    // original owner's lost-response replay without a second write or wake.
    const board = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    await request(board).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      ...body, resolutionNote: "Board observation after hand-back.",
    }).expect(200);
    const annotated = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    const source = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const annotatedLogs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(annotated[0].resolutionNote).toBe(body.resolutionNote + String.fromCharCode(10, 10) + "Board observation after hand-back.");
    expect(annotatedLogs.filter(entry => entry.action === "issue.recovery_action_note_added")).toHaveLength(1);
    const readable = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).query({ actionId: action.id }).expect(200);
    expect(readable.body.actions[0].resolutionNote).toBe(annotated[0].resolutionNote);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id))).toEqual(annotated);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual(source);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toEqual(annotatedLogs);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  async function seedTrappedDisposition() {
    const fixture = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: fixture.companyId, sourceIssueId: fixture.sourceIssueId,
      kind: "deliberate_wait_without_target", ownerType: "board", returnOwnerAgentId: fixture.coderId,
      cause: "deliberate_wait_without_target", fingerprint: "per968:exhausted",
      evidence: { terminalReason: "unchanged_source_state_exhausted", latestIssueStatus: "blocked" },
      nextAction: "Choose the source disposition.", wakePolicy: { type: "board_escalation" },
    });
    return { ...fixture, action, repair: {
      sourceUpdatedAt: fixture.sourceIssue.updatedAt.toISOString(),
      sourceStatus: fixture.sourceIssue.status, sourceStatusVersion: fixture.sourceIssue.statusVersion,
      assigneeAgentId: fixture.coderId, actionUpdatedAt: action.updatedAt.toISOString(),
      actionFingerprint: action.fingerprint,
    } };
  }

  it.each(["todo", "blocked", "done"])("PER-968 refuses naked %s without partial source or action mutation", async (status) => {
    const { sourceIssueId, sourceIssue, action } = await seedTrappedDisposition();
    const before = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    const result = await request(createApp()).patch(`/api/issues/${sourceIssueId}`)
      .send({ status, title: "Must roll back with the status" }).expect(status === "blocked" ? 422 : 409);
    if (status !== "blocked") expect(result.body.details?.code).toBe("recovery_status_repair_required");
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([sourceIssue]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id))).toEqual(before);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);
  });

  it("PER-968 refuses a direct native service status write at the common boundary", async () => {
    const { sourceIssueId, sourceIssue } = await seedTrappedDisposition();
    await expect(issueService(db).update(sourceIssueId, { status: "todo", title: "Must not commit" }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([sourceIssue]);
  });

  it("PER-968 repairs the third trap once with a normal same-session continuation", async () => {
    const { sourceIssueId, coderId, action, repair } = await seedTrappedDisposition();
    const wake = vi.fn(async (_agentId: string, _opts: any) => ({ id: randomUUID() }));
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake as never });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", statusRepair: repair,
      resolutionNote: "Continue this task through its normal work path." };
    const first = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(first.body.issue).toMatchObject({ status: "todo", assigneeAgentId: coderId, activeRecoveryAction: null });
    expect(first.body.recoveryAction).toMatchObject({ id: action.id, status: "resolved", outcome: "handed_back" });
    const stored = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id))).toEqual(stored);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(coderId, expect.objectContaining({ reason: "issue_commented",
      idempotencyKey: `guarded-status-repair:${action.id}`, contextSnapshot: expect.not.objectContaining({ forceFreshSession: true }) }));
    expect(wake.mock.calls[0][1].contextSnapshot).not.toHaveProperty("recoveryActionId");
    await db.update(issues).set({ title: "A newer board decision", updatedAt: new Date(Date.now() + 1000) }).where(eq(issues.id, sourceIssueId));
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each(["sourceUpdatedAt", "sourceStatusVersion", "actionUpdatedAt", "actionFingerprint"])("PER-968 refuses stale %s atomically", async (field) => {
    const { sourceIssueId, sourceIssue, action, repair } = await seedTrappedDisposition();
    const stale = { ...repair, [field]: field === "sourceStatusVersion" ? repair.sourceStatusVersion + 1
      : field.endsWith("At") ? "2000-01-01T00:00:00.000Z" : "different" };
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", statusRepair: stale,
        resolutionNote: "Continue the task normally." }).expect(409);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([sourceIssue]);
    expect(await issueRecoveryActionService(db).getActiveForIssue(sourceIssue.companyId, sourceIssueId)).toMatchObject({ id: action.id });
  });

  it.each(["dependency", "interaction", "execution", "paused", "unrelated"])("PER-968 preserves a %s hold during guarded repair", async (hold) => {
    const { companyId, sourceIssueId, coderId, action, repair } = await seedTrappedDisposition();
    if (hold === "dependency") {
      const [blocker] = await db.insert(issues).values({ companyId, title: "Real prerequisite", status: "todo" }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: sourceIssueId, type: "blocks" });
    }
    if (hold === "interaction") await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId,
      kind: "question", status: "pending", title: "Real decision", payload: { questions: [] }, createdByAgentId: coderId });
    if (hold === "execution") await seedHeartbeatRun({ companyId, agentId: coderId, runId: randomUUID(), issueId: sourceIssueId });
    if (hold === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
    if (hold === "unrelated") await db.update(issueRecoveryActions).set({ kind: "active_run_watchdog" }).where(eq(issueRecoveryActions.id, action.id));
    const before = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    const wake = vi.fn(async () => null);
    await request(createApp(undefined, { recoveryActionEnqueueWakeup: wake })).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", statusRepair: repair,
        resolutionNote: "Continue only after all existing gates pass." }).expect(409);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual(before);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id))).toEqual(actions);
    expect(wake).not.toHaveBeenCalled();
  });

  it("PER-968 serializes concurrent exact board repairs", async () => {
    const { sourceIssueId, action, repair } = await seedTrappedDisposition();
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", statusRepair: repair,
      resolutionNote: "Continue the existing task normally." };
    const responses = await Promise.all([request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body),
      request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(logs.filter(entry => entry.action === "issue.recovery_action_resolved")).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("PER-968 recovers a lost delivery ACK without a second normal turn", async () => {
    const { companyId, sourceIssueId, coderId, action, repair } = await seedTrappedDisposition();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board operator", email: userId + "@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: userId }).where(eq(companies.id, companyId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, coderId));
    // Occupy this agent on another task so the successor stays queued and no
    // real provider starts. This is still assembled native queue admission.
    await seedHeartbeatRun({ companyId, agentId: coderId, runId: randomUUID(), status: "running" });
    const app = createApp({ type: "board", source: "local_implicit", userId }, { recoveryActionEnqueueWakeup: async () => null });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", statusRepair: repair,
      resolutionNote: "Continue this task in the existing session. Preserve completed work." };
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    let runId: string | undefined;
    await deliverGuardedStatusRepairs(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      runId = run!.id;
      expect(run!.contextSnapshot).toMatchObject({ wakeReason: "issue_commented", guardedStatusRepairId: action.id });
      expect(run!.contextSnapshot).not.toHaveProperty("recoveryActionId");
      expect(run!.contextSnapshot).not.toHaveProperty("forceFreshSession");
      throw new Error("Lost ACK after commit");
    });
    expect(runId).toBeDefined();
    // A later source decision does not erase proof of the committed admission.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId!));
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, sourceIssueId));
    await Promise.all([deliverGuardedStatusRepairs(db, heartbeat.wakeup), deliverGuardedStatusRepairs(db, heartbeat.wakeup)]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `guarded-status-repair:${action.id}`));
    expect(wakes.filter(wake => wake.runId)).toHaveLength(1);
    expect(wakes.find(wake => wake.runId)!.runId).toBe(runId);
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(settled.evidence.guardedStatusRepair).toMatchObject({ delivery: "delivered" });
  });

  it("retries an exhausted disposition action once, preserving the owner and audit trail", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      previousOwnerAgentId: coderId, returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target",
      fingerprint: "disposition:exhausted", evidence: { terminalReason: "unchanged_source_state_exhausted", sourceAttemptCount: 2, sourceMaxAttempts: 2 },
      nextAction: "Review the outcome.", wakePolicy: { type: "board_escalation" },
    });
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" };
    const first = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(first.body.issue).toMatchObject({ status: "todo", assigneeAgentId: coderId, activeRecoveryAction: null });
    expect(first.body.recoveryAction).toMatchObject({ id: action.id, status: "resolved", outcome: "handed_back" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(logs.filter(entry => entry.action === "issue.recovery_action_resolved")).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toMatchObject({ status: "todo", assigneeAgentId: coderId });
  });

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")).toMatchObject({
      actorType: "system", actorId: "recovery", agentId: null,
    });
  });

  it.each(["done", "cancelled"])("keeps one workspace owner hold across reads and sweeps of a %s task", async (status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const owner = { token: randomUUID(), hostname: "old-controller.invalid", pid: 42, processStartedAt: new Date(0).toISOString() };
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: coderId, nativeIssueId: sourceIssueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(),
      runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner },
    });
    await db.update(issues).set({ status }).where(eq(issues.id, sourceIssueId));
    const userId = "board-reader";
    const app = createApp({ type: "board", source: "local_implicit", userId });
    const copyback = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    let firstAction: typeof issueRecoveryActions.$inferSelect | undefined;
    for (let tick = 0; tick < 3; tick += 1) {
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, copyback)).toEqual({ acquired: false });
      const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
      expect(detail.body.activeRecoveryAction).toMatchObject({
        cause: "native_workspace_finalization_owner_unverified", status: "active", attemptCount: 1,
      });
      await request(app).get(`/api/companies/${companyId}/issues?view=compact`).expect(200);
      await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
      await recovery.reconcileStrandedAssignedIssues();
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      expect(actions).toHaveLength(1);
      firstAction ??= actions[0]!;
      expect(actions[0]).toEqual(firstAction);
    }
    expect(copyback).not.toHaveBeenCalled();
    expect(await issueService(db).list(companyId, { touchedByUserId: userId })).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);

    // Only clearing the exact physical owner receipt makes this hold stale.
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, runId));
    const cleared = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(cleared.body.activeRecoveryAction).toBeNull();
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(rows).toEqual([expect.objectContaining({ actorType: "system", actorId: "recovery", action: "issue.recovery_action_resolved" })]);
    expect(await issueService(db).list(companyId, { touchedByUserId: userId })).toEqual([]);
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("keeps the named recovery owner from completing a board-owned source issue", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:owner-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified the work was intentionally completed.",
      })
      .expect(403);

    expect(resolved.body.details?.code).toBe("recovery_source_authority_required");
    const [sourceAfter, actionAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, sourceIssueId)).then((rows) => rows[0]),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then((rows) => rows[0]),
    ]);
    expect(sourceAfter).toMatchObject({ status: "blocked", assigneeUserId: "board-user" });
    expect(actionAfter).toMatchObject({ status: "active", outcome: null });
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });
});
