# Recovery wakes must retain pending decisions

A real PostgreSQL integration test reproduced confirmed-gone recovery
starting execution while a question or approval was pending. New liveness
admission omitted the card checks that stranded-wake admission used.

Fix: under the issue lock, liveness admission stores one deferred receipt.
Redelivery adopts it. Normal stranded-wake recovery rechecks current gates
before admitting it after the card is resolved. Provider-stop evidence does
not answer questions or approve work.

Regression: heartbeat-external-observer-integration.test.ts proves pending
question and approval gates, one receipt, and one execution after resolution.
Concurrent outbox delivery/redelivery retains the outcomes-unknown prompt.
The integration, queue, and stranded-wake suites passed all 44 tests.
Server TypeScript also passed before this documentation update.

Separate release blocker: BuildKit was OOMKilled (137) twice before the
full gate could finish. Focused tests do not imply a full gate pass.
No image publication or deployment occurred.

## Stop, reassignment and legacy receipt boundaries (PER-1032)

Real-route PostgreSQL regressions reproduced two supersession failures: a
stopped issue could not admit explicit later user input, and an old assignee's
budget-held recovery prevented the new assignee's saved input from draining.
Unbound legacy skipped/coalesced receipts also lost safe recovery context on
fresh admission. Separate commits correct receipt adoption, periodic queued
receipt preservation, and Stop/current-owner authority.

Rule: only the current company/assignee and an unbound receipt can hold queue
release. A later authenticated user comment is new authority, not replay of
the cancelled turn; cleanup and normal admission gates still apply. Preserve
outcomes-unknown context on legacy adoption. Never revive cancelled/bound
receipts. Periodic admission must work with the outbox already done.

Regression suites: heartbeat-stop-owner-liveness-recovery.test.ts (5 cases),
heartbeat-superseded-liveness-recovery.test.ts (3 cases), and wake-queue
adapters/postgres.test.ts (63 cases, including native-stop and incomplete-
configuration releases). Providers are simulated; routes, queue and PostgreSQL
are real. These fixtures do not prove provider-stop or external tool effects.

Earlier final-validation attempts timed out (124); a TypeScript attempt exited
137 without diagnostics. Do not infer OOM from that exit. A later live read
showed high I/O pressure and RPC-waiting processes but no cgroup OOM kills.
Retain failed runs in acceptance history even after a successful retry.

Fresh retry on the unchanged implementation passed all 71 tests in three
files (270.30 seconds, exit 0); server TypeScript also exited 0. Both new
regression files are registered in the existing image gate. Full release and
real-provider staging remain the parent task's gates; nothing deployed.

## Stale receipt identity and post-Stop decisions (PER-1049)

Real PostgreSQL with assembled queue/routes reproduced two distinct defects.
An actual worktree-cutoff skipped receipt retains its saved recovery contract;
adopting it replaced the incoming newer predecessor with the old one. A
budget-deferred receipt produced the same wrong-predecessor substitution. These are context corruption, not just conservative outcomes-unknown
instructions. Match the incoming predecessor and require a saved predecessor
before adoption; retain mixed-version skipped/coalesced adoption when that
contract exists. No age cutoff is introduced.

A real Stop followed by approval resolution retained the approval in the
database but omitted approvalId/approvalStatus from the later fresh user run.
Save the merged receipt context before the cancelled/cleanup admission guard;
keep that guard unchanged so recording a decision does not restart work.
Answered question content is independently rebuilt in executionContinuation
from durable thread history; missing transient interaction fields alone did
not prove answer loss. Former-assignee mention did not resurrect old-owner
execution; the new owner's queued comment remained delivered.

Regression: heartbeat-stale-liveness-recovery.test.ts, registered in the
existing Dockerfile image gate. Routes, delivery service and PostgreSQL are
real; provider probe/execute are simulated. Parent owns the separate legacy
adoption status correction, final image gate and real-provider acceptance.


### Retained-candidate recovery (2026-10-20)

The interrupted final suite and PostgreSQL queue executions finished with
exit 0 (5 and 63 tests). Fresh retained-candidate regressions passed 5/5;
server tsc --noEmit exited 0. Earlier five-suite acceptance: 41 passed, exit 0.
Earlier red runs include an invalid transient-answer assertion (durable
answer present) and a nonexistent fixture delivery column; neither is a
production defect.

Local commit found an empty stale task index.lock. Inspection found no
process/file-descriptor owner; only that task lock was removed. Preserve
parent 1a67bf768 scoped update predicate, deferred status and cleared
timestamps alongside context-before-Stop ordering. Its test and incident
file remain exact.

Local checks used Node 22.23.1/pnpm 9.15.4 with Node >=24.11.0 engine and
simulated-provider connection-tool warnings. Parent owns Node24 image and
real-provider Stop/tool-effect acceptance. No push/deploy/full image build.

### Verified merge completion (2026-10-20)

After the planned host restart, inspection found the three child commits
already present and a resolved but uncommitted merge of parent 1a67bf768.
The pre-restart integration-focused log has no final outcome and is not a pass.
A fresh three-suite command reached its 600-second command lifetime and was
killed before reporting a suite result; no OOM attribution is made.

Separate unchanged-source reruns passed stale recovery/post-Stop delivery
5/5 (390.75 seconds, exit 0) and legacy supersession 5/5 (338.26 seconds,
exit 0). Server tsc --noEmit exited 0; staged and working diff checks exited 0.
The parent test and external-liveness incident file match 1a67bf768 exactly.
The combined-suite timing limitation remains for the parent image gate.

Scoped durable-memory promotion was attempted once but rejected its dataset
binding (home_lab_agent_memory versus the server-bound hyphenated name); no
alternate scope was used. The verified lesson remains in this incident.
No push, deployment, host change, or competing full image build occurred.
