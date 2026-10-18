import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runLivenessOutbox } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { persistExternalRunHandle, recordExternalRunProgress } from "../services/heartbeat/external-run-state.js";
import { createExternalRunLivenessWorker } from "../services/heartbeat/external-run-liveness.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("external liveness real transaction fences", () => {
 let db: ReturnType<typeof createDb>; let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase("paperclip-liveness-");db=createDb(temp.connectionString);},120000);
 afterAll(async()=>{await db?.$client.end({timeout:0});await temp?.cleanup();});
 async function fixture() {
  const companyId=randomUUID(),agentId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Tests",issuePrefix:`T${companyId.slice(0,6)}`,defaultResponsibleUserId:"board-user"});
  await db.insert(agents).values({id:agentId,companyId,name:"[test] external",adapterType:"test_external",status:"running"});
  const [run]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",runtimeMode:"legacy",runnerProfileJson:{externalObservation:{adapterType:"test_external",config:{}}},startedAt:new Date(Date.now()-3600000),lastProgressAt:new Date(Date.now()-3600000),externalRunHandle:{sessionId:randomUUID(),turnRef:randomUUID(),dispatch:"accepted"},deadlineAt:new Date(Date.now()+3600000)}).returning();
  return run;
 }
 async function fresh(id:string){return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,id)))[0];}
 function worker(probeRun:()=>Promise<any>){ return createExternalRunLivenessWorker(db,{getAdapter:()=>({type:"test_external",probeRun} as any),resolveConfig:async(_company:string,config:any)=>config,onSettled:async()=>{},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}}); }
 it("authoritative gone ends once with epoch bump and outbox in one commit",async()=>{
  const run=await fixture();const w=worker(async()=>({state:"gone",reason:"deleted",authoritative:true}));
  await w.sweep();await w.sweep();const r=await fresh(run.id);
  expect(r.errorCode).toBe("external_session_gone");expect(r.status).toBe("failed");expect(r.observerEpoch).toBe(1);
  const rows=await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId,run.id));
  expect(rows.filter(r=>r.action==="stop_provider_session")).toHaveLength(1);
 });
 it("claims a new observer epoch before accepting a settled provider result",async()=>{
  const run=await fixture();let settled:any;
  const w=createExternalRunLivenessWorker(db,{getAdapter:()=>({type:"test_external",probeRun:async()=>({state:"settled",result:{exitCode:0}})} as any),resolveConfig:async(_company,config)=>config,onSettled:async(r)=>{if(r.id===run.id)settled=r;},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}});
  await w.sweep();expect(settled?.observerEpoch).toBe(run.observerEpoch+1);
 });
 it("does not settle provider results over an unexpired observer lease",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({controllerLeaseExpiresAt:new Date(Date.now()+600000)}).where(eq(heartbeatRuns.id,run.id));let settlements=0;
  const w=createExternalRunLivenessWorker(db,{getAdapter:()=>({type:"test_external",probeRun:async()=>({state:"settled",result:{exitCode:0}})} as any),resolveConfig:async(_company,config)=>config,onSettled:async(r)=>{if(r.id===run.id)settlements++;},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}});
  await w.sweep();expect(settlements).toBe(0);expect((await fresh(run.id)).status).toBe("running");
 });
 it("enforces an expired deadline without recorded configuration or an available adapter",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({runnerProfileJson:null,deadlineAt:new Date(0)}).where(eq(heartbeatRuns.id,run.id));
  const w=createExternalRunLivenessWorker(db,{getAdapter:()=>undefined,resolveConfig:async(_company,config)=>config,onSettled:async()=>{},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}});
  await w.sweep();expect((await fresh(run.id)).errorCode).toBe("external_deadline_exceeded");
 });
 it("bounds settled results when the adapter cannot harvest",async()=>{
  const run=await fixture();await worker(async()=>({state:"settled"})).sweep();expect((await fresh(run.id)).errorCode).toBe("external_result_unavailable");
 });
 it("retires a renewing observer when positive provider evidence proves its session gone",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({controllerLeaseExpiresAt:new Date(Date.now()+600000)}).where(eq(heartbeatRuns.id,run.id));
  await worker(async()=>({state:"gone",authoritative:true,reason:"garbage collected"})).sweep();
  expect((await fresh(run.id)).errorCode).toBe("external_session_gone");expect((await fresh(run.id)).observerEpoch).toBe(run.observerEpoch+1);
 });
 it("backfills the original dispatch deadline rather than extending it on restart",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({deadlineAt:null,startedAt:new Date(Date.now()-13*3600000)}).where(eq(heartbeatRuns.id,run.id));
  await worker(async()=>({state:"active"})).sweep();expect((await fresh(run.id)).errorCode).toBe("external_deadline_exceeded");
 });
 it("late gone loses to concurrent output",async()=>{
  const run=await fixture();const w=worker(async()=>{await db.update(heartbeatRuns).set({lastProgressAt:sql`clock_timestamp()`,livenessVersion:sql`${heartbeatRuns.livenessVersion}+1`}).where(eq(heartbeatRuns.id,run.id));return {state:"gone",reason:"late",authoritative:true};});
  await w.sweep(); expect((await fresh(run.id)).status).toBe("running");
 });
 it("unknown ceiling never queues a provider stop or redispatch",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({unknownSince:new Date(Date.now()-7200001)}).where(eq(heartbeatRuns.id,run.id));
  await worker(async()=>({state:"unknown",reason:"outage"})).sweep();
  expect((await fresh(run.id)).errorCode).toBe("external_liveness_unknown");
  expect(await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId,run.id))).toHaveLength(1);
 });
 it("prepared intent missing after ten minutes does not wait fifteen minutes",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({startedAt:new Date(Date.now()-610000),lastProgressAt:new Date(Date.now()-610000),externalRunHandle:{...run.externalRunHandle!,dispatch:"prepared"}}).where(eq(heartbeatRuns.id,run.id));
  await worker(async()=>({state:"gone",reason:"intent never created a session",authoritative:true})).sweep();
  expect((await fresh(run.id)).errorCode).toBe("external_session_gone");
 });
 it("crash before finalization rolls terminal status epoch and stop intent back together",async()=>{
  const run=await fixture();await expect(db.transaction(async tx=>{
   await tx.update(heartbeatRuns).set({status:"failed",observerEpoch:1,errorCode:"external_session_gone"}).where(eq(heartbeatRuns.id,run.id));
   throw new Error("crash before commit");
  })).rejects.toThrow("crash before commit");
  expect((await fresh(run.id)).status).toBe("running");
  expect(await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId,run.id))).toHaveLength(0);
 });
 it("deadline survives worker restart and queues stop without redispatch",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({deadlineAt:new Date(Date.now()-1),lastProgressAt:new Date()}).where(eq(heartbeatRuns.id,run.id));
  await worker(async()=>({state:"active"})).sweep();
  expect((await fresh(run.id)).errorCode).toBe("external_deadline_exceeded");
  const rows=await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId,run.id));
  expect(rows.some(r=>r.action==="stop_provider_session")).toBe(true);
  expect(rows.find(r=>r.action==="finalize_external_run")?.payload.redispatch).toBe(false);
 });
 it("active approval stays running without changing progress or extending the deadline",async()=>{
  const run=await fixture();await worker(async()=>({state:"active",reason:"approval pending"})).sweep();
  const r=await fresh(run.id);expect(r.status).toBe("running");expect(r.lastAliveAt).not.toBeNull();
  expect(r.lastProgressAt?.getTime()).toBe(run.lastProgressAt?.getTime());expect(r.deadlineAt?.getTime()).toBe(run.deadlineAt?.getTime());
 });
 it("only one of two controllers attaches after an active probe",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({controllerLeaseExpiresAt:new Date(Date.now()-1)}).where(eq(heartbeatRuns.id,run.id));
  let observers=0;const deps={getAdapter:()=>({type:"test_external",probeRun:async()=>({state:"active"}),observeRun:async()=>({exitCode:0})} as any),resolveConfig:async(_company:string,config:any)=>config,onSettled:async()=>{},onObserve:async(r:any)=>{if(r.id===run.id)observers++;},onTerminal:async()=>{},wake:async()=>{}};
  await Promise.all([createExternalRunLivenessWorker(db,deps).sweep(),createExternalRunLivenessWorker(db,deps).sweep()]);
  expect(observers).toBe(1);expect((await fresh(run.id)).observerEpoch).toBe(1);
 });
 it("legacy runs with no explicit handle stay with their old recovery path",async()=>{
  const run=await fixture();await db.update(heartbeatRuns).set({externalRunHandle:null}).where(eq(heartbeatRuns.id,run.id));
  await worker(async()=>({state:"gone",reason:"missing",authoritative:true})).sweep();expect((await fresh(run.id)).status).toBe("running");
 });
 it("stop outbox retries after a lost acknowledgment without repeating finalization",async()=>{
  const run=await fixture();await worker(async()=>({state:"gone",reason:"missing",authoritative:true})).sweep();
  let stops=0;const consumer=createExternalRunLivenessWorker(db,{getAdapter:()=>({type:"test_external",stopRun:async({handle}:any)=>{if(handle.sessionId!==run.externalRunHandle?.sessionId)return;stops++;if(stops===1)throw new Error("ack lost");}} as any),resolveConfig:async(_company:string,config:any)=>config,onSettled:async()=>{},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}});
  await consumer.consumeOutbox();let rows=await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId,run.id));
  expect(rows.find(r=>r.action==="stop_provider_session")?.status).toBe("pending");
  await db.update(runLivenessOutbox).set({nextAttemptAt:new Date(0)}).where(eq(runLivenessOutbox.runId,run.id));
  await consumer.consumeOutbox();await consumer.consumeOutbox();rows=await db.select().from(runLivenessOutbox).where(eq(runLivenessOutbox.runId,run.id));
  expect(stops).toBe(2);expect(rows.every(r=>r.status==="done")).toBe(true);expect((await fresh(run.id)).observerEpoch).toBe(1);
 });
 it("provider circuit breaker bounds probes across many quiet runs",async()=>{
  const runs=await Promise.all(Array.from({length:9},()=>fixture()));let calls=0;await worker(async()=>{calls++;return {state:"unknown",reason:"provider outage"};}).sweep();
  expect(calls).toBeLessThanOrEqual(8);for(const run of runs)expect((await fresh(run.id)).status).toBe("running");
 });
});

