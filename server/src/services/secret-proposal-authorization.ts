import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { readChiefRelay, type ChiefRelay } from "./chief-relay-types.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

export async function assertCanResolveProposal(input: {
  db: Db;
  actor: AuthorizationActor;
  companyId: string;
  proposal: ResolvableSecretProposal;
  assertSecretDefinitionAdmin?: () => void;
  chiefRelay?: ChiefRelay;
}) {
  if (input.chiefRelay) {
    const relay = readChiefRelay(input.chiefRelay);
    if (!relay || input.actor.type !== "agent" || input.actor.userId
      || input.actor.agentId !== relay.agentId || input.actor.companyId !== relay.companyId
      || input.companyId !== relay.companyId) {
      throw forbidden("Chief relay does not match the secret proposal actor or company");
    }
    // This server-authenticated relay is explicit delegated approval authority.
    // Target snapshots, expiry and configuration conflicts remain checked by approve.
    if (input.proposal.kind !== "secret" && (input.proposal.kind !== "binding" || !input.proposal.targetId)) {
      throw unprocessable("Binding proposal target is missing");
    }
    return;
  }
  if (input.proposal.kind === "secret") {
    if (!input.assertSecretDefinitionAdmin) {
      throw forbidden("Company admin access required");
    }
    input.assertSecretDefinitionAdmin();
    return;
  }
  if (input.proposal.kind !== "binding" || !input.proposal.targetId) {
    throw unprocessable("Binding proposal target is missing");
  }
  const decision = await accessService(input.db).decide({
    actor: input.actor,
    action: "agent_config:update",
    resource: {
      type: "agent",
      companyId: input.companyId,
      agentId: input.proposal.targetId,
    },
    scope: { requiresChangeGrant: true },
  });
  if (!decision.allowed) {
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}
