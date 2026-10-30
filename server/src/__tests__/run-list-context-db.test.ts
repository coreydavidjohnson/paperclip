import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as history from "../services/run-history-query.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { activityService } from "../services/activity.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";

let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let companyId: string;
let agentId: string;

beforeAll(async () => {
  fixture = await startEmbeddedPostgresTestDatabase("run-list-context-");
  db = createDb(fixture.connectionString);
  companyId = randomUUID();
  agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Projection test", issuePrefix: "P" + companyId.slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer" });
});

afterAll(async () => {
  await db?.$client.end({ timeout: 0 });
  await fixture?.cleanup();
});

it("maintains compact context transactionally without rewriting retained snapshots", async () => {
  const [table] = await db.execute(sql`select to_regclass('public.heartbeat_run_list_context')::text as name`);
  expect(table.name).toBe("heartbeat_run_list_context");
  const contextSnapshot = {
    issueId: "legacy-issue", taskKey: "legacy-key", wakeReason: "test",
    queuedCommentSourceWakeIds: ["queued"],
    paperclipWake: { messages: ["retained wake"], executionContinuation: { messages: ["nested"] } },
    executionContinuation: { messages: ["distinct retained continuation"] },
    prompt: "x".repeat(100000),
  };
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, contextSnapshot }).returning();
  const [projection] = await db.execute(sql`select context from heartbeat_run_list_context where run_id=${run.id}`);
  expect(projection.context).toEqual({ issueId: "legacy-issue", taskKey: "legacy-key", wakeReason: "test", queuedCommentSourceWakeIds: ["queued"] });
  await expect(db.transaction(async (tx) => {
    await tx.update(heartbeatRuns).set({ contextSnapshot: { issueId: "rolled-back" } }).where(sql`${heartbeatRuns.id}=${run.id}`);
    const [updated] = await tx.execute(sql`select context->>'issueId' as issue from heartbeat_run_list_context where run_id=${run.id}`);
    expect(updated.issue).toBe("rolled-back");
    throw new Error("rollback projection test");
  })).rejects.toThrow("rollback projection test");
  const [retained] = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${run.id}`);
  expect(retained.contextSnapshot).toEqual(contextSnapshot);
  const [rolledBack] = await db.execute(sql`select context->>'issueId' as issue from heartbeat_run_list_context where run_id=${run.id}`);
  expect(rolledBack.issue).toBe("legacy-issue");
  const [generated] = await db.execute(sql`select count(*)::int as count from information_schema.columns
    where table_name='heartbeat_runs' and is_generated <> 'NEVER'`);
  expect(generated.count).toBe(0);
});

it("preserves JSON types, text coercion, nulls and every compact key", async () => {
  const contexts = [null, [], "scalar", 7, false, {},
    { issueId: "", taskId: "fallback", taskKey: "key" },
    { issueId: null, taskId: 42, commentId: false },
    { issueId: { nested: 1 }, taskId: [1, 2], wakeCommentIds: ["a"], queuedCommentSourceWakeIds: ["b"],
      wakeCommentId: "c", wakeSource: "s", wakeTriggerDetail: "t", wakeReason: "r",
      failureRetriesBeforeAiConnectionWait: 2, failureRetriesBeforeWorkspaceWait: 3 }];
  for (const context of contexts) {
    const id = randomUUID();
    await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,context_snapshot)
      values(${id},${companyId},${agentId},${JSON.stringify(context)}::jsonb)`);
    const [projected] = await db.select({ context: history.compactRunContext }).from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${id}`);
    expect(projected.context).toEqual(context && typeof context === "object" && !Array.isArray(context) ? context : {});
    const [equal] = await db.execute(sql`select
      public.project_heartbeat_run_list_context(h.context_snapshot) = c.context as projection_equal,
      h.context_snapshot->>'issueId' is not distinct from c.context->>'issueId' as issue_equal,
      h.context_snapshot->>'taskId' is not distinct from c.context->>'taskId' as task_equal
      from heartbeat_runs h join heartbeat_run_list_context c on c.run_id=h.id where h.id=${id}`);
    expect(equal).toEqual({ projection_equal: true, issue_equal: true, task_equal: true });
    await db.execute(sql`delete from heartbeat_run_list_context where run_id=${id}`);
    const [fallback] = await db.select({ context: history.compactRunContext }).from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${id}`);
    expect(fallback).toEqual(projected);
    await db.execute(sql`update heartbeat_runs set context_snapshot=context_snapshot where id=${id}`);
  }
});

