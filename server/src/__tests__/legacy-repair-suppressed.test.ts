import { describe, expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation, suppressedLegacyRepairPatch } from "../services/legacy-execution-recovery.js";

// PER-847 (PER-580 03:30Z): a disposition repair suppressed before dispatch
// ("existing_execution") ran nothing. It must release, not hold.
describe("suppressed legacy disposition repair", () => {
  const base = { runtimeMode: "legacy", status: "cancelled", errorCode: null, resultJson: {} } as const;

  it("is not held for reconciliation", () => {
    const patch = suppressedLegacyRepairPatch("existing_execution");
    expect(legacyExecutionNeedsReconciliation({ ...base, ...patch } as never)).toBe(false);
  });

  it("keeps earlier result fields while adding bootstrap evidence", () => {
    const patch = suppressedLegacyRepairPatch("durable_wait");
    const resultJson = { summary: "kept", ...patch.resultJson };
    expect(resultJson).toMatchObject({ summary: "kept", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(patch.errorCode).toBe("legacy_disposition_repair_suppressed");
  });

  it("still holds the same cancel without the evidence (previous behaviour)", () => {
    expect(legacyExecutionNeedsReconciliation({ ...base, errorCode: "legacy_disposition_repair_suppressed" } as never)).toBe(true);
  });
});
