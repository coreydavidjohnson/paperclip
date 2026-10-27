import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "./errors.js";

/** Stop revokes write authority before waiting for the executor to settle. */
export function agentRunWritesRevoked(run: {
  id?: string;
  companyId?: string;
  status: string;
  resultJson?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const cancellation = run?.resultJson?.executionCancellation;
  const native = run?.resultJson?.nativeCancellation;
  const nativeIntent = native && typeof native === "object" && !Array.isArray(native)
    ? native as Record<string, unknown> : null;
  return run?.status === "cancelled" || Boolean(cancellation && typeof cancellation === "object"
    && "state" in cancellation && cancellation.state === "requested")
    || Boolean(nativeIntent && nativeIntent.schema === "paperclip.native-cancellation.v1"
      && run?.id && nativeIntent.runId === run.id
      && run.companyId && nativeIntent.companyId === run.companyId
      && typeof nativeIntent.intentId === "string" && nativeIntent.intentId
      && typeof nativeIntent.intentAuditId === "string" && nativeIntent.intentAuditId
      && ["turn", "run", "issue"].includes(nativeIntent.scope as string)
      && ["pending", "acknowledged"].includes(nativeIntent.dispatchState as string)
      && typeof nativeIntent.dispatched === "boolean");
}

/** The caller must supply its write transaction, so Stop and commit serialize. */
export async function assertAgentRunWriteAllowed(tx: Db, companyId: string, actor: {
  agentId?: string | null;
  runId?: string | null;
  stopId?: string | null;
}) {
  if (!actor.agentId || !actor.runId) return;
  const [run] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
    runtimeMode: heartbeatRuns.runtimeMode,
    contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId)))
    .for("share");
  const stoppedForThisMutation = run?.status === "cancelled" && actor.stopId &&
    run.resultJson?.issueMutationStopId === actor.stopId;
  if (agentRunWritesRevoked(run) && !stoppedForThisMutation) {
    throw forbidden("This run was cancelled", { code: "agent_run_cancelled" });
  }
  return run;
}
