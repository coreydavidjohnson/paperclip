import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedCompressionBlockForTransition, managedCompressionBlockUnchanged } from '../server/src/services/managed-compression-block.ts';
const timestamp = '2026-10-22T03:35:55.757Z';
const task = {id:'issue',companyId:'company',status:'blocked',statusVersion:11,updatedAt:new Date(timestamp),executionRunId:null,checkoutRunId:null,unblockDescriptor:null};
const run = {id:'run',runtimeMode:'legacy',errorCode:'omnigent_context_compression_failed'};
const proof = {runId:'run',status:'blocked',statusVersion:11,updatedAt:timestamp};
const action = {companyId:'company',sourceIssueId:'issue',kind:'active_run_watchdog',cause:'legacy_execution_requires_reconciliation',status:'resolved',outcome:'blocked',evidence:{runId:'run',originalFailureCode:run.errorCode,managedCompressionBlock:proof,automaticRecovery:{policy:'preserve_without_replay_v1',replay:'blocked'}}};
test('records only the native-owned legacy compression status transition',()=>{
 assert.deepEqual(managedCompressionBlockForTransition({...task,status:'in_progress'},task,run),proof);
 for(const change of [{status:'blocked'},{status:'done'},{status:'cancelled'}]) assert.equal(managedCompressionBlockForTransition({...task,...change},task,run),null);
 for(const change of [{runtimeMode:'native'},{errorCode:'omnigent_unreachable'}]) assert.equal(managedCompressionBlockForTransition({...task,status:'in_progress'},task,{...run,...change}),null);
});
test('authorizes only the unchanged server block and source',()=>{
 assert.equal(managedCompressionBlockUnchanged(task,action,'run'),true);
 const legacyProof = {runId:'run',statusVersion:11,updatedAt:timestamp};
 assert.equal(managedCompressionBlockUnchanged(task,{...action,evidence:{...action.evidence,managedCompressionBlock:legacyProof}},'run'),true);
 assert.equal(managedCompressionBlockUnchanged(task,action,'foreign'),false);
});
for(const change of [{statusVersion:12},{updatedAt:new Date('2026-10-22T03:36:00Z')},{status:'todo'},{executionRunId:'busy'},{checkoutRunId:'busy'},{unblockDescriptor:{owner:'board'}},{companyId:'foreign'},{id:'foreign'}]) test('rejects task change '+JSON.stringify(change),()=> assert.equal(managedCompressionBlockUnchanged({...task,...change},action,'run'),false));
for(const change of [{companyId:'foreign'},{sourceIssueId:'foreign'},{status:'cancelled'},{outcome:'restored'},{cause:'other'},{kind:'other'},{evidence:{...action.evidence,managedCompressionBlock:null}},{evidence:{...action.evidence,originalFailureCode:'other'}},{evidence:{...action.evidence,automaticRecovery:{policy:'other',replay:'blocked'}}},{evidence:{...action.evidence,executionReconciliation:{runId:'run'}}},{evidence:{...action.evidence,continuationDelivery:{state:'pending'}}}]) test('rejects action change '+JSON.stringify(change),()=>assert.equal(managedCompressionBlockUnchanged(task,{...action,...change},'run'),false));
