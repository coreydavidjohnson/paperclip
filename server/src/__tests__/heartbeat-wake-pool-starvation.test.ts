import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, agentWakeupRequests, companies, createDb,
  heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const adapter = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../adapters/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/index.ts")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter.execute }),
}));

let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let admin: ReturnType<typeof createDb>;
let heartbeat: ReturnType<typeof heartbeatService>;
let cwd: string;
let releaseExecution: () => void = () => {};
const pending: Promise<unknown>[] = [];

beforeAll(async () => {
  fixture = await startEmbeddedPostgresTestDatabase("paperclip-wake-pool-");
  // One admission is the entire pool: any nested acquisition deadlocks, without
  // relying on scheduler timing or a production-sized ten-request burst.
  db = createDb(fixture.connectionString, { maxConnections: 1, applicationName: "wake-pool-regression" });
  admin = createDb(fixture.connectionString);
  heartbeat = heartbeatService(db);
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wake-cwd-"));
  await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true, enableNativeRunner: false });
  const execution = new Promise<void>(resolve => { releaseExecution = resolve; });
  adapter.execute.mockImplementation(async () => {
    await execution;
    return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, summary: "pool regression" };
  });
}, 90_000);

afterAll(async () => {
  vi.restoreAllMocks();
  // A pre-fix admission holds the issue lock: release it before fixture writes.
  if (admin && await admin.select().from(heartbeatRuns).then(rows => rows.length === 0)) {
    await admin.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity
      where application_name = 'wake-pool-regression' and pid <> pg_backend_pid()`);
  }
  // Cancel only fixture follow-ups, then drain before closing the database.
  if (admin) {
    await admin.update(issues).set({ status: "cancelled" });
    await admin.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() });
  }
  releaseExecution();
  await Promise.allSettled(pending);
  if (heartbeat) await heartbeat.drainActiveRunExecutions().catch(() => {});
  await fixture?.cleanup();
  if (cwd) await fs.rm(cwd, { recursive: true, force: true });
}, 90_000);

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("wake admission exhausted its one-connection pool")), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

it("releases the pool during workspace preflight and revalidates and retries blocker wakes", async () => {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), blockerId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "pool fixture", issuePrefix: "POOL",
    requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "fixture-owner" });
  await db.insert(agents).values({ id: agentId, companyId, name: "pool agent", role: "engineer",
    status: "active", adapterType: "codex_local", adapterConfig: { cwd },
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
  await db.insert(issues).values([
    { id: blockerId, companyId, title: "finished blocker", status: "done" },
    { id: issueId, companyId, title: "ready dependent", status: "blocked", assigneeAgentId: agentId,
      executionWorkspaceSettings: { mode: "agent_default" } },
  ]);
  await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
  await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "codex_local",
    taskKey: issueId, sessionParamsJson: { sessionId: randomUUID(), cwd }, sessionDisplayId: "fixture-session" });

  const originalStat = fs.stat.bind(fs);
  let releaseStat: () => void = () => {};
  let observedStat: () => void = () => {};
  const statEntered = new Promise<void>(resolve => { observedStat = resolve; });
  const statGate = new Promise<void>(resolve => { releaseStat = resolve; });
  let held = false;
  vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === cwd && !held) { held = true; observedStat(); await statGate; }
    return originalStat(...args);
  }) as typeof fs.stat);
  const wake = () => heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
    reason: "issue_blockers_resolved", requestedByActorType: "system", requestedByActorId: "fixture",
    payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" },
    allowRunCoalescing: false });
  const admission = wake(); pending.push(admission); admission.catch(() => {});
  try {
    await bounded(statEntered);
    // Change the SAME dependency while advisory preflight is suspended. The
    // locked admission must use current dependency state, not stale preflight.
    await admin.update(issues).set({ status: "in_progress" }).where(eq(issues.id, blockerId));
    expect(await bounded(db.execute(sql`select 1`))).toBeDefined();
  } finally { releaseStat(); }
  expect(await bounded(admission)).toBeNull();
  expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
  const retry = wake(); pending.push(retry);
  const run = await bounded(retry);
  expect(run).not.toBeNull();
  await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalledTimes(1), { timeout: 5000 });
  // A waiter burst must release every transaction; live execution owns the
  // issue and the durable deferred queue, not additional database connections.
  const burst = Array.from({ length: 4 }, () => wake()); pending.push(...burst);
  expect(await bounded(Promise.all(burst))).toEqual([null, null, null, null]);
  const receipts = await db.select().from(agentWakeupRequests);
  expect(receipts.filter(row => row.status === "deferred_issue_execution")).toHaveLength(4);
  expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  expect(run!.responsibleUserId).toBe("fixture-owner");
  // Retry under the current dependency state, not the preflight snapshot.
  await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, blockerId));
  const otherId = randomUUID();
  await db.insert(issues).values({ id: otherId, companyId, title: "still blocked", status: "blocked", assigneeAgentId: agentId });
  await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: otherId, type: "blocks" });
  expect(await bounded(heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
    reason: "issue_blockers_resolved", contextSnapshot: { issueId: otherId }, payload: { issueId: otherId } }))).toBeNull();
  const skipped = await db.select().from(agentWakeupRequests);
  expect(skipped.some(row => row.reason === "issue_dependencies_blocked" && row.status === "skipped")).toBe(true);
  expect(await bounded(db.execute(sql`select 1`))).toBeDefined();
  await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
  releaseExecution();
  await bounded(heartbeat.drainActiveRunExecutions());
  const [completed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
  expect(completed.status).toBe("succeeded");
});
