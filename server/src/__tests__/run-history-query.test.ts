import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueRunIdsCondition } from "../services/run-history-query.ts";
const dialect = new PgDialect();
describe("run history query work", () => {
  it("selects IDs through company-scoped index paths, not a correlated OR scan", () => {
    const q = dialect.sqlToQuery(issueRunIdsCondition("company-a", "issue-a"));
    expect(q.sql).toContain("union");
    expect(q.sql).toContain('"heartbeat_runs"."id" in');
    expect(q.sql).toContain("issue_id =");
    expect(q.sql).not.toContain("exists");
    expect(q.params.filter(v => v === "company-a")).toHaveLength(2);
    expect(q.params.filter(v => v === "issue-a")).toHaveLength(2);
    expect(q.sql).toContain("run_id is not null");
  });
});
