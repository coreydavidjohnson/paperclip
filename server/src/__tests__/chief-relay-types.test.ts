import { describe, expect, it } from "vitest";
import { chiefRelayProofHash, readChiefRelay, sameChiefRelay, type ChiefRelay } from "../services/chief-relay-types.js";

const proof: ChiefRelay = { agentId: "chief", companyId: "company", representedUserId: "local-board", sourceSessionId: "session",
  sourceMessageId: "message", exactQuote: "Approve this card.", scope: "This exact card", idempotencyKey: "relay-1", requestFingerprint: "fingerprint" };

describe("Chief relay proof receipts", () => {
  it("requires every authenticated proof field", () => {
    expect(readChiefRelay(proof)).toEqual(proof);
    for (const key of Object.keys(proof)) {
      expect(readChiefRelay({ ...proof, [key]: "" })).toBeUndefined();
      const missing = { ...proof } as Record<string, unknown>;
      delete missing[key];
      expect(readChiefRelay(missing)).toBeUndefined();
    }
  });
  it("compares every exact field rather than just the idempotency key", () => {
    expect(sameChiefRelay(proof, { ...proof })).toBe(true);
    for (const key of Object.keys(proof)) {
      expect(sameChiefRelay({ ...proof, [key]: "changed" }, proof)).toBe(false);
      expect(chiefRelayProofHash({ ...proof, [key]: "changed" })).not.toBe(chiefRelayProofHash(proof));
    }
  });
  it("ignores object ordering but preserves exact quote whitespace", () => {
    const reordered = Object.fromEntries(Object.entries(proof).reverse()) as ChiefRelay;
    expect(chiefRelayProofHash(reordered)).toBe(chiefRelayProofHash(proof));
    expect(chiefRelayProofHash({ ...proof, exactQuote: ` ${proof.exactQuote}` })).not.toBe(chiefRelayProofHash(proof));
  });
});
