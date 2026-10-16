// Invalidated loads may finish for their caller, but never repopulate the cache.
export function createAsyncTtlCache<T>(ttlMs: number, maxEntries = 256) {
  const entries = new Map<string, { scope: string; promise: Promise<T>; expiresAt: number }>();
  const mutations = new Map<string, number>();
  function invalidate(scope: string) {
    for (const [key, entry] of entries) if (entry.scope === scope) entries.delete(key);
  }
  return {
    invalidate,
    clear: () => entries.clear(),
    beginMutation(scope: string) {
      invalidate(scope);
      mutations.set(scope, (mutations.get(scope) ?? 0) + 1);
      return () => {
        invalidate(scope);
        const remaining = (mutations.get(scope) ?? 1) - 1;
        if (remaining) mutations.set(scope, remaining);
        else mutations.delete(scope);
      };
    },
    get(scope: string, key: string, load: () => Promise<T>): Promise<T> {
      if (mutations.has(scope)) return Promise.resolve().then(load);
      const id = JSON.stringify([scope, key]);
      const cached = entries.get(id);
      if (cached && cached.expiresAt > Date.now()) return cached.promise;
      entries.delete(id);
      for (const [key, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      const entry = { scope, promise: Promise.resolve().then(load), expiresAt: Infinity };
      entries.set(id, entry);
      void entry.promise.then(
        () => { entry.expiresAt = Date.now() + ttlMs; },
        () => { if (entries.get(id) === entry) entries.delete(id); },
      );
      return entry.promise;
    },
  };
}
