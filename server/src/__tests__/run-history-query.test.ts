import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueRunIdsCondition, runListContextColumns, runListContextJoin } from "../services/run-history-query.ts";
const dialect = new PgDialect();
describe("run history query work", () => {
  it("selects IDs through company-scoped index paths, not a correlated OR scan", () => {
    const q = dialect.sqlToQuery(issueRunIdsCondition("company-a", "issue-a"));
    expect(q.sql).toContain("union");
    expect(q.sql).toContain('"heartbeat_runs"."id" in');
    expect(q.sql).not.toContain("exists");
    expect(q.params.filter(v => v === "company-a")).toHaveLength(2);
    expect(q.params.filter(v => v === "issue-a")).toHaveLength(2);
    expect(q.sql).toContain("run_id is not null");
  });
  it("extracts the allowlisted context fields once and handles non-object context", () => {
    const q = dialect.sqlToQuery(runListContextJoin);
    expect(q.sql).toContain("lateral jsonb_to_record");
    expect(q.sql).toContain("heartbeat_run_list_context");
    expect(q.sql).toContain('c.run_id = "heartbeat_runs"."id"');
    expect(q.sql).toContain('c.company_id = "heartbeat_runs"."company_id"');
    expect(q.sql.indexOf("select c.context")).toBeLessThan(q.sql.indexOf("context_snapshot"));
    expect(q.sql).toContain("jsonb_typeof");
    expect(q.sql).toContain("'object'");
    expect(Object.keys(runListContextColumns)).toEqual(["contextIssueId", "contextTaskId", "contextTaskKey", "contextCommentId", "contextWakeCommentId", "contextWakeReason", "contextWakeSource", "contextWakeTriggerDetail"]);
    for (const column of Object.values(runListContextColumns)) {
      expect(dialect.sqlToQuery(column.sql).sql).not.toContain("context_snapshot");
    }
    expect(q.sql).not.toContain("paperclipIssue");
  });
});
