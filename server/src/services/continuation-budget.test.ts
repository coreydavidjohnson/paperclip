import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { boundExecutionContinuation } from "./continuation-budget.js";

const envelope = (exactQuote: string): ExecutionContinuationEnvelope => ({
  version: 1, companyId: "company", issueId: "issue", trigger: { reason: "relay", interactionId: "card", sourceRunId: null },
  originCommentIds: [], objective: "Only the reviewed target.", messages: [], humanResponses: [],
  relayedResponses: [{ id: "card", kind: "request_confirmation", status: "accepted", resolvedByAgentId: "chief",
    resolvedByRunId: null, resolvedAt: "2026-10-25T00:00:00Z", representedUserId: "corey",
    sourceSessionId: "session", sourceMessageId: "message", exactQuote, scope: "Only this card.",
    result: { version: 1, outcome: "accepted" } }],
  interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
  coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
});

describe("relay continuation budget", () => {
  it("preserves the exact relay quote and independent delta without mutating the full baseline", () => {
    const source = envelope("  Accept only the reviewed target.  ");
    source.resumeDelta = { baseRunId: "previous", messages: [], relayedResponses: { updated: source.relayedResponses!, removedIds: ["old"] } };
    const original = JSON.stringify(source);
    const projection = boundExecutionContinuation(source);
    expect(projection.relayedResponses).toEqual(source.relayedResponses);
    expect(projection.resumeDelta?.relayedResponses).toEqual(source.resumeDelta.relayedResponses);
    expect(JSON.stringify(source)).toBe(original);
  });
  it("withdraws inline relay authority instead of truncating an oversized quote or reusing its delta", () => {
    const source = envelope("<quoted target>".repeat(4000));
    source.resumeDelta = { baseRunId: "previous", messages: [], relayedResponses: { updated: source.relayedResponses!, removedIds: [] } };
    const projection = boundExecutionContinuation(source);
    expect(projection.coverage.requiresThreadFetch).toBe(true);
    expect(projection.relayedResponses).toEqual([]);
    expect(projection.resumeDelta).toBeUndefined();
    expect(source.relayedResponses?.[0].exactQuote).toBe("<quoted target>".repeat(4000));
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(24 * 1024);
  });
});
