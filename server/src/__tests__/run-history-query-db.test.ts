import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { activityService } from "../services/activity.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRunContextJoin, issueRunContextColumns, issueRunIdsCondition, runListContextColumns, runListContextJoin } from "../services/run-history-query.js";

describe("run history database contracts", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("luma-run-history-"); db = createDb(fixture.connectionString); }, 90_000);
  afterAll(async () => { await fixture?.cleanup(); });
  it("matches the old full text projection for unusual JSON and excludes non-allowlisted data", async () => {
    const values = [null, [], "text", 42, true, {}, { issueId: "i", taskId: 123, taskKey: false, commentId: { z: 2, a: 1 }, wakeCommentId: [1, "x"], wakeReason: null, wakeSource: "コメント", wakeTriggerDetail: "x", secret: "never-return" }];
    for (const value of values) {
      const result = await db.execute(sql`with heartbeat_runs as (select ${JSON.stringify(value)}::jsonb as context_snapshot)
        select context_snapshot ->> 'issueId' as old_issue,
          context_snapshot ->> 'taskId' as old_task,
          context_snapshot ->> 'taskKey' as old_key,
          context_snapshot ->> 'commentId' as old_comment,
          context_snapshot ->> 'wakeCommentId' as old_wake,
          context_snapshot ->> 'wakeReason' as old_reason,
          context_snapshot ->> 'wakeSource' as old_source,
          context_snapshot ->> 'wakeTriggerDetail' as old_detail,
          run_list_context.* from heartbeat_runs left join ${runListContextJoin} on true`);
      const row = result[0];
      for (const [oldKey, newKey] of [["old_issue", "issueId"], ["old_task", "taskId"], ["old_key", "taskKey"], ["old_comment", "commentId"], ["old_wake", "wakeCommentId"], ["old_reason", "wakeReason"], ["old_source", "wakeSource"], ["old_detail", "wakeTriggerDetail"]]) expect(row[newKey]).toEqual(row[oldKey]);
      expect(row).not.toHaveProperty("secret");
    }
  });
  it("matches all four issue-run fields without changing JSON types or row count", async () => {
    const values = [null, [], "text", 42, true, {},
      { wakeCommentIds: ["a", "b"], wakeCommentId: "w", commentId: "c", issueId: "i", secret: "never-return" },
      { wakeCommentIds: { nested: true }, wakeCommentId: 3, commentId: [1, "x"], issueId: false },
      { wakeCommentIds: null, wakeCommentId: { a: 1 }, commentId: null },
      { wakeCommentIds: "not-an-array", issueId: "large", extra: "x".repeat(100000) }];
    for (const value of values) {
      const rows = await db.execute(sql`with heartbeat_runs as (select ${JSON.stringify(value)}::jsonb as context_snapshot)
        select jsonb_build_object(
          'wakeCommentIds', context_snapshot->'wakeCommentIds',
          'wakeCommentId', context_snapshot->>'wakeCommentId',
          'contextCommentId', context_snapshot->>'commentId',
          'contextIssueId', context_snapshot->>'issueId') as old,
        jsonb_build_object(
          'wakeCommentIds', ${issueRunContextColumns.wakeCommentIds},
          'wakeCommentId', ${issueRunContextColumns.wakeCommentId},
          'contextCommentId', ${issueRunContextColumns.contextCommentId},
          'contextIssueId', ${issueRunContextColumns.contextIssueId}) as actual
        from heartbeat_runs left join ${issueRunContextJoin} on true`);
      expect(rows).toHaveLength(1);
      expect(rows[0].actual).toEqual(rows[0].old);
      expect(rows[0].actual).not.toHaveProperty("secret");
    }
  });
  it("executes the service with malformed contexts and preserves output names, values and membership", async () => {
    const company = randomUUID(), other = randomUUID(), agent = randomUUID(), otherAgent = randomUUID(), issue = randomUUID();
    await db.insert(companies).values([{ id: company, name: "C", issuePrefix: "C" }, { id: other, name: "D", issuePrefix: "D" }]);
    await db.insert(agents).values([{ id: agent, companyId: company, name: "C", role: "engineer", adapterType: "codex_local" }, { id: otherAgent, companyId: other, name: "D", role: "engineer", adapterType: "codex_local" }]);
    await db.insert(issues).values({ id: issue, companyId: company, title: "Context contract", status: "done" });
    const values = [null, [], "text", 42, true, {}, { issueId: issue, wakeCommentIds: null },
      { issueId: issue, wakeCommentIds: ["a"], wakeCommentId: 3, commentId: { a: 1 }, secret: "never-return" },
      { wakeCommentIds: false, issueId: randomUUID(), wakeCommentId: [1, "x"] }];
    const ids = values.map(() => randomUUID()), outsider = randomUUID();
    for (const [i, value] of values.entries()) {
      await db.insert(heartbeatRuns).values({ id: ids[i], companyId: company, agentId: agent, status: "succeeded", contextSnapshot: value as any, livenessState: "useful", createdAt: new Date(1_700_000_000_000 + i * 1000) });
    }
    await db.insert(heartbeatRuns).values({ id: outsider, companyId: other, agentId: otherAgent, status: "succeeded", contextSnapshot: { issueId: issue } });
    await db.insert(activityLog).values([...ids, ids[7], outsider].map(runId => ({ companyId: company, actorType: "system", actorId: "system", action: "test", entityType: "issue", entityId: issue, runId })));
    const old = await db.select({ id: heartbeatRuns.id,
      wakeCommentIds: sql`${heartbeatRuns.contextSnapshot}->'wakeCommentIds'`,
      wakeCommentId: sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
      contextCommentId: sql`${heartbeatRuns.contextSnapshot}->>'commentId'`,
      contextIssueId: sql`${heartbeatRuns.contextSnapshot}->>'issueId'`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company), inArray(heartbeatRuns.id, ids))).orderBy(sql`${heartbeatRuns.createdAt} desc`);
    const actual = await activityService(db).runsForIssue(company, issue);
    expect(actual).toHaveLength(values.length);
    expect(actual.map(r => ({ id: r.runId, wakeCommentIds: r.wakeCommentIds, wakeCommentId: r.wakeCommentId, contextCommentId: r.contextCommentId, contextIssueId: r.contextIssueId }))).toEqual(old);
    expect(actual.every(r => !Object.hasOwn(r, "secret"))).toBe(true);
    const generated = db.select(issueRunContextColumns).from(heartbeatRuns).leftJoin(issueRunContextJoin, sql`true`).toSQL();
    expect(generated.sql).toContain("left join lateral jsonb_to_record");
    expect(generated.sql).toContain('"wakeCommentIds" jsonb');
    expect(generated.sql).toContain('issue_run_context."commentId"');
    expect(generated.params).toEqual([]);
    // PostgreSQL converts JSON null to SQL NULL in jsonb_to_record. Both
    // deserialize to JS null; these fields have no downstream SQL consumers.
    const nullRows = await db.execute(sql`select ('{"wakeCommentIds":null}'::jsonb->'wakeCommentIds') is distinct from c."wakeCommentIds" as sql_distinct from jsonb_to_record('{"wakeCommentIds":null}'::jsonb) c("wakeCommentIds" jsonb)`);
    expect(nullRows[0].sql_distinct).toBe(true);
    const version = await db.execute(sql`show server_version_num`);
    console.log("issue-run contract PostgreSQL version", version[0].server_version_num);
  });
  it("preserves context/activity union membership, duplicates, company isolation and order", async () => {
    const company = randomUUID(), other = randomUUID(), agent = randomUUID(), otherAgent = randomUUID(), issue = randomUUID();
    await db.insert(companies).values([{ id: company, name: "A", issuePrefix: "A" }, { id: other, name: "B", issuePrefix: "B" }]);
    await db.insert(agents).values([{ id: agent, companyId: company, name: "A", role: "engineer", adapterType: "codex_local" }, { id: otherAgent, companyId: other, name: "B", role: "engineer", adapterType: "codex_local" }]);
    const ids = Array.from({length: 5}, () => randomUUID());
    await db.insert(heartbeatRuns).values(ids.map((id, i) => ({ id, companyId: i === 4 ? other : company, agentId: i === 4 ? otherAgent : agent, status: "succeeded", contextSnapshot: { issueId: i === 0 || i === 2 || i === 4 ? issue : "unrelated" }, createdAt: new Date(1_700_000_000_000 + i * 1000) })));
    await db.insert(activityLog).values([1, 2, 2, 3].map(i => ({ companyId: i === 3 ? other : company, actorType: "system", actorId: "system", action: "test", entityType: "issue", entityId: issue, runId: ids[i] })));
    const oldCondition = sql`${heartbeatRuns.companyId} = ${company} and (
      ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue} or exists (
        select 1 from activity_log where company_id = ${company} and entity_type = 'issue' and entity_id = ${issue} and run_id = ${heartbeatRuns.id}))`;
    const old = await db.select({id: heartbeatRuns.id}).from(heartbeatRuns).where(oldCondition).orderBy(sql`${heartbeatRuns.createdAt} desc`);
    const actual = await db.select({id: heartbeatRuns.id}).from(heartbeatRuns).where(sql`${heartbeatRuns.companyId} = ${company} and ${issueRunIdsCondition(company, issue)}`).orderBy(sql`${heartbeatRuns.createdAt} desc`);
    expect(actual).toEqual(old);
    expect(actual.map(r => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });
});
