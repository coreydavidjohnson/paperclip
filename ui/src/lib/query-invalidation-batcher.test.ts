import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  createCoalescingQueryClient,
  createInvalidationBatcher,
  reconcileActiveQueries,
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

describe("reconnect reconciliation budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("budgets broad reconnects while reconciling details promptly", async () => {
    const { client, calls } = fakeClient();
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    const proxied = createCoalescingQueryClient(client as unknown as QueryClient, batcher);
    for (let second = 0; second < 60; second++) {
      reconcileActiveQueries(client, batcher, "company-1");
      await vi.advanceTimersByTimeAsync(1000);
    }
    const listQuery = { queryKey: ["issues", "company-1"] } as any;
    const detailQuery = { queryKey: ["issues", "detail", "issue-1"] } as any;
    const otherCompany = { queryKey: ["issues", "company-2"] } as any;
    const matches = (query: any) => calls.filter((f: any) => (!f.predicate || f.predicate(query)) && (!f.queryKey || f.queryKey.every((part: unknown, index: number) => part === query.queryKey[index]))).length;
    expect(matches(listQuery)).toBe(6);
    expect(matches(detailQuery)).toBe(60);
    expect(matches(otherCompany)).toBe(60);
    expect(matches({ queryKey: ["attention", "company-1"] })).toBe(6);
    batcher.dispose();
  });
});

describe("mixed reconnect and activity budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("shares list slots between reconnect repairs and ordinary live events", async () => {
    const { client, calls } = fakeClient();
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    const proxied = createCoalescingQueryClient(client as unknown as QueryClient, batcher);
    for (let second = 0; second < 60; second++) {
      reconcileActiveQueries(client, batcher, "company-1");
      void proxied.invalidateQueries({ queryKey: ["issues", "company-1"] });
      void proxied.invalidateQueries({ queryKey: ["attention", "company-1"] });
      await vi.advanceTimersByTimeAsync(1000);
    }
    for (const key of ["issues", "attention"]) {
      expect(calls.filter((f: any) => f.queryKey?.[0] === key)).toHaveLength(6);
    }
    batcher.dispose();
  });
});

describe("repair lifecycle and in-flight requests", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("restarts after hidden disposal and repairs visible projections within ten seconds", async () => {
    const { client, calls } = fakeClient();
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    void batcher.schedule({ queryKey: ["issues", "company-1"] });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    batcher.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    vi.stubGlobal("document", { visibilityState: "visible" });
    reconcileActiveQueries(client, batcher, "company-1");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(1); // Immediate detail repair only.
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    batcher.dispose();
  });
  it("does not cancel an in-flight list request when a repair flushes", async () => {
    const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const key = ["issues", "company-1"];
    client.setQueryData(key, ["before"]);
    let complete!: (value: string[]) => void;
    const aborted = vi.fn();
    const fetch = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", aborted);
      return new Promise<string[]>(resolve => { complete = resolve; });
    });
    const observer = new QueryObserver(client, { queryKey: key, queryFn: fetch, staleTime: Infinity });
    const stop = observer.subscribe(() => {});
    const mutationRefresh = client.invalidateQueries({ queryKey: key });
    const batcher = createInvalidationBatcher(client, undefined, "company-1");
    reconcileActiveQueries(client, batcher, "company-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(aborted).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    complete(["after"]);
    await mutationRefresh;
    expect(client.getQueryData(key)).toEqual(["after"]);
    stop(); batcher.dispose(); client.clear();
  });
});
