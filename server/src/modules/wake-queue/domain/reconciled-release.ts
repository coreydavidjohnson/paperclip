// A resolved notice is bookkeeping, not evidence that uncertain actions are safe.
// Only ownerless not_performed decisions can use this legacy release path.
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
      evidence.continuationDelivery !== undefined) return false;
  if (decision.runId !== input.runId || decision.providerStopped !== true ||
      decision.actionOutcome !== "not_performed" ||
      typeof decision.outcomeEvidence !== "string" || decision.outcomeEvidence.trim().length < 20) return false;
  return !input.workspaceRestoreFailure ||
    (typeof decision.workspaceRepairEvidence === "string" && decision.workspaceRepairEvidence.trim().length >= 20);
}
