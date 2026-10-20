import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";
describe("bounded failure history", () => {
 let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 beforeAll(async()=>{fixture=await startEmbeddedPostgresTestDatabase("attention-history-");db=createDb(fixture.connectionString);},90000);
 afterAll(async()=>{await db?.$client.end({timeout:0});await fixture?.cleanup();});
 it("does not return an exhausted failure superseded by a newer same-company issue-agent run",async()=>{
  const companyId=randomUUID(),agentId=randomUUID(),id=randomUUID(),issueId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"A",issuePrefix:"A"+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
  await db.insert(heartbeatRuns).values([{id,companyId,agentId,status:"failed",contextSnapshot:{issueId},createdAt:new Date(1700000000000)},{companyId,agentId,status:"succeeded",contextSnapshot:{issueId},createdAt:new Date(1700000001000)}]);
  await db.insert(heartbeatRunEvents).values({companyId,agentId,runId:id,seq:1,eventType:"lifecycle",message:"Bounded retry exhausted test"});
  expect((await listAttentionExhaustedRuns(db,companyId)).some(row=>row.id===id)).toBe(false);
 });
});
