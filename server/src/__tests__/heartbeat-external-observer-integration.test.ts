import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
const { execute, observe, probe } = vi.hoisted(() => ({ execute: vi.fn(), observe: vi.fn(), probe: vi.fn() }));
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(), getServerAdapter: vi.fn(() => ({ type: "test_external", execute, observeRun: observe, probeRun: probe })) }));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("external heartbeat observer integration", () => {
 let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, heartbeat: ReturnType<typeof heartbeatService>;
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("external-observer-"); db = createDb(temp.connectionString); heartbeat = heartbeatService(db); }, 120000);
 afterAll(async () => { await heartbeat?.drainActiveRunExecutions(); await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
 async function fixture() {
  execute.mockClear(); observe.mockClear(); probe.mockClear();
  const [company] = await db.insert(companies).values({ name: "Observer", issuePrefix: crypto.randomUUID().slice(0, 8) }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Observer", adapterType: "test_external", status: "running" }).returning();
  return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, runtimeMode: "legacy", status: "running", runnerProfileJson: { externalObservation: { adapterType: "test_external", config: {} } }, startedAt: new Date(Date.now()-3600000), externalRunHandle: { sessionId: "existing", turnRef: "turn", dispatch: "accepted" } }).returning())[0];
 }
 const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,id)).then(rows => rows[0]!);
 it("observes stored handle without execute and uses normal completion", async () => {
  const run = await fixture(); probe.mockResolvedValue({ state: "active" });
  observe.mockImplementationOnce(async ctx => { expect(ctx.handle).toEqual(run.externalRunHandle); expect(ctx.runId).toBe(run.id); await ctx.onLog("stdout","Finished existing work"); await ctx.onHandle({ ...ctx.handle, dispatch: "observed" }); return { exitCode: 0, signal: null, timedOut: false, sessionId: "existing", resultJson: { finalResponse: "Finished" } }; });
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled(); expect(observe).toHaveBeenCalledOnce(); expect(await read(run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "existing", observerEpoch: 2 });
 });
 it("harvests settled results without observe or execute", async () => {
  const run = await fixture(); probe.mockResolvedValue({ state: "settled", result: { exitCode: 0, signal: null, timedOut: false, sessionId: "harvested", resultJson: { finalResponse: "Finished" } } });
  await heartbeat.sweepExternalRunLiveness(); await heartbeat.drainActiveRunExecutions();
  expect(execute).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(await read(run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "harvested", observerEpoch: 1 });
 });
 it("does not reap remote handles as process_lost", async () => { const run = await fixture(); await heartbeat.reapOrphanedRuns(); expect(await read(run.id)).toMatchObject({ status: "running", errorCode: null }); });
});
