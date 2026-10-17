import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { executionRunContextColumn, executionRunContextJoin } from "../services/execution-run-context.js";
const dialect = new PgDialect();
describe("execution context query work", () => {
  it("decodes only allowlisted JSON fields once with a non-object guard", () => {
    const join = dialect.sqlToQuery(executionRunContextJoin).sql;
    expect(join.match(/jsonb_to_record/g)).toHaveLength(1);
    expect(join).toContain("jsonb_typeof");
    expect(join).toContain("'object'");
    for (const key of ["issueId", "failureRetriesBeforeAiConnectionWait", "failureRetriesBeforeWorkspaceWait"]) {
      expect(join).toContain(`"${key}" jsonb`);
    }
    const column = dialect.sqlToQuery(executionRunContextColumn).sql;
    expect(column).toContain("jsonb_build_object");
    expect(column).not.toContain("context_snapshot");
    expect(column).not.toContain("->");
    expect(join).not.toContain("paperclipIssue");
  });
});
