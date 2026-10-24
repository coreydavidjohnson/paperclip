import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as invalidation from "./query-invalidation-batcher";
import {
  createCoalescingQueryClient,
  createInvalidationBatcher,
} from "./query-invalidation-batcher";

function fakeClient() {
  const calls: unknown[] = [];
  const client = {
    invalidateQueries: vi.fn((filters?: unknown) => {
      calls.push(filters);
      return Promise.resolve();
    }),
  };
  return { client, calls };
}

describe("createInvalidationBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("marks queries stale without refetching when the tab hides before flush", async () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client);
    const pending = batcher.schedule({ queryKey: ["dashboard", "c1"] });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await batcher.flush();
    await pending;
    expect(client.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["dashboard", "c1"], refetchType: "none" });
  });

  it("coalesces repeated invalidations of the same key into one call per window", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    for (let i = 0; i < 20; i++) batcher.schedule({ queryKey: ["dashboard", "c1"] });
    expect(client.invalidateQueries).not.toHaveBeenCalled(); // nothing until flush

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["dashboard", "c1"] });
  });

  it("keeps distinct keys and distinct refetchType variants separate", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.schedule({ queryKey: ["b"] });
    batcher.schedule({ queryKey: ["a"] }); // dup of first
    batcher.schedule({ queryKey: ["a"], refetchType: "inactive" }); // distinct variant

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3);
  });

  it("never coalesces predicate-based invalidations", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    // Two distinct predicate filters must both run — they can't be proven equal.
    batcher.schedule({ predicate: () => true });
    batcher.schedule({ predicate: () => false });

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("schedule() resolves only after the flush has invalidated", async () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    let resolved = false;
    const p = batcher.schedule({ queryKey: ["a"] }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false); // not yet — window still open
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await p;
    expect(resolved).toBe(true);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh window after flushing", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);

    batcher.schedule({ queryKey: ["a"] });
    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels a pending flush", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("flush() invalidates immediately", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.flush();
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });
});

describe("createCoalescingQueryClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("batches invalidateQueries but passes other methods straight through", () => {
    const setQueryData = vi.fn();
    const getQueryData = vi.fn(() => ({ some: "data" }));
    const realInvalidate = vi.fn(() => Promise.resolve());
    const real = { invalidateQueries: realInvalidate, setQueryData, getQueryData } as unknown as QueryClient;

    const batcher = createInvalidationBatcher(
      { invalidateQueries: realInvalidate } as unknown as QueryClient,
      300,
    );
    const proxied = createCoalescingQueryClient(real, batcher);

    // setQueryData / getQueryData pass through immediately.
    proxied.setQueryData(["k"], 1);
    expect(setQueryData).toHaveBeenCalledWith(["k"], 1);
    expect(proxied.getQueryData(["k"])).toEqual({ some: "data" });

    // invalidateQueries is deferred through the batcher.
    void proxied.invalidateQueries({ queryKey: ["k"] });
    void proxied.invalidateQueries({ queryKey: ["k"] });
    expect(realInvalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(realInvalidate).toHaveBeenCalledTimes(1);
  });
});

describe("company list request budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("bounds a minute of activity to six list refreshes without delaying detail", async () => {
    const { client, calls } = fakeClient();
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    for (let second = 0; second < 60; second++) {
      void batcher.schedule({ queryKey: ["issues", "company-1"] });
      void batcher.schedule({ queryKey: ["issues", "company-1", "mine-by-me"] });
      void batcher.schedule({ queryKey: ["attention", "company-1"] });
      void batcher.schedule({ queryKey: ["issues", "detail", "issue-1"] });
      await vi.advanceTimersByTimeAsync(1000);
    }
    const matching = (key: unknown[]) => calls.filter((call: any) => JSON.stringify(call.queryKey) === JSON.stringify(key)).length;
    console.info(JSON.stringify({ issuesPerMinute: matching(["issues", "company-1"]), attentionPerMinute: matching(["attention", "company-1"]), detailPerMinute: matching(["issues", "detail", "issue-1"]) }));
    expect(matching(["issues", "company-1"])).toBe(6);
    expect(matching(["attention", "company-1"])).toBe(6);
    expect(matching(["issues", "company-1", "mine-by-me"])).toBe(0);
    expect(matching(["issues", "detail", "issue-1"])).toBe(60);
    batcher.dispose();
  });
});

