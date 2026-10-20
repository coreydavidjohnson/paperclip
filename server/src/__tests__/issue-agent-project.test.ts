import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
describeDb("agent project defaults", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), otherCompany = randomUUID();
  const agentId = randomUUID(), otherAgent = randomUUID(), plainAgent = randomUUID();
  const projectId = randomUUID(), otherProject = randomUUID(), explicitProject = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-project-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Main", issuePrefix: "DEF", defaultResponsibleUserId: "board-user" },
      { id: otherCompany, name: "Other", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Home Lab", role: "engineer", adapterType: "process", runtimeConfig: { defaultIssueProjectId: projectId } },
      { id: otherAgent, companyId, name: "Personal", role: "engineer", adapterType: "process", runtimeConfig: { defaultIssueProjectId: otherProject } },
      { id: plainAgent, companyId, name: "No default", role: "engineer", adapterType: "process" },
    ]);
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Home Lab", leadAgentId: agentId },
      { id: otherProject, companyId, name: "Personal", leadAgentId: otherAgent },
      { id: explicitProject, companyId, name: "Tests" },
    ]);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  it("defaults root tasks to the assigned agent project", async () => {
    const task = await issueService(db).create(companyId, { title: "New root", assigneeAgentId: agentId });
    expect(task.projectId).toBe(projectId);
  });
  it("uses the child assignee default instead of a different agent parent project", async () => {
    const parent = await issueService(db).create(companyId, { title: "Parent", projectId: otherProject, assigneeAgentId: otherAgent });
    const task = await issueService(db).create(companyId, { title: "Child", parentId: parent.id, assigneeAgentId: agentId });
    expect(task.projectId).toBe(projectId);
  });
  it("preserves an explicit project on create and subsequent updates", async () => {
    const service = issueService(db);
    const task = await service.create(companyId, { title: "Explicit", projectId: explicitProject, assigneeAgentId: agentId });
    expect(task.projectId).toBe(explicitProject);
    expect((await service.update(task.id, { title: "Edited" }))?.projectId).toBe(explicitProject);
  });
  it("defaults an unprojected task when it is assigned later", async () => {
    const service = issueService(db);
    const task = await service.create(companyId, { title: "Unassigned" });
    expect(task.projectId).toBeNull();
    expect((await service.update(task.id, { assigneeAgentId: agentId }))?.projectId).toBe(projectId);
  });
  it("does not invent defaults for an unconfigured agent", async () => {
    const task = await issueService(db).create(companyId, { title: "No config", assigneeAgentId: plainAgent });
    expect(task.projectId).toBeNull();
  });
});
