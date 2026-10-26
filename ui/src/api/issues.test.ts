import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  api: mockApi,
}));

import { issuesApi } from "./issues";
import { ApiError } from "./client";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({
      id: "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      issueId: "5e5f9946-c706-4785-8988-d4d6f0f499ab",
      body: "Saved fixture",
    });
    mockApi.patch.mockResolvedValue({});
  });

  it.each([null, "stopped-run"])("dispatches a stopped queue using its current revision (%s)", async (target) => {
    mockApi.get.mockResolvedValueOnce({ queueId: "queue-1", targetRunId: null, revision: "revision-2" });
    await issuesApi.interruptLatestQueuedComments("issue-1", target);
    expect(mockApi.post).toHaveBeenCalledWith("/issues/issue-1/queued-comments/interrupt", {
      queueId: "queue-1", targetRunId: null, revision: "revision-2",
    });
  });

  it.each([
    { queueId: null, targetRunId: null, revision: "empty" },
    { queueId: "queue-1", targetRunId: "new-run", revision: "changed" },
  ])("rejects a changed or empty queue before interruption", async queue => {
    mockApi.get.mockResolvedValueOnce(queue);
    await expect(issuesApi.interruptLatestQueuedComments("issue-1", "old-run")).rejects.toThrow("queued messages changed");
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("fetches all pages of tasks created from the source without filtering parentage", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `task-${index}` }));
    mockApi.get.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([{ id: "last-task" }]);
    const result = await issuesApi.listAll("company-1", { createdFromIssueId: "source-1" });
    expect(result).toHaveLength(501);
    expect(mockApi.get).toHaveBeenNthCalledWith(1, "/companies/company-1/issues?createdFromIssueId=source-1&limit=500&sortField=id&sortDir=asc&includeReviewAttention=false&includeUnblockDescriptor=false");
    expect(mockApi.get).toHaveBeenNthCalledWith(2, "/companies/company-1/issues?createdFromIssueId=source-1&limit=500&sortField=id&sortDir=asc&afterId=task-499&includeReviewAttention=false&includeUnblockDescriptor=false");
  });

  it("opts out of unused metadata even when no filters are supplied", async () => {
    await issuesApi.list("company-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("can explicitly restore the default API metadata projection", async () => {
    await issuesApi.list("company-1", { includeReviewAttention: true, includeUnblockDescriptor: true });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeReviewAttention=true&includeUnblockDescriptor=true",
    );
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      parentId: "issue-parent-1",
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("sends explicit attachment receipt IDs with the atomic comment request", async () => {
    const ids = [
      "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      "5e5f9946-c706-4785-8988-d4d6f0f499ab",
    ];
    await issuesApi.addComment("issue-1", "Inspect these", true, false, ids);
    expect(mockApi.post).toHaveBeenCalledWith("/issues/issue-1/comments", {
      body: "Inspect these",
      reopen: true,
      interrupt: false,
      attachmentIds: ids,
    });
    await issuesApi.addComment(
      "issue-1",
      "[old](/api/attachments/old/content)",
    );
    expect(mockApi.post).toHaveBeenLastCalledWith("/issues/issue-1/comments", {
      body: "[old](/api/attachments/old/content)",
    });
  });

  it.each([
    new TypeError("Failed to fetch"),
    new SyntaxError("Unexpected end of JSON"),
    new ApiError("Internal", 500, {}),
  ])(
    "treats missing or invalid comment receipts as unknown %#",
    async (error) => {
      mockApi.post.mockRejectedValueOnce(error);
      await expect(
        issuesApi.addComment("issue-1", "saved maybe"),
      ).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
      mockApi.patch.mockRejectedValueOnce(error);
      await expect(
        issuesApi.update("issue-1", {
          comment: "saved maybe",
          assigneeUserId: "another",
        }),
      ).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
      mockApi.patch.mockRejectedValueOnce(error);
      await expect(
        issuesApi.update("issue-1", { title: "ordinary update" }),
      ).rejects.toBe(error);
    },
  );

  it.each([409, 422])(
    "retains a known HTTP%d comment rejection",
    async (status) => {
      const error = new ApiError("Rejected", status, {});
      mockApi.post.mockRejectedValueOnce(error);
      await expect(issuesApi.addComment("issue-1", "not saved")).rejects.toBe(
        error,
      );
      mockApi.patch.mockRejectedValueOnce(error);
      await expect(
        issuesApi.update("issue-1", { comment: "not saved" }),
      ).rejects.toBe(error);
    },
  );

  it.each([null, {}, { id: "not-a-comment", body: "text" }])(
    "does not confirm a parsed but missing comment receipt %#",
    async (receipt) => {
      mockApi.post.mockResolvedValueOnce(receipt);
      await expect(
        issuesApi.addComment("issue-1", "saved maybe"),
      ).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    },
  );
  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      descendantOf: "issue-root-1",
      includeBlockedBy: true,
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&includeBlockedBy=true&limit=25&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      workspaceId: "workspace-1",
      limit: 1000,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("passes pagination offsets through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { limit: 500, offset: 1500 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&offset=1500&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("passes issue list sort options through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      limit: 500,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&sortField=updated&sortDir=desc&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("requests the compact issue list view explicitly", async () => {
    await issuesApi.listCompact("company-1", {
      touchedByUserId: "me",
      includeLiveDescendantSummary: true,
      limit: 100,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?touchedByUserId=me&includeLiveDescendantSummary=true&limit=100&sortField=updated&sortDir=desc&includeReviewAttention=false&includeUnblockDescriptor=false&view=compact",
    );
  });

  it("passes plan document filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { hasPlanDocument: false, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?hasPlanDocument=false&limit=25&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("passes live descendant summary opt-in through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      includeLiveDescendantSummary: true,
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeLiveDescendantSummary=true&limit=25&includeReviewAttention=false&includeUnblockDescriptor=false",
    );
  });

  it("posts recovery action resolution to the source issue endpoint", async () => {
    await issuesApi.resolveRecoveryAction("issue-1", {
      actionId: "00000000-0000-0000-0000-0000000000aa",
      outcome: "restored",
      sourceIssueStatus: "done",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/issues/issue-1/recovery-actions/resolve",
      {
        actionId: "00000000-0000-0000-0000-0000000000aa",
        outcome: "restored",
        sourceIssueStatus: "done",
      },
    );
  });

  it("posts stalled review decisions to the dedicated endpoint", async () => {
    await issuesApi.decideStalledReview("issue-1", {
      action: "request_changes",
      note: "Please cover the race condition.",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/issues/issue-1/stalled-review-decision",
      {
        action: "request_changes",
        note: "Please cover the race condition.",
      },
    );
  });
});


describe("explicit replay-safe comment client (not the default composer path)", () => {
  const issueId = "5e5f9946-c706-4785-8988-d4d6f0f499ab";
  const clientRequestId = "12b44216-bd46-408b-a68e-1af6449e019a";
  const receipt = { id: "9af8228f-0be7-45ae-a104-6fbe0af6f1d3", issueId, clientRequestId, body: "Exact saved input" };
  beforeEach(() => { mockApi.post.mockReset(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([new TypeError("network lost before saving"), new SyntaxError("receipt lost after saving"), new ApiError("post-commit outage", 503, {})])(
    "retries only the dedicated safe endpoint with the same immutable operation %#", async error => {
      mockApi.post.mockRejectedValueOnce(error).mockResolvedValueOnce(receipt);
      const data = { clientRequestId, body: receipt.body, interrupt: true, attachmentIds: [receipt.id] };
      const pending = issuesApi.addReplaySafeComment(issueId, data);
      data.body = "Edited during outage";
      data.attachmentIds.push(issueId);
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toEqual(receipt);
      expect(mockApi.post).toHaveBeenCalledTimes(2);
      for (const [path, payload, options] of mockApi.post.mock.calls) {
        expect(path).toBe(`/issues/${issueId}/comments/replay-safe`);
        expect(payload).toEqual({ clientRequestId, body: receipt.body, interrupt: true, attachmentIds: [receipt.id] });
        expect(options.signal).toBeInstanceOf(AbortSignal);
      }
    },
  );

  it("bounds every hanging request with an abort deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    mockApi.post.mockImplementation((_path, _payload, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    try {
      const pending = issuesApi.addReplaySafeComment(issueId, { clientRequestId, body: receipt.body });
      const assertion = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
      await vi.advanceTimersByTimeAsync(31_000);
      await assertion;
      expect(timeout.mock.calls).toEqual([[10_000], [10_000], [10_000]]);
      expect(mockApi.post).toHaveBeenCalledTimes(3);
    } finally {
      timeout.mockRestore();
    }
  });

  it("bounds an outage at three safe attempts and never falls back to the ordinary route", async () => {
    mockApi.post.mockRejectedValue(new TypeError("offline"));
    const pending = issuesApi.addReplaySafeComment(issueId, { clientRequestId, body: receipt.body });
    const assertion = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(mockApi.post).toHaveBeenCalledTimes(3);
    expect(mockApi.post.mock.calls.map(([path]) => path)).toEqual(Array(3).fill(`/issues/${issueId}/comments/replay-safe`));
  });

  it.each([401, 403, 404, 409, 422])("does not retry or fall back after an initial known HTTP %d refusal", async status => {
    const error = new ApiError("Refused", status, { details: { code: "comment_operation_not_replay_safe" } });
    mockApi.post.mockRejectedValueOnce(error);
    await expect(issuesApi.addReplaySafeComment(issueId, { clientRequestId, body: receipt.body })).rejects.toBe(error);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it("preserves uncertainty when a later refusal cannot disprove the first attempt committed", async () => {
    mockApi.post.mockRejectedValueOnce(new TypeError("lost response"))
      .mockRejectedValueOnce(new ApiError("Task is now paused", 409, {}));
    const pending = issuesApi.addReplaySafeComment(issueId, { clientRequestId, body: receipt.body });
    const assertion = expect(pending).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(mockApi.post).toHaveBeenCalledTimes(2);
  });

  it.each([{ ...receipt, clientRequestId: issueId }, { ...receipt, issueId: clientRequestId }, null])(
    "does not confirm an unrelated or missing receipt %#", async invalid => {
      mockApi.post.mockResolvedValueOnce(invalid).mockResolvedValueOnce(receipt);
      const pending = issuesApi.addReplaySafeComment(issueId, { clientRequestId, body: receipt.body });
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toEqual(receipt);
      expect(mockApi.post).toHaveBeenCalledTimes(2);
    },
  );
});
