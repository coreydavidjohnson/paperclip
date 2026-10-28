import { setTimeout } from "node:timers/promises";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock } from "./isolated-remote-workspace-source.js";
import { SkillCacheBusy, withSkillVersionCacheLock } from "./skill-version-cache.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("setup advisory locks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let contender: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-setup-advisory-lock");
    db = createDb(database.connectionString);
    contender = createDb(database.connectionString);
    const [databaseRow] = await db.execute<{ name: string }>(sql`select current_database() as name`);
    await db.execute(sql`alter database ${sql.identifier(databaseRow!.name)} set idle_in_transaction_session_timeout = '200ms'`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await contender?.$client.end();
    await db?.$client.end();
    await database?.cleanup();
  });

  const cases = [
    { name: "repository source", busy: IsolatedRepositorySourceBusy,
      lock: (client: Db, action: () => Promise<void>, tryOnly = false) =>
        withIsolatedRepositorySourceLock(client, "company", "task", action, tryOnly) },
    { name: "skill cache", busy: SkillCacheBusy,
      lock: (client: Db, action: () => Promise<void>, tryOnly = false) =>
        withSkillVersionCacheLock(client, "company", action, tryOnly) },
  ];

  for (const fixture of cases) {
    it(`${fixture.name} excludes competitors across slow work without an open transaction`, async () => {
      await fixture.lock(db, async () => {
        const sessions = await db.execute<{ state: string; xact_start: Date | null }>(sql`
          select state, xact_start from pg_stat_activity
          where datname = current_database() and application_name = 'paperclip-workspace-finalization-lock'
        `);
        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions.every(session => session.state === "idle" && session.xact_start === null)).toBe(true);
        await fixture.lock(db, async () => undefined, true);
        await expect(fixture.lock(contender, async () => undefined, true)).rejects.toBeInstanceOf(fixture.busy);
        await setTimeout(450);
        await expect(fixture.lock(contender, async () => undefined, true)).rejects.toBeInstanceOf(fixture.busy);
      });
      await fixture.lock(contender, async () => undefined, true);
    });

    it(`${fixture.name} releases exclusion after a failed setup`, async () => {
      await expect(fixture.lock(db, async () => { throw new Error("setup failed"); })).rejects.toThrow("setup failed");
      await fixture.lock(contender, async () => undefined, true);
    });
  }

  it("allows ten independent ticket preparations to exceed the idle transaction timeout", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      withIsolatedRepositorySourceLock(db, "company", `task-${index}`, async () => {
        await setTimeout(450);
        await db.execute(sql`select 1`);
      })));
  });
});
