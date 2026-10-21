import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("comment attribution run lookup", () => {
  it("reuses indexed issue membership without changing own-run or window semantics", () => {
    const source = readFileSync(new URL("../services/issues.ts", import.meta.url), "utf8");
    const attribution = source.slice(source.indexOf("async function enrichCommentsWithDerivedAgentAttribution"));
    const query = attribution.slice(attribution.indexOf("    const runs = await db"), attribution.indexOf("    if (runs.length === 0)"));
    expect(query).toContain("issueRunIdsCondition(companyId, issueId)");
    expect(query).not.toContain("exists (");
    expect(query).not.toContain("contextSnapshot");
    expect(query).toContain("eq(heartbeatRuns.companyId, companyId)");
    expect(query).toContain("coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${minCommentCreatedAt}::timestamptz");
    expect(query).toContain("coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${maxCommentCreatedAt}::timestamptz");
    expect(query).toContain("inArray(heartbeatRuns.id, ownRunIds)");
    expect(query).toContain(".orderBy(desc(heartbeatRuns.createdAt))");
    expect(source).toContain('import { issueRunIdsCondition } from "./run-history-query.js";');
  });
});
