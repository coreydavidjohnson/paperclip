import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
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
