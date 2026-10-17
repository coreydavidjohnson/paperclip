import assert from 'node:assert/strict';
const a='http://'+process.env.CONTROLLER_A+':3210', b='http://'+process.env.CONTROLLER_B+':3210';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function post(base:string,path:string,body={}) {const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();}
await post(a,'/clear');await post(a,'/seed',{timer:true});
const ticks=await Promise.all([post(a,'/tick'),post(b,'/tick')]);
assert.equal(ticks.reduce((sum,r)=>sum+r.enqueued,0),1);
console.log('PASS simultaneous timer schedulers: exactly one durable due claim/wake');
await pause(14000); await post(a,'/clear');await post(a,'/seed');
const timed=await post(a,'/lease-timeout');assert.equal(timed.aborted,true);assert.match(timed.message,/lease lost/);
console.log('PASS real PostgreSQL locked renewal aborts at lease deadline:',JSON.stringify(timed));

await post(a,'/clear'); await post(a,'/seed');
const retained=await post(a,'/retained-omnigent');
assert.equal(retained.retained.status,'running'); assert.equal(retained.retained.executionStage,'awaiting_external_evidence');
assert.deepEqual(retained.retained.resultJson,retained.original);
console.log('PASS expired OmniGenT owner retains original run/session/response/turn and blocks replacement (no provider dispatch)');
const lost=await post(a,'/db-loss'); assert.equal(lost.aborted,true);
console.log('PASS real unreachable PostgreSQL connection fences executor by deadline:',JSON.stringify(lost));
