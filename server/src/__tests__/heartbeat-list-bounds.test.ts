import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { heartbeatService } from "../services/heartbeat.js";

function database() {
  const limit = vi.fn();
  const conditions: SQL[] = [];
  const query = {
    from: () => query, leftJoin: () => query,
    where: (condition: SQL) => { conditions.push(condition); return query; },
    orderBy: () => query,
    limit: (value: number) => { limit(value); return query; },
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  return { limit, conditions, db: { select: () => query,
    execute: async () => [{ server_encoding: "UTF8" }] } as unknown as Db };
}

describe("bounded heartbeat history", () => {
  it.each([undefined, NaN, Infinity, -Infinity])("defaults non-finite limit %s to 200", async limit => {
    const fake = database();
    await heartbeatService(fake.db).list("company-one", undefined, limit);
    expect(fake.limit).toHaveBeenCalledWith(200);
  });
  it.each([[0, 1], [-3, 1], [2.8, 2], [1001, 1000], [25, 25]])("clamps %s to %s", async (limit, expected) => {
    const fake = database();
    await heartbeatService(fake.db).list("company-one", "agent-one", limit);
    expect(fake.limit).toHaveBeenCalledWith(expected);
    expect(new PgDialect().sqlToQuery(fake.conditions[0]).params).toContain("agent-one");
  });
  it("scopes cursor lookup to the company and agent without selecting saved blobs", async () => {
    const fake = database();
    await heartbeatService(fake.db).list("company-one", "agent-one", 50, { before: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const sql = new PgDialect().sqlToQuery(fake.conditions[0]);
    expect(sql.sql).toContain("created_at");
    expect(sql.sql).not.toContain("context_snapshot");
    expect(sql.sql).not.toContain("result_json");
    expect(sql.params).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(sql.params.filter(x => x === "company-one")).toHaveLength(2);
    expect(sql.params.filter(x => x === "agent-one")).toHaveLength(2);
    expect(fake.limit).toHaveBeenCalledWith(50);
  });
});
