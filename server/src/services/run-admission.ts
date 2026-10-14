import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { isControllerDraining } from "../controller-drain.js";

/** Inside the SAME transaction as every queued -> running claim. Nonblocking
 * advisory locking avoids inversions with issue/wake/run row locks.
 * ponytail: hash collisions conservatively defer unrelated agents.
 */
export async function admitAgentRun(tx: Db, companyId: string, agentId: string, maxConcurrentRuns: number) {
  if (isControllerDraining()) return false;
  const key = `paperclip:agent-admission:${companyId}:${agentId}`;
  const result = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as admitted`);
  if (!(result as unknown as Array<{ admitted: boolean }>)[0]?.admitted) return false;
  const [row] = await tx.select({ count: sql<number>`count(*)` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.status, "running")));
  return !isControllerDraining() && Number(row.count) < maxConcurrentRuns;
}
