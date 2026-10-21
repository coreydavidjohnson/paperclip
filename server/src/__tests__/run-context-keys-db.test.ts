import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
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
it("has a compact projection without rewriting heartbeat_runs", async () => {
 const rows = await db.execute(sql`select to_regclass('heartbeat_run_list_context')::text as name`);
 expect(rows[0].name).toBe("heartbeat_run_list_context");
});
it("preserves JSON types, missing values, transaction rollback and tenant fallback", async () => {
 const { compactRunContext } = await import("../services/run-history-query.js");
 const companyId=randomUUID(), agentId=randomUUID(), other=randomUUID();
 await db.insert(companies).values([{id:companyId,name:"Projection",issuePrefix:"P"+companyId.slice(0,7)},{id:other,name:"Other",issuePrefix:"O"+other.slice(0,7)}]);
 await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
 const id=randomUUID();
 await db.insert(heartbeatRuns).values({id,companyId,agentId});
 const values=[null, [], "scalar", 42, true, {}, {issueId:null,taskId:"fallback"}, {issueId:"",taskId:123,taskKey:false,commentId:{b:2,a:1},wakeCommentId:[1,"x"],wakeCommentIds:["a","b"],wakeReason:null,wakeSource:"コメント",wakeTriggerDetail:"detail",failureRetriesBeforeAiConnectionWait:2,failureRetriesBeforeWorkspaceWait:3,secret:"never-copy",prompt:"x".repeat(100000)}];
 for(const value of values) {
  await db.execute(sql`update heartbeat_runs set context_snapshot=${JSON.stringify(value)}::jsonb where id=${id}`);
  const row=(await db.execute(sql`select c.context, h.context_snapshot from heartbeat_runs h join heartbeat_run_list_context c on c.run_id=h.id and c.company_id=h.company_id where h.id=${id}`))[0];
  const original = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const expected=Object.fromEntries(Object.entries(original).filter(([key])=>!["secret","prompt"].includes(key)));
  expect(row.context).toEqual(expected);
  expect(row.context).not.toHaveProperty("secret");
  expect(row.context).not.toHaveProperty("prompt");
  const compare=(await db.select({cached:sql`${compactRunContext}->>'issueId'`,old:sql`${heartbeatRuns.contextSnapshot}->>'issueId'`}).from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${id}`))[0];
  expect(compare.cached).toEqual(compare.old);
 }
 const before=(await db.execute(sql`select xmin::text from heartbeat_run_list_context where run_id=${id}`))[0];
 await db.execute(sql`update heartbeat_runs set status='succeeded' where id=${id}`);
 expect((await db.execute(sql`select xmin::text from heartbeat_run_list_context where run_id=${id}`))[0]).toEqual(before);
 await expect(db.$client.begin(async tx=>{await tx.unsafe(`update heartbeat_runs set context_snapshot='{"issueId":"rolled-back"}' where id='${id}'`);throw new Error("rollback");})).rejects.toThrow("rollback");
 expect((await db.execute(sql`select context->>'issueId' as issue from heartbeat_run_list_context where run_id=${id}`))[0].issue).toBe("");
 // A mismatched projection is not a company grant; the authoritative row wins.
 await db.execute(sql`update heartbeat_run_list_context set company_id=${other},context='{"issueId":"wrong-company"}' where run_id=${id}`);
 expect((await db.select({v:sql`${compactRunContext}->>'issueId'`}).from(heartbeatRuns).where(sql`${heartbeatRuns.id}=${id}`))[0].v).toBe("");
 await db.execute(sql`delete from heartbeat_runs where id=${id}`);
 expect((await db.execute(sql`select run_id from heartbeat_run_list_context where run_id=${id}`))).toHaveLength(0);
});
it("backfills with the PK cursor, without overwriting a newer trigger result", async () => {
 const companyId=randomUUID(),agentId=randomUUID();
 await db.insert(companies).values({id:companyId,name:"Backfill",issuePrefix:"B"+companyId.slice(0,7)});
 await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
 const ids=Array.from({length:215},()=>randomUUID());
 await db.insert(heartbeatRuns).values(ids.map(id=>({id,companyId,agentId,contextSnapshot:{issueId:id,prompt:"not-copied"}})));
 await db.execute(sql`delete from heartbeat_run_list_context where company_id=${companyId}`);
 await db.execute(sql`update heartbeat_runs set context_snapshot='{"issueId":"newer"}' where id=${ids[0]}`);
 const batch=fs.readFileSync(new URL("../../../scripts/backfill-run-list-context.sql",import.meta.url),"utf8");
 let cursor="", batches=0;
 while(true) {
  const rows=await db.$client.unsafe(batch.replaceAll(":'cursor'", `'${cursor}'`));
  const next=String(Object.values(rows[0])[0]);
  if(!next)break;
  expect(next>cursor).toBe(true);cursor=next;batches++;
  if(batches>400)throw new Error("unbounded backfill");
 }
 expect(batches).toBeGreaterThanOrEqual(3);
 expect((await db.execute(sql`select count(*)::int as n from heartbeat_run_list_context where company_id=${companyId}`))[0].n).toBe(215);
 expect((await db.execute(sql`select context->>'issueId' as issue from heartbeat_run_list_context where run_id=${ids[0]}`))[0].issue).toBe("newer");
 expect((await db.execute(sql`select count(*)::int as n from heartbeat_run_list_context where context ? 'prompt'`))[0].n).toBe(0);
});
it("does not reproject retained snapshots on a repeated backfill", async () => {
 const companyId=randomUUID(),agentId=randomUUID();
 await db.insert(companies).values({id:companyId,name:"Repeat",issuePrefix:"R"+companyId.slice(0,7)});
 await db.insert(agents).values({id:agentId,companyId,name:"Worker",role:"engineer"});
 await db.insert(heartbeatRuns).values({companyId,agentId,contextSnapshot:{issueId:"already-copied",prompt:"x".repeat(100000)}});
 const batch=fs.readFileSync(new URL("../../../scripts/backfill-run-list-context.sql",import.meta.url),"utf8");
 // A repeat pass must not invoke the projection (and detoast a retained blob)
 // for rows already copied. Roll back the deliberately rejecting test function.
 await expect(db.$client.begin(async tx=>{
  await tx.unsafe(`create or replace function public.project_heartbeat_run_list_context(snapshot jsonb)
    returns jsonb language plpgsql immutable parallel safe as $$
    begin raise exception 'existing snapshot reprojected'; end; $$`);
  let cursor="";
  while(true) {
   const rows=await tx.unsafe(batch.replaceAll(":'cursor'", `'${cursor}'`));
   const next=String(Object.values(rows[0])[0]);
   if(!next)break;
   expect(next>cursor).toBe(true);cursor=next;
  }
  throw new Error("rollback repeat-pass test");
 })).rejects.toThrow("rollback repeat-pass test");
});
it.skipIf(process.env.PAPERCLIP_PROJECTION_SCALE !== "1")("installs without a production-sized heap/TOAST rewrite and compares complete context projections", async () => {
 const companyId=randomUUID(),agentId=randomUUID();
 await db.insert(companies).values({id:companyId,name:"Synthetic scale",issuePrefix:"S"+companyId.slice(0,7)});
 await db.insert(agents).values({id:agentId,companyId,name:"Synthetic",role:"engineer"});
 await db.execute(sql`drop trigger heartbeat_run_list_context_sync on heartbeat_runs`);
 await db.execute(sql`drop table heartbeat_run_list_context`);
 await db.execute(sql`drop function sync_heartbeat_run_list_context()`);
 await db.execute(sql`drop function project_heartbeat_run_list_context(jsonb)`);
 const workers=Array.from({length:24},()=>randomUUID());
 await db.insert(agents).values(workers.map(id=>({id,companyId,name:"Scale background",role:"engineer"})));
 await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,context_snapshot)
   select gen_random_uuid(),${companyId},(${"{"+workers.join(",")+"}"}::uuid[])[(i%24)+1],jsonb_build_object('issueId',i::text,'wakeReason','test','prompt',
     (select string_agg(md5((i*650+j)::text),'') from generate_series(1,650) j)) from generate_series(1,29000) i`);
 // Non-empty attention result and suppression workload, with deployed probe indexes.
 const samples=await db.execute(sql`select distinct on(agent_id) id,agent_id,context_snapshot->>'issueId' as issue from heartbeat_runs where company_id=${companyId} order by agent_id,id limit 24`);
 for(let i=0;i<samples.length;i++) {
  const sample=samples[i],key="scale-"+i;
  const context=i%4===0?{issueId:key}:i%4===1?{issueId:null,taskId:key}:i%4===2?{taskId:key}:{};
  await db.execute(sql`update heartbeat_runs set status='failed',created_at=now()-interval '1 day',context_snapshot=context_snapshot || ${JSON.stringify(context)}::jsonb where id=${sample.id}`);
  if(i%4>=2) await db.execute(sql`update heartbeat_runs set context_snapshot=context_snapshot-'issueId' where id=${sample.id}`);
  // Each candidate uses its own agent, so empty-key suppression cannot leak between cases.
  const worker=String(sample.agent_id);
  await db.insert(heartbeatRunEvents).values({companyId,agentId:worker,runId:String(sample.id),seq:1,eventType:"lifecycle",message:"Bounded retry exhausted scale"});
  const newer=i<12?(i%4===1?{taskId:key}:context):{issueId:"different"};
  await db.insert(heartbeatRuns).values({companyId,agentId:worker,status:"succeeded",contextSnapshot:newer});
 }
 await db.execute(sql`create index scale_issue_probe on heartbeat_runs(company_id,agent_id,(context_snapshot->>'issueId'),created_at desc)`);
 await db.execute(sql`create index scale_task_probe on heartbeat_runs(company_id,agent_id,(context_snapshot->>'taskId'),created_at desc)`);
 await db.execute(sql`analyze heartbeat_runs`);
 const physical=()=>db.execute(sql`select h.relfilenode as heap,t.relfilenode as toast,
   pg_total_relation_size(h.oid)::text as bytes from pg_class h join pg_class t on t.oid=h.reltoastrelid where h.oid='heartbeat_runs'::regclass`);
 const before=(await physical())[0];
 expect(Number(before.bytes)).toBeGreaterThan(424*1024*1024);
 const migration=fs.readFileSync(new URL("../../../packages/db/src/migrations/0294_run_list_context.sql",import.meta.url),"utf8");
 const writer=await db.$client.reserve(), reader=await db.$client.reserve();
 try {
  await writer.unsafe("begin");
  await writer.unsafe("update heartbeat_runs set status=status where id='"+samples[0].id+"'");
  await expect(db.$client.begin(async tx=>{
   await tx.unsafe("set local lock_timeout='100ms'");
   // exact DDL itself sets a 2s local lock budget
   await tx.unsafe(migration);
  })).rejects.toHaveProperty("code","55P03");
  expect((await writer.unsafe("select 1 as ok"))[0].ok).toBe(1);
  expect((await db.execute(sql`select to_regclass('heartbeat_run_list_context')::text as name`))[0].name).toBe(null);
  await writer.unsafe("commit");
  await reader.unsafe("begin");
  await reader.unsafe("select id from heartbeat_runs limit 1");
  const started=performance.now();
  await db.$client.begin(async tx=>{
   await tx.unsafe("set local statement_timeout='10s';set local lock_timeout='2s'");
   await tx.unsafe(migration);
  });
  var migrationMs=performance.now()-started;
  expect(migrationMs).toBeLessThan(10000);
  expect(await physical()).toEqual([before]);
 } finally {
  await writer.unsafe("rollback");writer.release();
  await reader.unsafe("rollback");reader.release();
 }
 const walBefore=(await db.execute(sql`select pg_current_wal_insert_lsn()::text as lsn`))[0].lsn;
 const batch=fs.readFileSync(new URL("../../../scripts/backfill-run-list-context.sql",import.meta.url),"utf8");
 let cursor="",batches=0,maxBatchMs=0;
 const backfillAt=performance.now();
 while(true) {
   const at=performance.now();
   const rows=await db.$client.begin(async tx=>{
     await tx.unsafe("set local statement_timeout='5s';set local lock_timeout='100ms'");
     return tx.unsafe(batch.replaceAll(":'cursor'", `'${cursor}'`));
   });
   maxBatchMs=Math.max(maxBatchMs,performance.now()-at);
   const next=String(Object.values(rows[0])[0]);if(!next)break;
   expect(next>cursor).toBe(true);cursor=next;
   if(++batches>400)throw new Error("unbounded synthetic backfill");
 }
 const backfillMs=performance.now()-backfillAt;
 expect(maxBatchMs).toBeLessThan(5000);
 const walBytes=Number((await db.execute(sql`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${walBefore}::pg_lsn)::text as bytes`))[0].bytes);
 expect(walBytes).toBeLessThan(128*1024*1024);
 await db.execute(sql`analyze heartbeat_run_list_context`);
 expect(await physical()).toEqual([before]);
 expect((await db.execute(sql`select count(*)::int as n from heartbeat_runs h left join heartbeat_run_list_context c on c.run_id=h.id and c.company_id=h.company_id where c.run_id is null`))[0].n).toBe(0);
 const {runListContextColumns,runListContextJoin}=await import("../services/run-history-query.js");
 const legacy=await import("./helpers/legacy-run-history-query.js");
 const order=sql`${heartbeatRuns.createdAt} desc,${heartbeatRuns.id} desc`;
 const condition=sql`${heartbeatRuns.companyId}=${companyId}`;
 const oldQuery=db.select({id:heartbeatRuns.id,...legacy.runListContextColumns}).from(heartbeatRuns).leftJoin(legacy.runListContextJoin,sql`true`).where(condition).orderBy(order).limit(200);
 const newQuery=db.select({id:heartbeatRuns.id,...runListContextColumns}).from(heartbeatRuns).leftJoin(runListContextJoin,sql`true`).where(condition).orderBy(order).limit(200);
 const original=await oldQuery;
 expect(original).toHaveLength(200);
 expect(await newQuery).toEqual(original);
 const plans=[];
 for(let i=0;i<3;i++) {
  const oldPlan=await db.execute(sql`explain(analyze,buffers,format json) ${oldQuery.getSQL()}`);
  const newPlan=await db.execute(sql`explain(analyze,buffers,format json) ${newQuery.getSQL()}`);
  const beforePlan=(oldPlan[0]["QUERY PLAN"] as Array<{Plan:Record<string,number>}>)[0];
  const afterPlan=(newPlan[0]["QUERY PLAN"] as Array<{Plan:Record<string,number>}>)[0];
  const blocks=(p:Record<string,number>)=>(p["Shared Hit Blocks"]??0)+(p["Shared Read Blocks"]??0);
  expect(blocks(afterPlan.Plan)).toBeLessThanOrEqual(blocks(beforePlan.Plan));
  plans.push({old:oldPlan[0]["QUERY PLAN"],candidate:newPlan[0]["QUERY PLAN"]});
 }
 const {listAttentionExhaustedRuns}=await import("../services/attention-exhausted-runs.js");
 const {legacyAttentionExhaustedRuns}=await import("./helpers/legacy-attention-history.js");
 const oldAttention=legacyAttentionExhaustedRuns(db,companyId),newAttention=listAttentionExhaustedRuns(db,companyId);
 const attentionRows=await oldAttention;
 expect(attentionRows).toHaveLength(12);
 expect(await newAttention).toEqual(attentionRows);
 const attentionPlans=[];
 for(let i=0;i<3;i++) {
  const oldPlan=await db.execute(sql`explain(analyze,buffers,format json) ${oldAttention.getSQL()}`);
  const newPlan=await db.execute(sql`explain(analyze,buffers,format json) ${newAttention.getSQL()}`);
  const oldRoot=(oldPlan[0]["QUERY PLAN"] as Array<{Plan:Record<string,number>}>)[0].Plan;
  const newRoot=(newPlan[0]["QUERY PLAN"] as Array<{Plan:Record<string,number>}>)[0].Plan;
  const blocks=(p:Record<string,number>)=>(p["Shared Hit Blocks"]??0)+(p["Shared Read Blocks"]??0);
  expect(blocks(newRoot)).toBeLessThanOrEqual(blocks(oldRoot));
  const nodes:Array<Record<string,any>>=[];
  const visit=(node:Record<string,any>)=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};
  visit(newRoot);
  const probes=nodes.filter(n=>String(n.Alias??"").startsWith("newer"));
  expect(probes.length).toBeGreaterThanOrEqual(3);
  expect(probes.every(n=>n["Node Type"]!=="Seq Scan")).toBe(true);
  expect(probes.every(n=>String(n["Index Cond"]??"").includes("context_snapshot"))).toBe(true);
  attentionPlans.push({old:oldPlan[0]["QUERY PLAN"],candidate:newPlan[0]["QUERY PLAN"]});
 }
 const result={old_rows:original.length,candidate_rows:(await newQuery).length,differences:0};

 console.log("PROJECTION_SCALE_RECEIPT",JSON.stringify({before,after:(await physical())[0],rows:29000,migrationMs,backfillMs,batches,maxBatchMs,walBytes,comparison:result,query:newQuery.toSQL(),plans,attentionRows:attentionRows.length,attentionQuery:newAttention.toSQL(),attentionPlans}));
},180000);
it("yields a backfill lock wait before deadlock detection and leaves the run writer usable",async()=>{
 const companyId=randomUUID(),agentId=randomUUID(),id="00000000-0000-0000-0000-000000000001";
 await db.insert(companies).values({id:companyId,name:"Lock isolation",issuePrefix:"L"+companyId.slice(0,7)});
 await db.insert(agents).values({id:agentId,companyId,name:"Writer",role:"engineer"});
 await db.insert(heartbeatRuns).values({id,companyId,agentId});
 await db.execute(sql`delete from heartbeat_run_list_context where run_id=${id}`);
 const held=await db.$client.reserve();
 try {
  await held.unsafe("begin");
  await held.unsafe("select id from heartbeat_runs where id='"+id+"' for update");
  const batch=fs.readFileSync(new URL("../../../scripts/backfill-run-list-context.sql",import.meta.url),"utf8");
  await expect(db.$client.begin(async tx=>{
   await tx.unsafe("set local lock_timeout='100ms';set local statement_timeout='5s'");
   return tx.unsafe(batch.replaceAll(":'cursor'","''"));
  })).rejects.toHaveProperty("code","55P03");
  expect((await held.unsafe("select 1 as ok"))[0].ok).toBe(1);
  await held.unsafe("commit");
 } finally {await held.unsafe("rollback");held.release();}
 const constraints=await db.execute(sql`select confrelid::regclass::text as target from pg_constraint where conrelid='heartbeat_run_list_context'::regclass and contype='f'`);
 expect(constraints.map(r=>r.target)).toEqual(["heartbeat_runs"]);
});
