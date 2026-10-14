// Real independent controller process; no adapter/DB mocks.
import express from "express";
import { createDb, agents, companies, companyMemberships, heartbeatRuns, issues, issueComments, authUsers } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { heartbeatService } from "../../services/heartbeat.js";
import { healthRoutes } from "../../routes/health.js";
import { beginControllerDrain } from "../../controller-drain.js";
import { completeControllerTurnsForShutdown } from "../../shutdown.js";
import { legacyControllerBootId } from "../../services/legacy-controller-lease.js";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { registerServerAdapter } from "../../adapters/index.js";
import { createServerAdapter } from "/tmp/omnigent/src/server/index.ts";
registerServerAdapter(createServerAdapter());
const db = createDb(process.env.DATABASE_URL!, { connectTimeoutSeconds: 2 });
const heartbeat = heartbeatService(db);
setInterval(()=>{void heartbeat.reapOrphanedRuns({staleThresholdMs:0}).catch(console.error);},1000);
const app = express();
app.use(express.json());
app.use("/api/health", healthRoutes(db));

app.post("/resume", async (_req, res) => { await heartbeat.resumeQueuedRuns(); res.json({ boot: legacyControllerBootId }); });
app.post("/settled",async(_req,res)=>{await heartbeat.drainActiveRunExecutions();res.json({settled:true});});
app.post("/reap", async (_req, res) => { res.json(await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })); });

app.post("/shutdown", async (req, res) => {
  beginControllerDrain(Date.now(), req.body.graceMs ?? 120000);
  const result = await completeControllerTurnsForShutdown({signal: "SIGTERM", waitForSchedulerIdle: async () => {},
    drain: () => heartbeat.drainActiveRunExecutions(), checkpoint: () => heartbeat.checkpointOmnigentRunsForShutdown(), log: console});
  res.json({ result });
});
app.get("/runs", async (_req, res) => { res.json(await db.select().from(heartbeatRuns)); });
app.get("/boot", (_req, res) => res.json({ boot: legacyControllerBootId }));
app.post("/clear", async (_req, res) => { await db.execute(sql`truncate table companies cascade`); res.json({ cleared: true }); });
app.post("/seed-omni", async (req, res) => {
  const companyId = crypto.randomUUID(), agentId = crypto.randomUUID(), issueId = crypto.randomUUID(), userId = "fixture-"+crypto.randomUUID();
  await db.insert(authUsers).values({id:userId,name:"Fixture owner",email:userId+"@fixture.invalid",emailVerified:true,createdAt:new Date(),updatedAt:new Date()});
  await db.insert(companies).values({ id: companyId, name: "PER282 isolated Omni", defaultResponsibleUserId: userId, issuePrefix: "O"+companyId.slice(0,7), requireBoardApprovalForNewAgents: false });
  await db.insert(companyMemberships).values({companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active"});
  await db.insert(agents).values({id:agentId, companyId, name:"Omni canary", role:"general", status:"idle", adapterType:"omnigent",
    adapterConfig:{ baseUrl:process.env.OMNI_URL, agentId:"isolated-provider", pollMs:100, timeoutSec:0, paperclipApiUrl: "http://127.0.0.1:3210" },
    runtimeConfig:{heartbeat:{enabled:true,intervalSec:0,maxConcurrentRuns:1}} });
  await db.insert(issues).values({id:issueId,companyId,title:"Isolated long turn",status:"todo", assigneeAgentId:agentId,responsibleUserId:userId});
  const [run] = await db.insert(heartbeatRuns).values({companyId,agentId,responsibleUserId:userId,
    contextSnapshot:{issueId,taskTitle:"Isolated long turn",source:"controller_canary",prompt:"Complete one harmless long turn."}}).returning();
  await db.update(issues).set({executionRunId:run.id,checkoutRunId:run.id,executionLockedAt:new Date()}).where(eq(issues.id,issueId));
  res.json({companyId,agentId,issueId,runId:run.id});
});
app.get("/comments/:issueId", async (req,res) => res.json(await db.select().from(issueComments).where(eq(issueComments.issueId,req.params.issueId))));
// Exact production auth and API routers, not fixture /runs proof.
app.use(actorMiddleware(db,{deploymentMode:"local_trusted"}));
app.use("/api",agentRoutes(db));
app.use("/api",issueRoutes(db,{} as any));
app.use((err:any,_req:any,_res:any,next:any)=>{console.error(err);next(err);});
app.use(errorHandler);
app.listen(3210, "0.0.0.0", () => console.log("controller fixture ready",legacyControllerBootId));
