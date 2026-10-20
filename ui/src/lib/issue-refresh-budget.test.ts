import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("issue page reconciliation budget", () => {
  it("does not run one-second live-run and run-history loops", () => {
    const source = readFileSync(new URL("../pages/IssueDetail.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/refetchInterval: 1000/);
    expect(source).not.toMatch(/hasLiveRuns \|\| issueStatus === "in_progress" \? 1000/);
    expect(source).not.toMatch(/refetchInterval: liveRunCount > 0 \? false : (1000|3000)/);
  });
  it("checks browser discovery at most four times a minute", () => {
    const source = readFileSync(new URL("../hooks/useTaskBrowsers.ts", import.meta.url), "utf8");
    expect(source).toContain("refetchInterval: 15_000");
  });
});


it("routes hide/restore, disconnected polls and socket opens through the shared list budget", () => {
  const source = readFileSync(new URL("../context/LiveUpdatesProvider.tsx", import.meta.url), "utf8");
  expect(source.match(/reconcileActiveQueries\(queryClient, invalidationBatcher, liveCompanyId\)/g) ?? []).toHaveLength(3);
  expect(source).not.toContain('queryClient.invalidateQueries({ type: "active" }');
});
