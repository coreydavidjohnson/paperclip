import type { Db } from "@paperclipai/db";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { forbidden } from "../errors.js";
import type { ChiefRelay } from "../services/chief-relay-types.js";

/** Lock the real submitting run in the native write transaction, never mint one. */
export async function assertChiefRelayRunWriteAllowed(db: Db, relay: ChiefRelay, runId?: string | null) {
  if (!runId) return;
  const run = await assertAgentRunWriteAllowed(db, relay.companyId, { agentId: relay.agentId, runId });
  if (!run) throw forbidden("Chief relay requires the current registered run");
  if (run.status !== "running") throw forbidden("Chief relay requires an active running run");
}
