/** Server-owned provenance for the managed same-session compression lane.
 * These functions never authorize replay or bypass native admission checks. */
type Projection = { status: string; statusVersion: number; updatedAt: Date };
type Source = Projection & {
  id: string; companyId: string; executionRunId: string | null;
  checkoutRunId: string | null; unblockDescriptor?: unknown;
};
type Action = { companyId: string; sourceIssueId: string; kind: string;
  cause: string; status: string; outcome: string | null; evidence: Record<string, unknown> };
type Proof = { runId: string; statusVersion: number; updatedAt: string };

export function managedCompressionBlockForTransition(
  task: { status: string }, projected: Projection,
  run: { id: string; runtimeMode: string | null; errorCode: string | null },
): Proof | null {
  if (!["todo", "in_progress", "in_review"].includes(task.status) ||
      projected.status !== "blocked" || run.runtimeMode !== "legacy" ||
      run.errorCode !== "omnigent_context_compression_failed") return null;
  return { runId: run.id, statusVersion: projected.statusVersion,
    updatedAt: projected.updatedAt.toISOString() };
}

/** Called with the current issue under the native resolver's transaction lock. */
export function managedCompressionBlockUnchanged(task: Source, action: Action, runId: string): boolean {
  const evidence = action.evidence;
  const proof = evidence.managedCompressionBlock as Partial<Proof> | undefined;
  const automatic = evidence.automaticRecovery as { policy?: string; replay?: string } | undefined;
  return action.companyId === task.companyId && action.sourceIssueId === task.id &&
    action.kind === "active_run_watchdog" && action.cause === "legacy_execution_requires_reconciliation" &&
    action.status === "resolved" && action.outcome === "blocked" &&
    evidence.originalFailureCode === "omnigent_context_compression_failed" &&
    automatic?.policy === "preserve_without_replay_v1" && automatic.replay === "blocked" &&
    evidence.executionReconciliation == null && evidence.continuationDelivery == null &&
    task.status === "blocked" && !task.unblockDescriptor && !task.executionRunId && !task.checkoutRunId &&
    typeof runId === "string" && runId.length > 0 && evidence.runId === runId && proof?.runId === runId &&
    Number.isSafeInteger(proof.statusVersion) && proof.statusVersion === task.statusVersion &&
    typeof proof.updatedAt === "string" && Number.isFinite(Date.parse(proof.updatedAt)) &&
    Date.parse(proof.updatedAt) === task.updatedAt.getTime();
}