it("preserves complete reader outputs with present, missing and foreign-company projections", async () => {
  const issueId = randomUUID();
  const foreignCompanyId = randomUUID();
  await db.insert(issues).values({ id: issueId, companyId, title: "Reader equivalence" });
  const contexts = [null, [], "scalar", 7, false, {},
    { issueId: "", taskId: "fallback", commentId: false },
    { issueId: null, taskId: 42, wakeCommentId: "wake" },
    { issueId: { nested: 1 }, taskId: [1, 2] },
    { issueId, taskKey: "task", commentId: "comment", wakeCommentId: "wake",
      wakeCommentIds: ["one"], queuedCommentSourceWakeIds: ["two"],
      wakeReason: "test", wakeSource: "test", wakeTriggerDetail: "test",
      failureRetriesBeforeAiConnectionWait: 2, failureRetriesBeforeWorkspaceWait: 3,
      paperclipWake: { retained: "wake" }, executionContinuation: { retained: "continuation" } }];
  const runIds: string[] = [];
  for (const [index, context] of contexts.entries()) {
    const runId = randomUUID();
    runIds.push(runId);
    await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,issue_id,status,liveness_state,liveness_reason,context_snapshot,created_at)
      values(${runId},${companyId},${agentId},${issueId},'failed','failed','Run ended with failed',${JSON.stringify(context)}::jsonb,
        now() - interval '1 hour' - ${index} * interval '1 second')`);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1,
      eventType: "lifecycle", message: "Bounded retry exhausted reader equivalence" });
  }
  const runState = createHeartbeatRunState(db);
  const activity = activityService(db);
  const now = new Date();
  const read = async () => ({
    list: await runState.listRuns(companyId, agentId, 200),
    summary: await runState.listRuns(companyId, agentId, 200, { summary: true }),
    activity: await activity.runsForIssue(companyId, issueId),
    execution: [...(await executionProjectionsForRuns(db, companyId, runIds, now))],
    attention: await listAttentionExhaustedRuns(db, companyId),
  });
  const expected = await read();
  expect(expected.activity).toHaveLength(contexts.length);
  expect(expected.attention.length).toBeGreaterThan(0);
  const idArray = `{${runIds.join(",")}}`;
  await db.execute(sql`delete from heartbeat_run_list_context where run_id=any(${idArray}::uuid[])`);
  expect(await read()).toEqual(expected);
  await db.execute(sql`update heartbeat_runs set context_snapshot=context_snapshot where id=any(${idArray}::uuid[])`);
  await db.execute(sql`update heartbeat_run_list_context set company_id=${foreignCompanyId}, context='{"issueId":"must-not-leak"}'::jsonb
    where run_id=any(${idArray}::uuid[])`);
  expect(await read()).toEqual(expected);
});

it("falls back exactly when a projection is missing or has a foreign company", async () => {
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, contextSnapshot: { issueId: "", taskId: 42 } }).returning();
  const read = async () => (await db.select({ context: history.compactRunContext }).from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${run.id}`))[0].context;
  expect(await read()).toEqual({ issueId: "", taskId: 42 });
  await db.execute(sql`delete from heartbeat_run_list_context where run_id=${run.id}`);
  expect(await read()).toEqual({ issueId: "", taskId: 42 });
  await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: "new" } }).where(sql`${heartbeatRuns.id}=${run.id}`);
  await db.execute(sql`update heartbeat_run_list_context set company_id=${randomUUID()},context='{"issueId":"foreign"}' where run_id=${run.id}`);
  expect(await read()).toEqual({ issueId: "new" });
  await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: "restored" } }).where(sql`${heartbeatRuns.id}=${run.id}`);
});

