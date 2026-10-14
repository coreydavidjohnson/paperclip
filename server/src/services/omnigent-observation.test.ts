import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { loadOwnedOmnigentObservation, finalizeOwnedOmnigentObservation } from "./omnigent-attachment.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("admitted OmniGenT observation is not dispatch authority", () => {
 let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("omnigent-observation-"); db = createDb(database.connectionString); }, 30000);
 afterAll(async () => { await database?.cleanup(); });
 async function seed() {
  const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), id=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Observer",issuePrefix:"O"+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:"Observer",role:"general",adapterType:"omnigent"});
  await db.insert(issues).values({id:issueId,companyId,title:"Already admitted",status:"done",assigneeAgentId:agentId});
  const receipt={version:1,runId:id,companyId,agentId,omnigentSessionId:"session",state:"observed",userItemId:"user",activeResponseId:"response",turnId:"turn"};
  const [run]=await db.insert(heartbeatRuns).values({id,companyId,agentId,status:"running",runtimeMode:"legacy",controllerBootId:legacyControllerBootId,controllerLeaseExpiresAt:sql`clock_timestamp() + interval '60 seconds'`,runnerProfileJson:{adapterDispatch:{adapterType:"omnigent"}},contextSnapshot:{issueId,executionContinuation:{callerProvided:true}},resultJson:{omnigentDispatchReceipt:receipt}}).returning();
  return {run,issueId,receipt};
 }
 it("observes the exact done-task receipt without granting a new continuation", async () => {
  const {run,issueId,receipt}=await seed();
  expect(await loadOwnedOmnigentObservation(db,run)).toEqual(receipt);
  await expect(buildExecutionContinuation({db,companyId:run.companyId,issueId,agentId:run.agentId,runId:run.id,context:run.contextSnapshot!,summary:null,exposeLowTrustRaw:false})).rejects.toThrow("continuation_task_ownership_changed");
 });
 it.each(["cancelled","reassigned","expired","foreign-boot","wrong-run","wrong-company","wrong-agent","wrong-session","stopped","caller-only"])("fails closed for %s", async kind => {
  const {run,issueId,receipt}=await seed();
  if(kind==="cancelled") await db.update(issues).set({status:"cancelled"}).where(eq(issues.id,issueId));
  else if(kind==="reassigned") await db.update(issues).set({assigneeAgentId:null}).where(eq(issues.id,issueId));
  else if(kind==="expired") await db.update(heartbeatRuns).set({controllerLeaseExpiresAt:sql`clock_timestamp() - interval '1 second'`}).where(eq(heartbeatRuns.id,run.id));
  else if(kind==="foreign-boot") await db.update(heartbeatRuns).set({controllerBootId:randomUUID()}).where(eq(heartbeatRuns.id,run.id));
  else if(kind==="stopped") await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,run.id));
  else { const bad={...receipt,...(kind==="wrong-run"?{runId:randomUUID()}:kind==="wrong-company"?{companyId:randomUUID()}:kind==="wrong-agent"?{agentId:randomUUID()}:kind==="wrong-session"?{omnigentSessionId:""}:{})}; await db.update(heartbeatRuns).set({resultJson:kind==="caller-only"?{}:{omnigentDispatchReceipt:bad},contextSnapshot:{issueId,omnigentDispatchReceipt:receipt}}).where(eq(heartbeatRuns.id,run.id)); }
  expect(await loadOwnedOmnigentObservation(db,run)).toBeNull();
  expect(await finalizeOwnedOmnigentObservation(db,run,receipt,"succeeded",{finishedAt:new Date()})).toBeNull();
 });
});