describe("prefix filter safety", () => {
  it.each([
    [{ stale: true }, { stale: false }],
    [{ fetchStatus: "fetching" }, { fetchStatus: "idle" }],
  ])("keeps parent and child with different filters", async (parent, child) => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 1);
    void batcher.schedule({ queryKey: ["issues", "company-1"], ...parent } as any);
    void batcher.schedule({ queryKey: ["issues", "company-1", "mine"], ...child } as any);
    await batcher.flush();
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
    batcher.dispose();
  });
});


describe("PER-827 recovery request budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("shares 36 list request slots across six minutes of activity and reconnects", async () => {
    expect(invalidation).toHaveProperty("reconcileActiveQueries", expect.any(Function));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    const reads = { issues: 0, attention: 0, detail: 0, otherCompany: 0 };
    const keys = { issues: ["issues", "company-1"], attention: ["attention", "company-1"], detail: ["issues", "detail", "issue-1"], otherCompany: ["issues", "company-2"] };
    const subscriptions = Object.entries(keys).map(([name, queryKey]) => {
      const observer = new QueryObserver(client, { queryKey, queryFn: async () => ++reads[name as keyof typeof reads] });
      return observer.subscribe(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    try {
      for (let second = 0; second < 360; second++) {
        void batcher.schedule({ queryKey: keys.issues });
        void batcher.schedule({ queryKey: [...keys.issues, "mine"] });
        void batcher.schedule({ queryKey: keys.attention });
        if (second % 3 === 0) invalidation.reconcileActiveQueries(client, batcher, "company-1");
        await vi.advanceTimersByTimeAsync(1000);
      }
      console.info(JSON.stringify({ sixMinuteRequestsIncludingInitial: reads }));
      expect(reads).toEqual({ issues: 37, attention: 37, detail: 121, otherCompany: 121 });
      // Inactive matching projections still become stale without a request.
      client.setQueryData(["issues", "company-1", "inactive"], []);
      invalidation.reconcileActiveQueries(client, batcher, "company-1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.getQueryState(["issues", "company-1", "inactive"])?.isInvalidated).toBe(true);
    } finally {
      batcher.dispose();
      subscriptions.forEach(unsubscribe => unsubscribe());
      client.clear();
    }
  });

  it.each(["issues", "attention"])("preserves one trailing refresh without cancelling a slow %s request", async (projection) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    const queryKey = [projection, "company-1"];
    client.setQueryData(queryKey, "cached");
    const aborted = vi.fn();
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", aborted);
      const response = read.mock.calls.length === 1 ? "stale snapshot" : "fresh";
      return new Promise<string>(resolve => setTimeout(() => resolve(response), 25_000));
    });
    const observer = new QueryObserver(client, { queryKey, queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    try {
      void batcher.schedule({ queryKey });
      await vi.advanceTimersByTimeAsync(10_000);
      for (let event = 0; event < 20; event++) void batcher.schedule({ queryKey });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(aborted).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(client.getQueryData(queryKey)).toBe("stale snapshot");
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(client.getQueryData(queryKey)).toBe("fresh");
      expect(aborted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { batcher.dispose(); unsubscribe(); client.clear(); }
  });

  it.each(["issues", "attention"])("discards a slow %s trailing refresh on dispose", async (projection) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    const queryKey = [projection, "company-1"];
    client.setQueryData(queryKey, "cached");
    const aborted = vi.fn();
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", aborted);
      return new Promise<string>(resolve => setTimeout(() => resolve("stale snapshot"), 25_000));
    });
    const observer = new QueryObserver(client, { queryKey, queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    try {
      void batcher.schedule({ queryKey });
      await vi.advanceTimersByTimeAsync(10_000);
      const pending = batcher.schedule({ queryKey });
      await vi.advanceTimersByTimeAsync(10_000);
      batcher.dispose();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(client.getQueryData(queryKey)).toBe("stale snapshot");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(aborted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { batcher.dispose(); unsubscribe(); client.clear(); }
  });
});
