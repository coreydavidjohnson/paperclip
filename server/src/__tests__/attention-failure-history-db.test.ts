import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";
describe("bounded failure history", () => {
 let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 beforeAll(async()=>{fixture=await startEmbeddedPostgresTestDatabase("attention-history-");db=createDb(fixture.connectionString);},90000);
 afterAll(async()=>{await db?.$client.end({timeout:0});await fixture?.cleanup();});
 it("uses three independent newer-run anti-probes instead of one OR probe", async () => {
  const query = listAttentionExhaustedRuns(db, randomUUID());
  const statement = query.toSQL().sql;
  expect(statement.match(/not exists \(select 1 from heartbeat_runs newer/g)).toHaveLength(3);
  expect(statement.match(/newer\.company_id =/g)).toHaveLength(3);
  expect(statement.match(/newer\.agent_id =/g)).toHaveLength(3);
  expect(statement.match(/newer\.created_at >= date_trunc/g)).toHaveLength(3);
  expect(statement).not.toMatch(/or\s+\(?newer\.context_snapshot/);
  expect(await query).toEqual([]);
 });
 it("does not return an exhausted failure superseded by a newer same-company issue-agent run",async()=>{
  const companyId=randomUUID(),agentId=randomUUID(),id=randomUUID(),issueId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"A",issuePrefix:"A"+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
  await db.insert(heartbeatRuns).values([{id,companyId,agentId,status:"failed",contextSnapshot:{issueId},createdAt:new Date(Date.now()-86400000)},{companyId,agentId,status:"succeeded",contextSnapshot:{issueId},createdAt:new Date(Date.now()-86400000+1000)}]);
  await db.insert(heartbeatRunEvents).values({companyId,agentId,runId:id,seq:1,eventType:"lifecycle",message:"Bounded retry exhausted test"});
  expect((await listAttentionExhaustedRuns(db,companyId)).some(row=>row.id===id)).toBe(false);
 });
 it("matches legacy suppression for fallbacks, JSON types, ties and companies", async () => {
  const companyId=randomUUID(),otherCompany=randomUUID(),otherAgent=randomUUID();
  await db.insert(companies).values([{id:companyId,name:"Types",issuePrefix:"T"+companyId.slice(0,7)},{id:otherCompany,name:"Other",issuePrefix:"O"+otherCompany.slice(0,7)}]);
  await db.insert(agents).values({id:otherAgent,companyId:otherCompany,name:"Other",role:"engineer"});
  const pairs: Array<[Record<string, unknown>,Record<string, unknown>,number,boolean]> = [
   [{issueId:"a"},{issueId:"a"},1,true], [{issueId:"b"},{issueId:"other"},1,false],
   [{taskId:"c"},{issueId:"c"},1,true], [{issueId:null,taskId:"d"},{taskId:"d"},1,true],
   [{issueId:"",taskId:"e"},{taskId:"e"},1,false], [{issueId:"f"},{issueId:"f"},0,false],
   [{issueId:"g"},{issueId:"g"},-1,false], [{issueId:42},{},1,true],
   [{issueId:"42"},{issueId:42},1,true], [{issueId:{x:1}},{issueId:{x:1}},1,false],
   [{},{issueId:""},1,true], [{issueId:"isolation"},{issueId:"isolation"},1,false],
  ];
  const expected:string[]=[];
  for (let n=0;n<pairs.length;n++) {
   const [oldContext,newContext,delta,suppressed]=pairs[n],id=randomUUID(),worker=randomUUID();
   await db.insert(agents).values({id:worker,companyId,name:"Case"+n,role:"engineer"});
   const at=Date.now()-86400000+n*10000;
   await db.insert(heartbeatRuns).values([{id,companyId,agentId:worker,status:"failed",contextSnapshot:oldContext,createdAt:new Date(at)},
    {companyId:n===11?otherCompany:companyId,agentId:n===11?otherAgent:worker,status:"succeeded",contextSnapshot:newContext,createdAt:new Date(at+delta*1000)}]);
   await db.insert(heartbeatRunEvents).values([{companyId,agentId:worker,runId:id,seq:1,eventType:"lifecycle",message:"Bounded retry exhausted fixture"},
    {companyId,agentId:worker,runId:id,seq:2,eventType:"lifecycle",message:"Bounded retry exhausted duplicate"}]);
   if(!suppressed) expected.push(id);
  }
  const rows=await listAttentionExhaustedRuns(db,companyId);
  expect(rows.map(r=>r.id).sort()).toEqual(expected.sort());
  expect(rows.every(r=>r.companyId===companyId)).toBe(true);
  expect(new Set(rows.map(r=>r.id)).size).toBe(rows.length);
 });

 it("preserves millisecond Date ties for microsecond-newer rows",async()=>{
  const companyId=randomUUID(),agentId=randomUUID(),id=randomUUID(),newer=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Precision",issuePrefix:"P"+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
  await db.insert(heartbeatRuns).values([{id,companyId,agentId,status:"failed",contextSnapshot:{issueId:"precision"}},{id:newer,companyId,agentId,status:"succeeded",contextSnapshot:{issueId:"precision"}}]);
  await db.execute(sql`update heartbeat_runs set created_at=date_trunc('day',now())+interval '0.0001 seconds' where id=${id}`);
  await db.execute(sql`update heartbeat_runs set created_at=date_trunc('day',now())+interval '0.0009 seconds' where id=${newer}`);
  await db.insert(heartbeatRunEvents).values({companyId,agentId,runId:id,seq:1,eventType:"lifecycle",message:"Bounded retry exhausted precision"});
  expect((await listAttentionExhaustedRuns(db,companyId)).map(r=>r.id)).toEqual([id]);
 });

 it("omits exhausted failures older than seven days without deleting history",async()=>{
  const companyId=randomUUID(),agentId=randomUUID(),old=randomUUID(),recent=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Age limit",issuePrefix:"D"+companyId.slice(0,7)});
  await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
  await db.insert(heartbeatRuns).values([{id:old,companyId,agentId,status:"failed",contextSnapshot:{issueId:"old"},createdAt:new Date(Date.now()-8*86400000)},{id:recent,companyId,agentId,status:"failed",contextSnapshot:{issueId:"recent"},createdAt:new Date(Date.now()-6*86400000)}]);
  await db.insert(heartbeatRunEvents).values([{companyId,agentId,runId:old,seq:1,eventType:"lifecycle",message:"Bounded retry exhausted old"},{companyId,agentId,runId:recent,seq:1,eventType:"lifecycle",message:"Bounded retry exhausted recent"}]);
  expect((await listAttentionExhaustedRuns(db,companyId)).map(r=>r.id)).toEqual([recent]);
  const preserved=await db.execute(sql`select id from heartbeat_runs where id=${old}`);expect(preserved.length).toBe(1);
 });
});
