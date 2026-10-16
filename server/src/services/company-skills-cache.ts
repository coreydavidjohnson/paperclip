import type { Db } from "@paperclipai/db";
import type { CompanySkillListItem } from "@paperclipai/shared";
import { createAsyncTtlCache } from "../lib/async-ttl-cache.js";

// Filesystem/external changes are visible within five seconds of a completed load.
const caches = new WeakMap<Db, ReturnType<typeof createAsyncTtlCache<CompanySkillListItem[]>>>();
export function companySkillsCache(db: Db) {
  let cache = caches.get(db);
  if (!cache) {
    cache = createAsyncTtlCache<CompanySkillListItem[]>(5_000);
    caches.set(db, cache);
  }
  return cache;
}

// Invalidate before and after failed/partial writes; overlapping writes keep
// reads uncached until the last writer finishes.
export function invalidateSkillListOnMutation<A extends unknown[], R>(
  db: Db, operation: (companyId: string, ...args: A) => Promise<R>,
) {
  return async (companyId: string, ...args: A): Promise<R> => {
    const finish = companySkillsCache(db).beginMutation(companyId);
    try { return await operation(companyId, ...args); }
    finally { finish(); }
  };
}
