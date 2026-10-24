import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping session preparation tests: ${support.reason}`);

describePostgres("heartbeat session preparation through adapter dispatch", () => {
  const adapterType = "session_preparation_test";
  const captured = new Map<string, AdapterExecutionContext>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-session-preparation-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        // Settle the fixture's work so no automatic unfinished-task retry
        // competes with the next explicit session-continuation wake.
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", sessionParams: { sessionId: "saved-session", adapterState: "preserved" }, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Session fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Session owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Session reader", adapterType, status: "idle", adapterConfig: { model: "model-a" }, runtimeConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Session fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, userId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown> = {}) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
    expect(captured.has(run!.id)).toBe(true);
    return { input: captured.get(run!.id)!, finished };
  }

  it("reuses unchanged task sessions and strips host freshness metadata before dispatch", async () => {
    const f = await seed();
    const first = await execute(f);
    expect(first.input.runtime.sessionId).toBeNull();
    const stored = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId)).then(rows => rows[0]);
    expect(stored?.sessionParamsJson).toHaveProperty("__paperclipConfigFingerprint");
    const resumed = await execute(f, { paperclipSessionHandoffMarkdown: "stale handoff", paperclipSessionRotationReason: "stale reason", paperclipPreviousSessionId: "stale session" });
    expect(resumed.input.runtime).toMatchObject({ sessionId: "saved-session", sessionDisplayId: "saved-session", taskKey: f.issueId });
    expect(resumed.input.runtime.sessionParams).toMatchObject({ sessionId: "saved-session", adapterState: "preserved" });
    expect(resumed.input.runtime.sessionParams).not.toHaveProperty("__paperclipConfigFingerprint");
    expect(resumed.input.context.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(resumed.input.context.paperclipSessionRotationReason).toBeUndefined();
    expect(resumed.input.context.paperclipPreviousSessionId).toBeUndefined();
    expect(resumed.finished.sessionIdBefore).toBe("saved-session");
  });

  it("dispatches an adopted native recovery fresh while retaining its original conversation", async () => {
    const f = await seed();
    await execute(f);
    // The fixture's review-without-reviewer repair can finish a corrective turn.
    // Reconcile the latest actual source, never borrow an older run's authority.
    const [latest] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    const sourceId = latest!.id;
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(Date.now() - 2000),
      errorCode: "omnigent_session_not_recovered", resultJson: { session_id: "saved-session" } }).where(eq(heartbeatRuns.id, sourceId));
    await db.update(issues).set({ status: "todo", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "board",
      returnOwnerAgentId: f.agentId, cause: "legacy_execution_requires_reconciliation", fingerprint: sourceId,
      nextAction: "Continue only after verified reconciliation.", evidence: { runId: sourceId, continuationDelivery: "pending",
        executionReconciliation: { runId: sourceId, providerStopped: true, actionOutcome: "mixed",
          recordedAt: new Date(Date.now() - 1000).toISOString(), outcomeEvidence: "The prior attempt sent no prompt; inspect older outcomes." } } });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "Continue from the existing records." }).returning();
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: f.userId, payload: { issueId: f.issueId, commentId: comment!.id },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: comment!.id } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const input = captured.get(run!.id)!;
    expect(input).toBeDefined();
    expect(input.context).toMatchObject({ forceFreshSession: true, previousRunId: sourceId,
      paperclipPreviousSessionId: "saved-session", explicitUserContinuation: { previousRunId: sourceId, commentId: comment!.id } });
    expect(input.runtime.sessionId).toBeNull();
    expect(input.runtime.sessionParams).toBeNull();
  });

  it("starts fresh when effective model configuration changes and persists the reason", async () => {
    const f = await seed();
    await execute(f);
    await db.update(agents).set({ adapterConfig: { model: "model-b" } }).where(eq(agents.id, f.agentId));
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.finished.sessionIdBefore).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, taskSessionAvailable: true, taskSessionReused: false } } });
  });

  it("refreshes tools with a fresh session when the selected adapter cannot refresh on resume", async () => {
    const f = await seed();
    await execute(f);
    const next = await execute(f, { refreshTools: true });
    expect(next.input.context.forceFreshSession).toBe(true);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { resetReasons: ["forceFreshSession was requested"] } } });
  });

  it("rotates a session at the configured run threshold and supplies a handoff", async () => {
    const f = await seed({ sessionCompaction: { enabled: true, maxSessionRuns: 1 } });
    await execute(f);
    await execute(f);
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.input.context.paperclipPreviousSessionId).toBe("saved-session");
    expect(next.input.context.paperclipSessionRotationReason).toBe("session exceeded 1 runs");
    expect(next.input.context.paperclipSessionHandoffMarkdown).toEqual(expect.any(String));
    expect(next.finished.sessionIdBefore).toBeNull();
  });
});
