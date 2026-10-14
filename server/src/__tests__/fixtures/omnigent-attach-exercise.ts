import assert from 'node:assert/strict';
const a='http://'+process.env.CONTROLLER_A+':3210', b='http://'+process.env.CONTROLLER_B+':3210', omni='http://'+process.env.CONTROLLER_B+':6767';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function post(base:string,path:string,body={}) {const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();}
const rows=async()=>await(await fetch(a+'/runs')).json() as any[];
async function wait(check:()=>Promise<any>,label:string){for(let i=0;i<300;i++){const v=await check();if(v)return v;await pause(100);}throw Error('Timed out: '+label+' '+JSON.stringify((await rows()).map(r=>({id:r.id,status:r.status,error:r.error,resultJson:r.resultJson}))));}
await post(a,'/clear');const seed=await post(a,'/seed-omni');const boot=await post(a,'/resume');
const original=await wait(async()=>{const r=(await rows()).find(x=>x.id===seed.runId);return r?.resultJson?.omnigentDispatchReceipt?.state==='observed'?r:null;},'durable provider receipt');
const receipt=original.resultJson.omnigentDispatchReceipt;
const evidence=await(await fetch(omni+'/evidence')).json();assert.equal(evidence.messages,1);assert.ok(evidence.token);assert.equal(evidence.runId,seed.runId);
assert.equal(receipt.omnigentSessionId,evidence.sessionId);assert.equal(receipt.activeResponseId,evidence.responseId);assert.equal(receipt.turnId,evidence.turnId);assert.equal(receipt.userItemId,evidence.userItemId);
async function api(base:string,path:string,body?:any,method?:string){const r=await fetch(base+'/api'+path,{method:method??(body?'POST':'GET'),headers:{Authorization:'Bearer '+evidence.token,'X-Paperclip-Run-Id':seed.runId,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,await r.clone().text());return r.json();}
for(const base of [a,b]){const me=await api(base,'/agents/me');assert.equal(me.id,seed.agentId);await api(base,'/issues/'+seed.issueId);await api(base,'/issues/'+seed.issueId+'/comments',{body:'Run-scoped before drain '+(base===a?'A':'B')});}
const turnStarted=Date.now();
const shutdown=await post(a,'/shutdown',{graceMs:Number(process.env.DRAIN_GRACE_MS??250)});
assert.ok(Date.now()-turnStarted>=Number(process.env.DRAIN_GRACE_MS??250));
console.log("CHECKPOINT elapsedMs="+(Date.now()-turnStarted)+" graceMs="+Number(process.env.DRAIN_GRACE_MS??250));assert.equal(shutdown.result,'checkpointed');
let retained=(await rows()).find(x=>x.id===seed.runId);assert.equal(retained.status,'running');assert.deepEqual(retained.resultJson.omnigentDispatchReceipt,receipt);
assert.equal((await fetch(a+'/api/health/ready')).status,503);
for(const base of [a,b])await api(base,'/issues/'+seed.issueId+'/comments',{body:'Run-scoped after checkpoint '+(base===a?'A':'B')});
// Periodic real orphan recovery performs automatic same-run adoption, no manual wake.
const attached=await wait(async()=>{const r=(await rows()).find(x=>x.id===seed.runId);return r.controllerBootId!==boot.boot&&r.executionStage==='external_attached'?r:null;},'same-run controller handover');
assert.equal(attached.id,original.id);assert.equal(attached.wakeupRequestId,original.wakeupRequestId);assert.equal(attached.startedAt,original.startedAt);
await api(b,'/issues/'+seed.issueId+'/comments',{body:'Original token on new owner B'});
await api(b,'/issues/'+seed.issueId,{status:'done'},'PATCH');
await post(omni,'/finish');const final=await wait(async()=>{const r=(await rows()).find(x=>x.id===seed.runId);return r.status==='succeeded'?r:null;},'original run finalization');
await post(b,'/settled');await pause(1500);
assert.equal((await rows()).length,1);assert.equal(final.resultJson.session_id,evidence.sessionId);assert.deepEqual({...final.resultJson.omnigentDispatchReceipt,mirrorIntent:undefined},{...receipt,mirrorIntent:undefined});
const after=await(await fetch(omni+'/evidence')).json();assert.equal(after.messages,1);assert.equal(after.interrupts,0);assert.equal(after.approvals,0);
const comments=await(await fetch(b+'/comments/'+seed.issueId)).json();assert.equal(comments.filter((c:any)=>c.body.startsWith('Run-scoped')).length,4);assert.equal(comments.filter((c:any)=>c.body==='Original token on new owner B').length,1);
console.log('PASS actual heartbeat + home-owned adapter HTTP integration: same run/session/user/response/turn after bounded checkpoint and controller handover');
console.log('PASS original JWT through both production auth/API routers: agent self, issue reads, comments before/after drain and on new owner');
console.log('PASS exactly one prompt, zero interrupts/approval replays, one original run succeeds; no replacement/recovery run');
