// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mockApi = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./client", async importOriginal => ({
  ...(await importOriginal<typeof import("./client")>()), api: mockApi,
}));
import { issuesApi } from "./issues";
import { ApiError } from "./client";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";

describe("durable replay-safe composer requests", () => {
  const scope = { companyId: "ace1052c-33b6-4a65-af5b-2e426459c505", issueId: "5e5f9946-c706-4785-8988-d4d6f0f499ab", userId: "original-user" };
  const clientRequestId = "12b44216-bd46-408b-a68e-1af6449e019a";
  const payload = { clientRequestId, body: "Original request", attachmentIds: ["9af8228f-0be7-45ae-a104-6fbe0af6f1d3"] };
  const receipt = { id: "aaf8228f-0be7-45ae-a104-6fbe0af6f1d3", ...scope, authorUserId: scope.userId, ...payload };
  beforeEach(() => { sessionStorage.clear(); mockApi.post.mockReset(); vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  const issue = { id: scope.issueId, companyId: scope.companyId, status: "in_progress", assigneeAgentId: payload.attachmentIds[0], conversationAgentId: null };
  it("selects the safe composer route for ordinary assigned-task comments", async () => {
    mockApi.post.mockResolvedValue(receipt);
    await issuesApi.addComposerComment(scope, issue, payload);
    expect(mockApi.post.mock.calls[0]?.[0]).toBe(`/issues/${scope.issueId}/comments/replay-safe`);
  });
  it.each([
    { status: "done" }, { status: "cancelled" }, { status: "in_review" },
    { assigneeAgentId: null }, { conversationAgentId: payload.attachmentIds[0] },
  ])("keeps unsupported initial composer variants one-shot (%j)", async variant => {
    mockApi.post.mockResolvedValue(receipt);
    await issuesApi.addComposerComment(scope, { ...issue, ...variant }, payload);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post.mock.calls[0]?.[0]).toBe(`/issues/${scope.issueId}/comments`);
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(false);
  });
  it.each([{ reopen: true }, { interrupt: true }])("does not opt control transitions into composer retries (%j)", async flags => {
    mockApi.post.mockResolvedValue(receipt);
    await issuesApi.addComposerComment(scope, issue, { ...payload, ...flags });
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post.mock.calls[0]?.[0]).toBe(`/issues/${scope.issueId}/comments`);
  });
  it("does not downgrade an uncertain saved request after the issue becomes unsupported", async () => {
    mockApi.post.mockRejectedValue(new TypeError("lost"));
    const pending = issuesApi.addComposerComment(scope, issue, payload);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    mockApi.post.mockResolvedValue(receipt);
    await issuesApi.addComposerComment(scope, { ...issue, status: "done" }, payload);
    expect(mockApi.post.mock.calls.map(([path]) => path)).toEqual(Array(4).fill(`/issues/${scope.issueId}/comments/replay-safe`));
  });
  it("persists before sending and removes only its own confirmed request", async () => {
    mockApi.post.mockImplementation(async () => {
      expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(true);
      return receipt;
    });
    expect(await issuesApi.addRecoverableComment(scope, payload)).toEqual(receipt);
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(false);
    expect(mockApi.post).toHaveBeenCalledWith(`/issues/${scope.issueId}/comments/replay-safe`, payload,
      expect.objectContaining({ headers: {
        "X-Paperclip-Expected-User-Id": scope.userId,
        "X-Paperclip-Expected-Company-Id": scope.companyId,
      } }));
  });

  it("recovers the immutable saved payload after module reload without reading the conversation", async () => {
    mockApi.post.mockRejectedValue(new TypeError("offline"));
    const mutable = structuredClone(payload);
    const pending = issuesApi.addRecoverableComment(scope, mutable);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    mutable.body = "Next draft must not be sent";
    mutable.attachmentIds.push(scope.issueId);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(true);
    vi.resetModules();
    const reloaded = (await import("./issues")).issuesApi;
    mockApi.post.mockResolvedValue(receipt);
    expect(await reloaded.recoverComment(scope, clientRequestId)).toEqual(receipt);
    expect(mockApi.post).toHaveBeenCalledTimes(4);
    for (const [path, sent] of mockApi.post.mock.calls) {
      expect(path).toBe(`/issues/${scope.issueId}/comments/replay-safe`);
      expect(sent).toEqual(payload);
    }
    expect(reloaded.canRecoverComment(scope, clientRequestId)).toBe(false);
  });

  it.each(["userId", "companyId", "issueId"] as const)("refuses another %s without network or record changes", async field => {
    mockApi.post.mockRejectedValue(new TypeError("offline"));
    const pending = issuesApi.addRecoverableComment(scope, payload);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    const saved = sessionStorage.getItem(sessionStorage.key(0)!);
    const foreign = { ...scope, [field]: field === "userId" ? "other-user" : payload.attachmentIds[0] };
    expect(issuesApi.canRecoverComment(foreign, clientRequestId)).toBe(false);
    await expect(issuesApi.recoverComment(foreign, clientRequestId)).rejects.toThrow();
    expect(mockApi.post).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(saved);
  });

  it("keeps uncertainty after a reload-time known refusal and does not downgrade to legacy", async () => {
    mockApi.post.mockRejectedValue(new TypeError("response lost"));
    const pending = issuesApi.addRecoverableComment(scope, payload);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    mockApi.post.mockRejectedValue(new ApiError("Stopped", 409, {}));
    await expect(issuesApi.recoverComment(scope, clientRequestId)).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(true);
    expect(mockApi.post).toHaveBeenCalledTimes(4);
  });

  it("clears an initial known refusal but never silently chooses a different endpoint", async () => {
    const refusal = new ApiError("Unsupported", 409, { details: { code: "comment_operation_not_replay_safe" } });
    mockApi.post.mockRejectedValue(refusal);
    await expect(issuesApi.addRecoverableComment(scope, payload)).rejects.toBe(refusal);
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(false);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it("refuses before network when browser storage cannot retain the request", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    await expect(issuesApi.addRecoverableComment(scope, payload)).rejects.toThrow("Browser storage");
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("does not replace an existing operation with edited text under its old key", async () => {
    mockApi.post.mockRejectedValue(new TypeError("offline"));
    const pending = issuesApi.addRecoverableComment(scope, payload);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    await expect(issuesApi.addRecoverableComment(scope, { ...payload, body: "Edited" })).rejects.toThrow();
    expect(mockApi.post).toHaveBeenCalledTimes(3);
    mockApi.post.mockResolvedValue(receipt);
    await issuesApi.recoverComment(scope, clientRequestId);
    expect(mockApi.post.mock.lastCall?.[1]).toEqual(payload);
  });

  it("rejects a receipt for a different authenticated author even with the right request key", async () => {
    mockApi.post.mockResolvedValue({ ...receipt, authorUserId: "new-user" });
    const pending = issuesApi.addRecoverableComment(scope, payload);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(true);
  });

  it("reconciles only a matching authenticated server comment, not optimistic or unrelated content", async () => {
    mockApi.post.mockRejectedValue(new TypeError("offline"));
    const pending = issuesApi.addRecoverableComment(scope, payload);
    const failed = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000); await failed;
    issuesApi.confirmRecoveredComment(scope, { ...receipt, authorUserId: "other" });
    issuesApi.confirmRecoveredComment(scope, { ...receipt, clientStatus: "pending" });
    issuesApi.confirmRecoveredComment(scope, { ...receipt, body: "different" });
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(true);
    issuesApi.confirmRecoveredComment(scope, receipt);
    expect(issuesApi.canRecoverComment(scope, clientRequestId)).toBe(false);
  });
});
