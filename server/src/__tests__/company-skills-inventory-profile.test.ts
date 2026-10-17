import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createDb, companies, companySkills, agents } from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

it("profiles a disposable skills inventory without the route result cache", async () => {
  const database = await startEmbeddedPostgresTestDatabase("per959-profile-");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "per959-home-"));
  const previousHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = home;
  const db = createDb(database.connectionString);
  const companyId = randomUUID();
  try {
    await db.insert(companies).values({ id: companyId, name: "Disposable inventory profile", issuePrefix: "PROF" });
    for (let n = 0; n < 20; n++) {
      const sourceLocator = path.join(home, `local-${n}`);
      await fs.mkdir(path.join(sourceLocator, "references"), { recursive: true });
      await fs.writeFile(path.join(sourceLocator, "SKILL.md"), "# Local fixture");
      await Promise.all(Array.from({ length: 100 }, (_, f) => fs.writeFile(path.join(sourceLocator, "references", `${f}.md`), "Representative supporting content.".repeat(40))));
      await db.insert(companySkills).values({ companyId, key: `company/${companyId}/local-${n}`, slug: `local-${n}`, name: `Local ${n}`, markdown: "# Local fixture", sourceType: "local_path", sourceLocator, trustLevel: "markdown_only", compatibility: "compatible", fileInventory: [{ path: "SKILL.md", kind: "skill" }] });
    }
    for (let n = 0; n < 40; n++) await db.insert(agents).values({ companyId, name: `Fixture agent ${n}`, role: "engineer", adapterType: "claude_local", adapterConfig: {} });
    for (let round = 0; round < 6; round++) {
      const start = performance.now();
      const rows = await companySkillService(db).list(companyId);
      console.info("PER959_LIST", JSON.stringify({ round, totalMs: performance.now() - start, skills: rows.length, localSkills: 20, supportingFilesPerLocalSkill: 100, agents: 40 }));
      expect(rows.filter(row => row.sourceType === "local_path" && row.key.startsWith(`company/${companyId}/`))).toHaveLength(20);
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  }
}, 120_000);
