import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async()=>{fixture=await startEmbeddedPostgresTestDatabase("context-keys-");db=createDb(fixture.connectionString);},90000);
afterAll(async()=>{await db?.$client.end({timeout:0});await fixture?.cleanup();});
it("uses original JSON keys without an exclusive table rewrite",async()=>{
 const companyId=randomUUID(),agentId=randomUUID();
 await db.insert(companies).values({id:companyId,name:"Keys",issuePrefix:"K"+companyId.slice(0,7)});
 await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
 const columns=await db.execute(sql`select column_name from information_schema.columns where table_name='heartbeat_runs' and column_name in ('context_issue_id','context_task_id')`);
 expect(columns.length).toBe(0);
 expect(fs.existsSync(new URL("../../../packages/db/src/migrations/0294_run_context_keys.sql", import.meta.url))).toBe(false);
 for(const context of [{issueId:"",taskId:"fallback"},{issueId:null,taskId:42},{issueId:{a:1},taskId:[1,2]},{}]) {
  const id=randomUUID();
  await db.insert(heartbeatRuns).values({id,companyId,agentId,contextSnapshot:{...context,prompt:"x".repeat(100000)}});
  const check=async()=>{
   const rows=await db.execute(sql`select context_snapshot->>'issueId' as issue_key,context_snapshot->>'taskId' as task_key from heartbeat_runs where id=${id}`);
   expect(rows).toHaveLength(1);
   expect(rows[0]).toHaveProperty("issue_key");
   expect(rows[0]).toHaveProperty("task_key");
  };
  await check();
  await db.execute(sql`update heartbeat_runs set context_snapshot='{"issueId":"changed","taskId":null}'::jsonb where id=${id}`);
  await check();
 }
});
