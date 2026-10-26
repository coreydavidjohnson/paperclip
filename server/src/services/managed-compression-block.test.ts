import { describe, expect, it } from "vitest";
import { managedCompressionBlockForTransition, managedCompressionBlockUnchanged } from "./managed-compression-block.js";

describe("managed compression hold provenance", () => {
  it.each(["todo", "blocked"])("restores only the exact server-owned %s projection", (status) => {
    const updatedAt = new Date("2026-10-26T08:00:00Z");
    const task = { id: "task", companyId: "company", status, statusVersion: 3, updatedAt,
      executionRunId: null, checkoutRunId: null, unblockDescriptor: null };
    const run = { id: "run", runtimeMode: "legacy", errorCode: "omnigent_context_compression_failed" };
    const proof = managedCompressionBlockForTransition({ status: "in_progress" }, task, run);
    expect(proof).toMatchObject({ runId: "run", status, statusVersion: 3, updatedAt: updatedAt.toISOString() });
    const action = { companyId: "company", sourceIssueId: "task", kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", status: "resolved", outcome: "blocked",
      evidence: { runId: "run", originalFailureCode: run.errorCode, managedCompressionBlock: proof,
        automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked" } } };
    expect(managedCompressionBlockUnchanged(task, action, run.id)).toBe(true);
    expect(managedCompressionBlockUnchanged({ ...task, status: status === "todo" ? "blocked" : "todo" }, action, run.id)).toBe(false);
    expect(managedCompressionBlockUnchanged({ ...task, updatedAt: new Date(updatedAt.getTime() + 1) }, action, run.id)).toBe(false);
    expect(managedCompressionBlockUnchanged({ ...task, statusVersion: 4 }, action, run.id)).toBe(false);
    expect(managedCompressionBlockUnchanged({ ...task, executionRunId: "newer" }, action, run.id)).toBe(false);
  });
});