// Harvest budget is run state, not gone-confirmation evidence.
suite("external harvest recovery budget", () => {
 let db: ReturnType<typeof createDb>; let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase("paperclip-harvest-");db=createDb(temp.connectionString);},120000);
 afterAll(async()=>{await db?.$client.end({timeout:0});await temp?.cleanup();});
 it("caps unsuccessful harvests that each emit output and a refreshed handle across restarts",async()=>{
  const companyId=randomUUID(),agentId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Harvest",issuePrefix:`H${companyId.slice(0,6)}`});
  await db.insert(agents).values({id:agentId,companyId,name:"Harvest",adapterType:"test_external"});
  const [run]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",runtimeMode:"legacy",runnerProfileJson:{externalObservation:{adapterType:"test_external",config:{}}},lastProgressAt:new Date(0),externalRunHandle:{sessionId:"harvest",dispatch:"accepted"}}).returning();
  let harvests=0;
  const deps={getAdapter:()=>({type:"test_external",probeRun:async()=>({state:"settled"}),observeRun:async()=>({exitCode:0})} as any),
   resolveConfig:async(_company:string,config:any)=>config,onSettled:async()=>{},onObserve:async(r:any)=>{if(r.id!==run.id)return;harvests++;await recordExternalRunProgress(db,r);await persistExternalRunHandle(db,r,{sessionId:"harvest",turnRef:String(harvests),dispatch:"accepted"});},onTerminal:async()=>{},wake:async()=>{}};
  for(let i=0;i<4;i++){
   await db.update(heartbeatRuns).set({lastProgressAt:new Date(0),livenessClaimedUntil:null,controllerLeaseExpiresAt:new Date(0)}).where(eq(heartbeatRuns.id,run.id));
   await createExternalRunLivenessWorker(db,deps).sweep();
  }
  const [ended]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(harvests).toBe(3);expect(ended.errorCode).toBe("external_result_unavailable");
 });
 it("does not spend a harvest attempt while the current observer lease is valid",async()=>{
  const companyId=randomUUID(),agentId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Lease",issuePrefix:`L${companyId.slice(0,6)}`});
  await db.insert(agents).values({id:agentId,companyId,name:"Lease",adapterType:"test_external"});
  const [run]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",runtimeMode:"legacy",runnerProfileJson:{externalObservation:{adapterType:"test_external",config:{}}},lastProgressAt:new Date(0),controllerLeaseExpiresAt:new Date(Date.now()+600000),externalRunHandle:{sessionId:"leased",dispatch:"accepted"}}).returning();
  const w=createExternalRunLivenessWorker(db,{getAdapter:()=>({type:"test_external",probeRun:async()=>({state:"settled"}),observeRun:async()=>({exitCode:0})} as any),resolveConfig:async(_company:string,config:any)=>config,onSettled:async()=>{},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}});
  await w.sweep();const [current]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(Number(current.livenessProbe?.harvestAttempts??0)).toBe(0);
 });
 it("probes and stops with the recorded adapter and resolved config, not edited agent settings",async()=>{
  const companyId=randomUUID(),agentId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Config",issuePrefix:`C${companyId.slice(0,6)}`});
  await db.insert(agents).values({id:agentId,companyId,name:"Config",adapterType:"new_adapter",adapterConfig:{baseUrl:"new-endpoint"}});
  const saved={baseUrl:"admitted-endpoint",env:{TOKEN:{type:"secret_ref",secretId:randomUUID()}}};
  const [run]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",runtimeMode:"legacy",lastProgressAt:new Date(0),runnerProfileJson:{externalObservation:{adapterType:"admitted_adapter",config:saved}},externalRunHandle:{sessionId:"recorded",dispatch:"accepted"}}).returning();
  const calls:string[]=[];const resolved={baseUrl:"admitted-endpoint",env:{TOKEN:"resolved-test-value"}};
  const w=createExternalRunLivenessWorker(db,{getAdapter:(type:string)=>{if(type==="test_external")return undefined;calls.push(type);return {type,probeRun:async({config}:any)=>{expect(config).toEqual(resolved);return {state:"gone",reason:"missing",authoritative:true};},stopRun:async({config}:any)=>{expect(config).toEqual(resolved);}} as any;},
   resolveConfig:async(company:string,config:any)=>{expect(company).toBe(companyId);expect(config).toEqual(saved);return resolved;},
   onSettled:async()=>{},onObserve:async()=>{},onTerminal:async()=>{},wake:async()=>{}} as any);
  await w.sweep();await w.consumeOutbox();
  const [ended]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  expect(ended.status).toBe("failed");expect(calls).toEqual(["admitted_adapter","admitted_adapter"]);
 });

});
