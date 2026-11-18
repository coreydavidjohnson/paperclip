import { assertChiefRelayRunWriteAllowed } from "./chief-relay-run.js";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, approvals, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { chiefRelayProofHash, type ChiefRelay } from "../services/chief-relay-types.js";

export const resolvableApprovalStatuses = ["pending", "revision_requested"];

export function approvalResolutionRecords(db: Db) {
  const canResolveStatuses = new Set(resolvableApprovalStatuses);
  const resolvableStatuses = resolvableApprovalStatuses;
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };
  async function getExistingApproval(id: string, database: Db = db) {
    const existing = await database
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string | null,
    decisionNote: string | null | undefined,
    database: Db = db,
    chiefRelay?: ChiefRelay,
    publications?: ActivityPublication[],
    actorRunId?: string | null,
  ): Promise<ResolutionResult> {
    if (!decidedByUserId && !chiefRelay) throw unprocessable("Approval resolution requires a submitter");
    if (chiefRelay && decidedByUserId !== null) throw unprocessable("Chief relay must not impersonate a user");
    // Relay receipt and CAS commit together, including when the hire lifecycle
    // supplies its already-locked transaction and post-commit publications.
    if (chiefRelay && database === db) {
      const pending: ActivityPublication[] = [];
      const result = await db.transaction((tx) => resolveApproval(id, targetStatus, decidedByUserId, decisionNote, tx as unknown as Db, chiefRelay, pending, actorRunId));
      for (const publication of pending) publishActivity(publication);
      return result;
    }
    if (chiefRelay) await assertChiefRelayRunWriteAllowed(database, chiefRelay, actorRunId);
    const noteHash = createHash("sha256").update(JSON.stringify(decisionNote ?? null)).digest("hex");
    async function replay(approval: ApprovalRecord): Promise<ResolutionResult> {
      if (chiefRelay) {
        const receipt = await database.select().from(activityLog).where(and(
          eq(activityLog.companyId, approval.companyId), eq(activityLog.entityType, "approval"),
          eq(activityLog.entityId, id), eq(activityLog.action, "approval.chief_relay_resolved"),
        )).then((rows) => rows[0] ?? null);
        if (approval.decidedByUserId !== null || receipt?.details?.chiefRelayProofHash !== chiefRelayProofHash(chiefRelay)
          || receipt?.details?.status !== targetStatus || receipt?.details?.decisionNoteHash !== noteHash) {
          throw conflict("chief_relay_replay_mismatch");
        }
      }
      return { approval, applied: false };
    }
    const existing = await getExistingApproval(id, database);
    if (chiefRelay && chiefRelay.companyId !== existing.companyId) throw conflict("chief_relay_company_mismatch");
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return replay(existing);
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await database
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      if (chiefRelay) await logActivity(database, {
        companyId: updated.companyId, actorType: "agent", actorId: chiefRelay.agentId, agentId: chiefRelay.agentId, runId: actorRunId ?? null,
        responsibleUserIdOverride: null, action: "approval.chief_relay_resolved", entityType: "approval", entityId: id,
        details: { chiefRelay, chiefRelayProofHash: chiefRelayProofHash(chiefRelay), status: targetStatus, decisionNote: decisionNote ?? null, decisionNoteHash: noteHash, decidedByUserId: null },
      }, publications);
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id, database);
    if (latest.status === targetStatus) {
      return replay(latest);
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return { getExistingApproval, resolveApproval };
}
