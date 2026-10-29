import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { recoveryService } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("released legacy failure freshness", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("legacy-released-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const createdAt = new Date(Date.now() - 3_600_000);
    const finishedAt = new Date(createdAt.getTime() + 60_000);
    await db.insert(companies).values({ id: companyId, name: "Released failure", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue released work", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner", createdAt, updatedAt: createdAt });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "failed", runtimeMode: "legacy", errorCode: "setup_failed", error: "CONNECTION_CLOSED", scheduledRetryAttempt: 2, contextSnapshot: { issueId }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, createdAt, finishedAt }).returning();
    const readIssue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    const terminalize = () => terminalizeLegacyExecution({ db, run: run!, status: run!.status, fromStatuses: [run!.status] });
    const release = async (status: string, audit = false) => {
      const releasedAt = new Date();
      await db.update(issues).set({ status, updatedAt: releasedAt }).where(eq(issues.id, issueId));
      if (audit) await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "fixture-owner", action: "issue.updated", entityType: "issue", entityId: issueId, details: { _previous: { status: "blocked" }, status }, createdAt: releasedAt });
    };
    return { companyId, agentId, issueId, run: run!, readIssue, actions, terminalize, release };
  }

  it.each(["todo", "in_progress"])("does not re-block %s released after the same settled failure", async status => {
    const fixtureState = await fixture();
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("blocked");
    expect(await fixtureState.actions()).toHaveLength(1);
    await fixtureState.release(status);
    const enqueueWakeup = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    await settleUnrecoverableExecutions(db);
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe(status);
    expect(await fixtureState.actions()).toHaveLength(1);
    expect(await getExecutionBlocker(db, fixtureState.companyId, fixtureState.issueId)).not.toBeNull();
  });

  it("does not let an action queued before an audited release re-block it", async () => {
    const fixtureState = await fixture();
    await fixtureState.terminalize();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixtureState.issueId));
    await fixtureState.release("todo", true);
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("todo");
  });

  it("still blocks a new failure after release", async () => {
    const fixtureState = await fixture();
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    await fixtureState.release("todo");
    const [newRun] = await db.insert(heartbeatRuns).values({ ...fixtureState.run, id: randomUUID(), createdAt: new Date(), finishedAt: new Date() }).returning();
    await terminalizeLegacyExecution({ db, run: newRun!, status: "failed", fromStatuses: ["failed"] });
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("blocked");
  });

  it("does not treat description edits as a release", async () => {
    const fixtureState = await fixture();
    await db.update(issues).set({ description: "More detail", updatedAt: new Date() }).where(eq(issues.id, fixtureState.issueId));
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("blocked");
  });

  it("recognizes a release in the same clock tick as the settled block", async () => {
    const fixtureState = await fixture();
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    const action = (await fixtureState.actions())[0]!;
    await db.update(issues).set({ status: "todo", updatedAt: action.resolvedAt! }).where(eq(issues.id, fixtureState.issueId));
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("todo");
    expect(await fixtureState.actions()).toHaveLength(1);
  });

  it("does not infer release order without a terminal timestamp", async () => {
    const fixtureState = await fixture();
    await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, fixtureState.run.id));
    await fixtureState.release("todo", true);
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("blocked");
  });

  it("does not accept another company's release evidence", async () => {
    const fixtureState = await fixture();
    const foreign = await fixture();
    await db.insert(activityLog).values({ companyId: foreign.companyId, actorType: "user", actorId: "fixture-owner", action: "issue.updated", entityType: "issue", entityId: fixtureState.issueId, details: { previousStatus: "blocked", status: "todo" } });
    await fixtureState.release("todo");
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    expect((await fixtureState.readIssue()).status).toBe("blocked");
  });

  it("preserves unsafe workspace holds across a release", async () => {
    const fixtureState = await fixture();
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }).where(and(eq(heartbeatRuns.companyId, fixtureState.companyId), eq(heartbeatRuns.id, fixtureState.run.id)));
    await fixtureState.terminalize();
    await settleUnrecoverableExecutions(db);
    await fixtureState.release("todo", true);
    await fixtureState.terminalize();
    expect(await getExecutionBlocker(db, fixtureState.companyId, fixtureState.issueId)).toMatchObject({ workspaceRepairRequired: true });
  });
});
