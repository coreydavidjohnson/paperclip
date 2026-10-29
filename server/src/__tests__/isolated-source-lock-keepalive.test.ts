import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock } from "../services/isolated-remote-workspace-source.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let observer: ReturnType<typeof createDb>;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("isolated-lock-keepalive-");
  db = createDb(temporary.connectionString);
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
  await db.execute(sql`alter database ${sql.identifier(rows[0]!.name)} set idle_in_transaction_session_timeout = '1000ms'`);
  observer = createDb(temporary.connectionString);
}, 30_000);
afterAll(async () => {
  await db?.$client.end({ timeout: 0 });
  await observer?.$client.end({ timeout: 0 });
  await temporary?.cleanup();
});

it("keeps the real advisory lock past the database idle timeout and releases it once", async () => {
  const companyId = randomUUID(), issueId = randomUUID();
  const work = vi.fn(async () => {
    await setTimeout(2500);
    await expect(withIsolatedRepositorySourceLock(observer, companyId, issueId, async () => "contender", true))
      .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
    return "prepared";
  });
  try {
    await expect(withIsolatedRepositorySourceLock(db, companyId, issueId, work)).resolves.toBe("prepared");
  } finally {
    await Promise.allSettled(work.mock.results.map(result => result.value));
  }
  expect(work).toHaveBeenCalledOnce();
  await expect(withIsolatedRepositorySourceLock(observer, companyId, issueId, async () => "released", true)).resolves.toBe("released");
}, 15_000);
