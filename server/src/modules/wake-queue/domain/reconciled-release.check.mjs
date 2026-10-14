import assert from 'node:assert/strict';
import { permitsReconciledRelease } from './reconciled-release.ts';
import { decidePreDrain } from './policy.ts';
const input={companyId:'company',issueId:'issue',agentId:'agent',runId:'source'};
const action={companyId:'company',sourceIssueId:'issue',returnOwnerAgentId:'agent',status:'resolved',kind:'active_run_watchdog',cause:'legacy_execution_requires_reconciliation',evidence:{executionReconciliation:{runId:'source',providerStopped:true,actionOutcome:'not_performed',outcomeEvidence:'Verified isolated source has no unsettled provider actions.'}}};
assert.equal(permitsReconciledRelease(input,action),true);
let checks=1;
for (const patch of [{companyId:'foreign'},{sourceIssueId:'other'},{returnOwnerAgentId:'other'},{status:'active'},{kind:'deliberate_wait_without_target'},{cause:'other'}]) {assert.equal(permitsReconciledRelease(input,{...action,...patch}),false);checks++;}
for(const patch of [{runId:'other'},{providerStopped:false},{actionOutcome:'unknown'},{outcomeEvidence:'too short'}]) {assert.equal(permitsReconciledRelease(input,{...action,evidence:{executionReconciliation:{...action.evidence.executionReconciliation,...patch}}}),false);checks++;}
for(const continuationDelivery of ['pending','delegated']) {assert.equal(permitsReconciledRelease(input,{...action,evidence:{...action.evidence,continuationDelivery}}),false);checks++;}
assert.equal(permitsReconciledRelease(input,{...action,evidence:{...action.evidence,automaticRecovery:{replay:'blocked'}}}),false);checks++;
assert.equal(permitsReconciledRelease({...input,workspaceRestoreFailure:'restore_unsafe_archive'},action),false);checks++;
assert.equal(permitsReconciledRelease({...input,workspaceRestoreFailure:'restore_unsafe_archive'},{...action,evidence:{executionReconciliation:{...action.evidence.executionReconciliation,workspaceRepairEvidence:'Verified repaired isolated workspace and unchanged authority.'}}}),true);checks++;
console.log(`${checks} reconciliation guard assertions passed`);

const facts={issueRowPresent:true,executionRunIdMatchesRun:true,isWorkspaceValidationFailedRun:false,isConfigurationIncompleteFailedRun:false,issueStatus:'todo',hasAssigneeUser:false,assigneeAgentMatchesRunAgent:true,legacyExecutionNeedsReconciliation:true,executionCancellationAcknowledged:false};
assert.equal(decidePreDrain(facts).kind,'released');
assert.equal(decidePreDrain({...facts,legacyExecutionNeedsReconciliation:!permitsReconciledRelease(input,action)}).kind,'proceed');
assert.equal(decidePreDrain({...facts,executionCancellationAcknowledged:true,legacyExecutionNeedsReconciliation:false}).kind,'released');
assert.equal(decidePreDrain({...facts,executionRunIdMatchesRun:false,legacyExecutionNeedsReconciliation:false}).kind,'released');
console.log('4 pre-drain assertions passed; exact reconciliation changes released to proceed without bypassing Stop or successor lock');
