import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { ExternalRunHandle } from "@paperclipai/adapter-utils";

type Observer = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "observerEpoch">;

/** Authority belongs to this observer generation, never to a refreshed run row. */
export function externalObserverCondition(run: Observer) {
  return and(
    eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.observerEpoch, run.observerEpoch),
  );
}

function progressValues() {
  return {
    lastProgressAt: sql`clock_timestamp()`,
    unknownSince: null,
    // A new observation invalidates all previous gone-confirmation evidence.
    livenessProbe: null,
    livenessVersion: sql`${heartbeatRuns.livenessVersion} + 1`,
    updatedAt: sql`clock_timestamp()`,
  };
}

export async function persistExternalRunHandle(db: Db, run: Observer, handle: ExternalRunHandle) {
  const [updated] = await db.update(heartbeatRuns).set({
    ...progressValues(), externalRunHandle: handle,
  }).where(externalObserverCondition(run)).returning({ id: heartbeatRuns.id });
  return Boolean(updated);
}

export async function recordExternalRunProgress(db: Db, run: Observer) {
  const [updated] = await db.update(heartbeatRuns).set(progressValues())
    .where(externalObserverCondition(run)).returning({ id: heartbeatRuns.id });
  return Boolean(updated);
}

/** Called before entering a legacy adapter, including adapters without handles. */
export async function persistExternalRunDispatchDeadline(db: Db, run: Observer) {
  const [updated] = await db.update(heartbeatRuns).set({
    deadlineAt: sql`coalesce(${heartbeatRuns.deadlineAt}, clock_timestamp() + interval '12 hours')`,
    updatedAt: sql`clock_timestamp()`,
  }).where(externalObserverCondition(run)).returning({ id: heartbeatRuns.id });
  return Boolean(updated);
}
