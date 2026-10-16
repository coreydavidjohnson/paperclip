import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncTtlCache } from "./async-ttl-cache.js";

afterEach(() => vi.useRealTimers());

describe("bounded asynchronous TTL cache", () => {
  it("coalesces a cold load, caches success and expires after completion", async () => {
    vi.useFakeTimers();
    const cache = createAsyncTtlCache<number>(100);
    let resolve!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const first = cache.get("company", "actor/query", load);
    expect(cache.get("company", "actor/query", load)).toBe(first);
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(cache.get("company", "actor/query", load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(101);
    await expect(cache.get("company", "actor/query", async () => 8)).resolves.toBe(8);
  });

  it("isolates companies and actor/query/config keys", async () => {
    const cache = createAsyncTtlCache<number>(1000);
    expect(await cache.get("a", "actor-a", async () => 1)).toBe(1);
    expect(await cache.get("b", "actor-a", async () => 2)).toBe(2);
    expect(await cache.get("a", "actor-b", async () => 3)).toBe(3);
  });

  it("never retains rejected or synchronously throwing loads", async () => {
    const cache = createAsyncTtlCache<number>(1000);
    await expect(cache.get("a", "k", () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(cache.get("a", "k", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(cache.get("a", "k", async () => 3)).resolves.toBe(3);
  });

  it("does not publish an invalidated in-flight success or remove its replacement on rejection", async () => {
    const cache = createAsyncTtlCache<number>(1000);
    let resolve!: (value: number) => void;
    const stale = cache.get("a", "k", () => new Promise<number>((done) => { resolve = done; }));
    await Promise.resolve();
    cache.invalidate("a");
    await expect(cache.get("a", "k", async () => 2)).resolves.toBe(2);
    resolve(1);
    await stale;
    await expect(cache.get("a", "k", async () => 3)).resolves.toBe(2);
    cache.clear();
    let reject!: (error: Error) => void;
    const failed = cache.get("a", "k", () => new Promise<number>((_done, fail) => { reject = fail; }));
    await Promise.resolve();
    cache.clear();
    await cache.get("a", "k", async () => 4);
    reject(new Error("stale failure"));
    await expect(failed).rejects.toThrow("stale failure");
    await expect(cache.get("a", "k", async () => 5)).resolves.toBe(4);
  });

  it("bypasses reads until overlapping mutations finish, including failure cleanup", async () => {
    const cache = createAsyncTtlCache<number>(1000);
    await cache.get("a", "k", async () => 0);
    const finish1 = cache.beginMutation("a");
    const finish2 = cache.beginMutation("a");
    expect(await cache.get("a", "k", async () => 1)).toBe(1);
    finish1();
    expect(await cache.get("a", "k", async () => 2)).toBe(2);
    finish2();
    expect(await cache.get("a", "k", async () => 3)).toBe(3);
    expect(await cache.get("a", "k", async () => 4)).toBe(3);
  });

  it("evicts oldest entries at capacity", async () => {
    const cache = createAsyncTtlCache<number>(1000, 2);
    await cache.get("a", "1", async () => 1);
    await cache.get("a", "2", async () => 2);
    await cache.get("a", "3", async () => 3);
    expect(await cache.get("a", "1", async () => 4)).toBe(4);
  });
});
