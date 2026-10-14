// A resolved notice is bookkeeping, not evidence that uncertain actions are safe.
// Pending/delegated reconciliation delivery retains its single durable owner.
export function permitsReconciledRelease(input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  workspaceRestoreFailure?: unknown;
}, action: {
  companyId: string; sourceIssueId: string; returnOwnerAgentId: string | null;
  status: string; kind: string; cause: string; evidence: Record<string, unknown>;
}): boolean {
  if (action.companyId !== input.companyId || action.sourceIssueId !== input.issueId ||
      action.returnOwnerAgentId !== input.agentId || action.status !== "resolved" ||
      action.kind !== "active_run_watchdog" || action.cause !== "legacy_execution_requires_reconciliation") return false;
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const evidence = action.evidence;
  const decision = record(evidence.executionReconciliation);
  if (record(evidence.automaticRecovery).replay === "blocked" ||
      ["pending", "delegated"].includes(String(evidence.continuationDelivery))) return false;
  if (decision.runId !== input.runId || decision.providerStopped !== true ||
      !["completed", "not_performed", "mixed"].includes(String(decision.actionOutcome)) ||
      typeof decision.outcomeEvidence !== "string" || decision.outcomeEvidence.trim().length < 20) return false;
  return !input.workspaceRestoreFailure ||
    (typeof decision.workspaceRepairEvidence === "string" && decision.workspaceRepairEvidence.trim().length >= 20);
}
