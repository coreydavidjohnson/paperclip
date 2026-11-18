import { createHash } from "node:crypto";

/** Server-authenticated proof only. Never derive this from a native request body. */
export type ChiefRelay = {
  agentId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  exactQuote: string;
  scope: string;
  idempotencyKey: string;
  representedUserId: string;
  companyId: string;
  requestFingerprint: string;
};

const proofKeys = ["agentId", "sourceSessionId", "sourceMessageId", "exactQuote", "scope", "idempotencyKey", "representedUserId", "companyId", "requestFingerprint"] as const;

export function readChiefRelay(value: unknown): ChiefRelay | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!proofKeys.every((key) => typeof record[key] === "string" && record[key].trim().length > 0)) return undefined;
  return Object.fromEntries(proofKeys.map((key) => [key, record[key]])) as ChiefRelay;
}

export function sameChiefRelay(value: unknown, proof: ChiefRelay): boolean {
  const stored = readChiefRelay(value);
  return Boolean(stored && proofKeys.every((key) => stored[key] === proof[key]));
}

/** Stable receipt comparison survives normal activity-log text redaction. */
export function chiefRelayProofHash(proof: ChiefRelay): string {
  return createHash("sha256").update(JSON.stringify(proofKeys.map((key) => proof[key]))).digest("hex");
}
