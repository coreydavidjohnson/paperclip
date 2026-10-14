import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("comment attribution query shape", () => {
  it("uses indexed issue membership without changing own-run or time-window arms", () => {
    const source = readFileSync(new URL("../services/issues.ts", import.meta.url), "utf8");
    const query = source.slice(source.indexOf("const runs = await db", source.indexOf("async function enrichCommentsWithDerivedAgentAttribution")), source.indexOf("if (runs.length === 0) return comments", source.indexOf("async function enrichCommentsWithDerivedAgentAttribution")));
    expect(query).toContain("issueRunIdsCondition(companyId, issueId)");
    expect(query).not.toContain("exists (");
    expect(query).toContain("eq(heartbeatRuns.companyId, companyId)");
    expect(query).toContain("coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${minCommentCreatedAt}::timestamptz");
    expect(query).toContain("coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${maxCommentCreatedAt}::timestamptz");
    expect(query).toContain("inArray(heartbeatRuns.id, ownRunIds)");
    expect(query).toContain("orderBy(desc(heartbeatRuns.createdAt))");
  });
});
