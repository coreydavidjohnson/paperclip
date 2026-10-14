// Real independent controller process; no adapter/DB mocks.
import express from "express";
import { createDb, agents, companies, companyMemberships, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { heartbeatService, stopTaskDrain } from "../../services/heartbeat.js";
import { healthRoutes } from "../../routes/health.js";
import { beginControllerDrain } from "../../controller-drain.js";
import { completeControllerTurnsForShutdown } from "../../shutdown.js";
import { legacyControllerBootId, watchLegacyControllerLease } from "../../services/legacy-controller-lease.js";
const db = createDb(process.env.DATABASE_URL!, { connectTimeoutSeconds: 2 });
const heartbeat = heartbeatService(db);
const app = express();
app.use(express.json());
app.use("/api/health", healthRoutes(db));
app.post("/loopback-drain", async (_req, res) => { const r = await fetch("http://127.0.0.1:3210/api/health/drain", {method: "POST"}); res.status(r.status).json(await r.json()); });
app.post("/resume", async (_req, res) => { await heartbeat.resumeQueuedRuns(); res.json({ boot: legacyControllerBootId }); });
app.post("/reap", async (_req, res) => { res.json(await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })); });
app.post("/tick", async (_req, res) => { res.json(await heartbeat.tickTimers(new Date())); });
app.post("/release-task-drain", (_req, res) => { res.json(stopTaskDrain()); });
app.post("/shutdown", async (req, res) => {
  beginControllerDrain(Date.now(), req.body.graceMs ?? 120000);
  const result = await completeControllerTurnsForShutdown({signal: "SIGTERM", waitForSchedulerIdle: async () => {},
    drain: () => heartbeat.drainActiveRunExecutions(), log: console});
  res.json({ result });
});
app.post("/lease-timeout", async (_req, res) => {
  const [run] = await db.update(heartbeatRuns).set({status: "running", controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: new Date(Date.now()+700) }).returning();
  const blocker=db.transaction(async tx=>{
    await tx.execute(sql`select id from heartbeat_runs where id = ${run.id} for update`);
    await tx.execute(sql`select pg_sleep(2)`);
  });
  await new Promise(r=>setTimeout(r,100));
  const abort=new AbortController(), watch=watchLegacyControllerLease(db,run,abort);
  const started=Date.now();
  let message="";
  try {await watch.assertOwned();} catch(e) {message=String(e);}
  finally {watch.stop();}
  await blocker;
  res.json({aborted:abort.signal.aborted,message,elapsedMs:Date.now()-started});
});
app.post("/retained-omnigent", async (_req, res) => {
  const [run] = await db.select().from(heartbeatRuns).limit(1);
  await db.update(agents).set({ adapterType: "omnigent" }).where(eq(agents.id, run.agentId));
  const original = { session_id: "retained-session", response_id: "retained-response", turn_id: "retained-turn" };
  await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "legacy",
    controllerBootId: crypto.randomUUID(), controllerLeaseExpiresAt: new Date(Date.now()-1000),
    executionStage: "dispatching", resultJson: original }).where(eq(heartbeatRuns.id, run.id));
  await heartbeat.reapOrphanedRuns({staleThresholdMs: 0});
  await heartbeat.resumeQueuedRuns();
  const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  res.json({retained, original});
});
app.post("/db-loss", async (_req, res) => {
  const [run] = await db.update(heartbeatRuns).set({status: "running", runtimeMode: "legacy",
    controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now()+300) }).returning();
  const unreachable = createDb("postgres://paperclip@127.0.0.1:1/paperclip", {connectTimeoutSeconds: 1});
  const controller = new AbortController(), watch = watchLegacyControllerLease(unreachable, run, controller);
  let message=""; try { await watch.assertOwned(); } catch (err) { message=String(err); }
  await new Promise(r=>setTimeout(r,400)); watch.stop();
  res.json({aborted: controller.signal.aborted, message});
});
app.get("/runs", async (_req, res) => { res.json(await db.select().from(heartbeatRuns)); });
app.get("/boot", (_req, res) => res.json({ boot: legacyControllerBootId }));
app.post("/seed", async (req, res) => {
  const companyId = crypto.randomUUID(), agentId = crypto.randomUUID(), userId = "fixture-"+crypto.randomUUID();
  await db.insert(companies).values({ id: companyId, name: "PER282 disposable", defaultResponsibleUserId: userId, issuePrefix: "C"+companyId.slice(0,7), requireBoardApprovalForNewAgents: false });
  await db.insert(companyMemberships).values({companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active"});
  await db.insert(agents).values({ id: agentId, companyId, name: "Process turn", role: "general", adapterType: "process", status: "idle",
    adapterConfig: { command: "node", args: ["-e", "console.log('turn started'); setTimeout(()=>console.log('turn finished'),12000)"], cwd: "/tmp", timeoutSec: 30 },
    createdAt: new Date(Date.now()-120000), runtimeConfig: { heartbeat: { enabled: true, intervalSec: req.body.timer ? 60 : 0, maxConcurrentRuns: 1 } } });
  if (!req.body.timer) await db.insert(heartbeatRuns).values([1,2].map(() => ({ companyId, agentId, contextSnapshot: { source: "controller_fixture" } })));
  res.json({ companyId, agentId });
});
app.post("/clear", async (_req, res) => { await db.execute(sql`truncate table companies cascade`); res.json({ cleared: true }); });
app.listen(3210, "0.0.0.0", () => console.log("controller fixture ready",legacyControllerBootId));
