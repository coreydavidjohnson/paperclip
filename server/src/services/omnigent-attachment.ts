import { apiMetrics } from "../api-metrics.js";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
type Run = typeof heartbeatRuns.$inferSelect;

// Intent commits before POST. Uncertain delivery is settled from transcript
// evidence only: controller failover must never replay a provider side effect.
export function validOmnigentReceipt(run: Pick<Run, "id" | "companyId" | "agentId">, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return r.version === 1 && r.runId === run.id && r.companyId === run.companyId &&
    r.agentId === run.agentId && typeof r.omnigentSessionId === "string" && !!r.omnigentSessionId &&
    ["intent", "accepted", "observed"].includes(String(r.state));
}
export async function saveOmnigentDispatchReceipt(db: Db, run: Run, value: unknown) {
  if (!validOmnigentReceipt(run, value)) throw new Error("Invalid OmniGenT dispatch receipt");
  const receipt = value as Record<string, unknown>;
  const [saved] = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ omnigentDispatchReceipt: receipt })}::jsonb`,
    executionStage: "external_attached",
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
    sql`(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt' is null or
      ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'omnigentSessionId' = ${receipt.omnigentSessionId as string})`,
    sql`(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'userItemId' is null or ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'userItemId' = ${String(receipt.userItemId ?? '')})`,
    sql`(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'activeResponseId' is null or ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'activeResponseId' = ${String(receipt.activeResponseId ?? '')})`,
    sql`(${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'turnId' is null or ${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'turnId' = ${String(receipt.turnId ?? '')})`,
  )).returning({ id: heartbeatRuns.id });
  if (!saved) {
    apiMetrics.failure("disposition_failure");
    throw new Error("Legacy controller lease lost");
  }
}
export async function claimOmnigentAttachment(db: Db, run: Run) {
  if (!run.controllerBootId || !validOmnigentReceipt(run, run.resultJson?.omnigentDispatchReceipt)) return false;
  const [claimed] = await db.update(heartbeatRuns).set({
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "external_attached",
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "legacy"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt'->>'runId' = ${run.id}`,
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(claimed);
}
export async function releaseOmnigentAttachment(db: Db, run: Run) {
  await db.update(heartbeatRuns).set({
    executionStage: "awaiting_external_evidence", controllerLeaseExpiresAt: sql`clock_timestamp()`,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId)));
}

/** Already admitted work is observed, not dispatched. Never trust wake context. */
export async function loadOwnedOmnigentObservation(db: Db, run: Pick<Run, "id" | "companyId" | "agentId">) {
  const [owned] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'omnigent'`,
  ));
  if (!owned || !validOmnigentReceipt(owned, owned.resultJson?.omnigentDispatchReceipt)) return null;
  const issueId = owned.contextSnapshot?.issueId;
  if (typeof issueId === "string") {
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, owned.companyId), eq(issues.id, issueId),
      eq(issues.assigneeAgentId, owned.agentId), sql`${issues.status} != 'cancelled'`,
    ));
    if (!issue) return null;
  }
  return owned.resultJson!.omnigentDispatchReceipt as Record<string, unknown>;
}

/** Exact receipt and live boot lease fence the terminal CAS; Stop wins. */
export async function finalizeOwnedOmnigentObservation(db: Db, run: Run, receipt: Record<string, unknown>,
  status: string, patch: Partial<typeof heartbeatRuns.$inferInsert>) {
  if (!validOmnigentReceipt(run, receipt)) return null;
  const issueId = run.contextSnapshot?.issueId;
  const [saved] = await db.update(heartbeatRuns).set({ ...patch, status,
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(patch.resultJson ?? {})}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "legacy"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId), gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
    sql`${heartbeatRuns.resultJson}->'omnigentDispatchReceipt' = ${JSON.stringify(receipt)}::jsonb`,
    typeof issueId === "string" ? sql`exists (select 1 from ${issues} where ${issues.id} = ${issueId}
      and ${issues.companyId} = ${run.companyId} and ${issues.assigneeAgentId} = ${run.agentId} and ${issues.status} != 'cancelled')` : undefined,
  )).returning();
  return saved ?? null;
}
