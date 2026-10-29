import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock } from "../services/isolated-remote-workspace-source.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const adapterType = "long_setup_regression";
const idleTimeoutMs = Number(process.env.PAPERCLIP_SETUP_IDLE_TIMEOUT_MS ?? 1000);
const waitMs = Number(process.env.PAPERCLIP_SETUP_WAIT_MS ?? 2500);

describe.skipIf(!support.supported)("heartbeat slow setup and automatic recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let home: string;
  let providerCalls = 0;
  let acquireHook: () => Promise<void> = async () => undefined;
  let releaseSetup = () => {};

  beforeAll(async () => {
    expect(Number.isInteger(idleTimeoutMs) && idleTimeoutMs > 0).toBe(true);
    expect(Number.isInteger(waitMs) && waitMs > idleTimeoutMs).toBe(true);
    home = await mkdtemp(join(tmpdir(), "paperclip-long-setup-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("paperclip-long-setup");
    db = createDb(database.connectionString);
    const [databaseRow] = await db.execute<{ name: string }>(sql`select current_database() as name`);
    await db.execute(sql`alter database ${sql.identifier(databaseRow!.name)} set idle_in_transaction_session_timeout = ${sql.raw(`'${idleTimeoutMs}ms'`)}`);
    const original = environmentOrchestrator.environmentRunOrchestrator;
    vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => {
      const orchestrator = original(...args);
      const acquire = orchestrator.acquireForRun;
      orchestrator.acquireForRun = async request => {
        await acquireHook();
        return acquire(request);
      };
      return orchestrator;
    });
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      execute: async () => {
        providerCalls += 1;
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { finalResponse: "Synthetic setup completed." } };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(async () => {
    providerCalls = 0;
    acquireHook = async () => undefined;
    await db.execute(sql`truncate table companies restart identity cascade`);
  });
  afterEach(async () => {
    releaseSetup();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });
  afterAll(async () => {
    unregisterServerAdapter(adapterType);
    vi.restoreAllMocks();
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(count: number) {
    const [company] = await db.insert(companies).values({ name: "Setup regression", issuePrefix: "SET",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "local-board" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Setup fixture", status: "idle",
      adapterType, adapterConfig: { cwd: home }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 10 } } }).returning();
    const tickets = await db.insert(issues).values(Array.from({ length: count }, (_, index) => ({ companyId: company.id,
      identifier: `SET-${index + 1}`, title: "Synthetic setup", status: "todo", assigneeAgentId: agent.id }))).returning();
    return { agent, tickets };
  }

  it("starts ten tickets with live exclusive transactions beyond the idle timeout", async () => {
    const { agent, tickets } = await seed(10);
    let entered = 0;
    const gate = new Promise<void>(resolve => { releaseSetup = resolve; });
    acquireHook = async () => { entered += 1; await gate; };
    const runs = await Promise.all(tickets.map(ticket => heartbeat.invoke(agent.id, "assignment",
      { issueId: ticket.id, wakeReason: "issue_assigned" }, "system")));
    expect(runs.every(run => run !== null)).toBe(true);
    await expect.poll(() => entered, { timeout: 30000 }).toBe(10);
    const lockPids = async () => await db.execute<{ pid: number; xact_start: Date | null }>(sql`
      select activity.pid, activity.xact_start from pg_stat_activity activity
      where activity.datname = current_database()
      and activity.application_name = 'paperclip-workspace-finalization-lock'
      and exists (select 1 from pg_locks held where held.pid = activity.pid
        and held.locktype = 'advisory' and held.granted)
      order by activity.pid
    `);
    const before = await lockPids();
    expect(before).toHaveLength(10);
    expect(before.every(session => session.xact_start !== null)).toBe(true);
    await setTimeout(waitMs);
    const after = await lockPids();
    expect(after.map(session => session.pid)).toEqual(before.map(session => session.pid));
    expect(after.map(session => session.xact_start)).toEqual(before.map(session => session.xact_start));
    for (const ticket of tickets) {
      await expect(withIsolatedRepositorySourceLock(db, agent.companyId, ticket.id, async () => "contender", true))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
    }
    releaseSetup();
    await expect.poll(async () => (await db.select().from(heartbeatRuns)).filter(run => run.status === "succeeded").length,
      { timeout: 30000 }).toBe(10);
    expect(providerCalls).toBe(10);
    expect((await db.select().from(heartbeatRuns)).every(run => run.error === null)).toBe(true);
  }, waitMs + 90000);

  it("automatically queues and completes one retry after a transient pre-dispatch disconnect", async () => {
    const { agent, tickets } = await seed(1);
    acquireHook = async () => {
      acquireHook = async () => undefined;
      throw Object.assign(new Error("write CONNECTION_CLOSED setup-fixture:5432"), { code: "CONNECTION_CLOSED" });
    };
    const first = await heartbeat.invoke(agent.id, "assignment", { issueId: tickets[0]!.id, wakeReason: "issue_assigned" }, "system");
    expect(first).not.toBeNull();
    await expect.poll(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, first!.id))).length,
      { timeout: 30000 }).toBe(1);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, first!.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" });
    expect(providerCalls).toBe(0);
    await heartbeat.promoteDueScheduledRetries(new Date(retry!.scheduledRetryAt!.getTime() + 1));
    await heartbeat.resumeQueuedRunsForAgent(agent.companyId, agent.id);
    await expect.poll(async () => (await heartbeat.getRun(retry!.id))?.status, { timeout: 30000 }).toBe("succeeded");
    expect(providerCalls).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, first!.id)))).toHaveLength(1);
  }, 90000);
});
