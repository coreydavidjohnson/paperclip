import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { companySkillsCache, invalidateSkillListOnMutation } from "./company-skills-cache.js";

describe("company skills cache invalidation", () => {
  it("isolates database instances and invalidates failed writes in finally", async () => {
    const db = {} as Db;
    const other = {} as Db;
    const cache = companySkillsCache(db);
    expect(companySkillsCache(other)).not.toBe(cache);
    await cache.get("a", "k", async () => []);
    const failedWrite = invalidateSkillListOnMutation(db, async (companyId: string, reason: string) => {
      expect(companyId).toBe("a");
      expect(await cache.get("a", "k", async () => [reason] as any)).toEqual([reason]);
      throw new Error(reason);
    });
    await expect(failedWrite("a", "partial")).rejects.toThrow("partial");
    expect(await cache.get("a", "k", async () => ["fresh"] as any)).toEqual(["fresh"]);
  });
});