it("tracks company changes and cascades only an explicitly deleted source run", async () => {
  const otherCompany = randomUUID();
  const otherAgent = randomUUID();
  await db.insert(companies).values({ id: otherCompany, name: "Other company", issuePrefix: "O" + otherCompany.slice(0, 7) });
  await db.insert(agents).values({ id: otherAgent, companyId: otherCompany, name: "Other worker", role: "engineer" });
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, contextSnapshot: { issueId: "before" } }).returning();
  await db.update(heartbeatRuns).set({ companyId: otherCompany, agentId: otherAgent, contextSnapshot: { issueId: "after" } }).where(sql`${heartbeatRuns.id}=${run.id}`);
  const [moved] = await db.execute(sql`select company_id,context from heartbeat_run_list_context where run_id=${run.id}`);
  expect(moved).toEqual({ company_id: otherCompany, context: { issueId: "after" } });
  expect(await db.select({ context: history.compactRunContext }).from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${run.id} and ${heartbeatRuns.companyId}=${companyId}`)).toEqual([]);
  await db.delete(heartbeatRuns).where(sql`${heartbeatRuns.id}=${run.id}`);
  expect(await db.execute(sql`select run_id from heartbeat_run_list_context where run_id=${run.id}`)).toHaveLength(0);
});

it("backfills at most 100 IDs per call, keeping existing projections and skipping repeat work", async () => {
  const ids = Array.from({ length: 215 }, () => randomUUID());
  const idArray = `{${ids.join(",")}}`;
  await db.insert(heartbeatRuns).values(ids.map((id) => ({ id, companyId, agentId, contextSnapshot: { issueId: id, prompt: "not copied" } })));
  await db.execute(sql`delete from heartbeat_run_list_context where run_id=any(${idArray}::uuid[])`);
  await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: "newer" } }).where(sql`${heartbeatRuns.id}=${ids[0]}`);
  const batch = fs.readFileSync(new URL("../../../scripts/backfill-run-list-context.sql", import.meta.url), "utf8");
  let cursor = "";
  let batches = 0;
  while (true) {
    const [{ count: before }] = await db.$client`select count(*)::int as count from heartbeat_run_list_context`;
    const rows = await db.$client.unsafe(batch.replaceAll(":'cursor'", `'${cursor}'`));
    const next = String(Object.values(rows[0])[0]);
    const [{ count: after }] = await db.$client`select count(*)::int as count from heartbeat_run_list_context`;
    expect(after - before).toBeLessThanOrEqual(100);
    if (!next) break;
    expect(next > cursor).toBe(true);
    cursor = next;
    expect(++batches).toBeLessThan(20);
  }
  expect(batches).toBeGreaterThanOrEqual(3);
  const [newer] = await db.execute(sql`select context->>'issueId' as issue from heartbeat_run_list_context where run_id=${ids[0]}`);
  expect(newer.issue).toBe("newer");
  const [copied] = await db.execute(sql`select count(*)::int as count from heartbeat_run_list_context where run_id=any(${idArray}::uuid[])`);
  expect(copied.count).toBe(215);
  await expect(db.$client.begin(async (tx) => {
    await tx.unsafe(`create or replace function public.project_heartbeat_run_list_context(snapshot jsonb)
      returns jsonb language plpgsql immutable parallel safe as $$
      begin raise exception 'existing snapshot reprojected'; end; $$`);
    let repeatCursor = "";
    for (let batchNumber = 0; batchNumber < 20; batchNumber++) {
      const rows = await tx.unsafe(batch.replaceAll(":'cursor'", `'${repeatCursor}'`));
      const next = String(Object.values(rows[0])[0]);
      if (!next) throw new Error("rollback repeat-pass test");
      expect(next > repeatCursor).toBe(true);
      repeatCursor = next;
    }
    throw new Error("unbounded repeat pass");
  })).rejects.toThrow("rollback repeat-pass test");
});

it("cannot overwrite a concurrent committed context update with a stale backfill snapshot", async () => {
  const id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const cursor = "fffffffe-ffff-4fff-bfff-ffffffffffff";
  await db.insert(heartbeatRuns).values({ id, companyId, agentId, contextSnapshot: { issueId: "race-old" } });
  await db.execute(sql`delete from heartbeat_run_list_context where run_id=${id}`);
  const batch = fs.readFileSync(new URL("../../../scripts/backfill-run-list-context.sql", import.meta.url), "utf8");
  const gatedBatch = batch.replace("FROM missing\n", "FROM missing CROSS JOIN (SELECT pg_advisory_xact_lock(184218, 1)) gate\n");
  expect(gatedBatch).not.toBe(batch);
  const blocker = await db.$client.reserve();
  let pendingBackfill: Promise<unknown> | undefined;
  try {
    await blocker.unsafe("select pg_advisory_lock(184218, 1)");
    pendingBackfill = db.$client.begin(async (tx) => {
      await tx.unsafe("set local statement_timeout='5s'");
      await tx.unsafe("set local application_name='compact-context-race'");
      return tx.unsafe(gatedBatch.replaceAll(":'cursor'", `'${cursor}'`));
    });
    void pendingBackfill.catch(() => {});
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await blocker.unsafe("select pid from pg_stat_activity where datname=current_database() and application_name='compact-context-race' and wait_event='advisory'");
      if (rows.length) { waiting = true; break; }
      await delay(10);
    }
    expect(waiting).toBe(true);
    await blocker.unsafe("update heartbeat_runs set context_snapshot=$1::jsonb where id=$2", [JSON.stringify({ issueId: "race-new" }), id]);
  } finally {
    await blocker.unsafe("select pg_advisory_unlock(184218, 1)");
    try {
      await pendingBackfill;
    } finally {
      blocker.release();
    }
  }
  const [current] = await db.execute(sql`select context->>'issueId' as issue from heartbeat_run_list_context where run_id=${id}`);
  expect(current.issue).toBe("race-new");
});
