# Guarded desktop recovery (PER-591)

POST /api/internal/desktop-recovery accepts X-Desktop-Recovery-Token only.
It never authenticates a board/agent/run actor and cannot access other routes.
The endpoint returns 503 unless a separate approved Secret configures a token
of at least 32 characters. No credentials or grants ship in this patch.

PAPERCLIP_DESKTOP_RECOVERY_TARGETS maps registry keys to companyId, agentId,
desktop, namespace, incidentIssueId and optional restoreOnlyIssueIds. The last
list is an explicit operator-reviewed allowlist of restore-only child IDs;
request bodies and title matches cannot authorize closing broader work.
PAPERCLIP_DESKTOP_RECOVERY_RESUME_ENABLED defaults false. Production activation
requires the explicit approval extension owned by PER-580.

Version 1 request: agent, desktop, incidents [{id,reason,time,involvedObject:
{apiVersion,kind,namespace,name,uid}}], optional ready {recoveryId,batch:
{namespace,name,uid,generation,observedGeneration},podUid,observedAt}.
Times are Unix seconds. For enabled resume, observedAt must be within the last
60 seconds (at most 5 seconds future clock skew), obtained AFTER reading the
current owned Ready Pod and observed BatchSandbox generation. A blocked
transition after that observation is not eligible. The caller may renew only
observedAt after another live read; other Ready evidence is immutable for the
same recovery identity. This allows startup catch-up and newly eligible work
without authorizing a later outage from an old retry. Disabled incident-only
transport remains compatible with clients omitting observedAt.

Response: version, agent, desktop, recoveryId, notifications [{id,issueId,
commentId}], resumes [{issueId,blockedTransitionId,transitionId,
blockedTransitionAt,statusVersion,receiptId,outcome,wakeRequestId,recoveryId}],
resumeEnabled. Outcomes are resumed or closed. Returned prior receipts are
stable; a new eligible blocked transition can append a receipt. Unknown command
outcomes require native execution status and target readback before any replay.

Receipt/audit rows, native issue update and durable native scheduler intent
commit in one transaction. The company/agent/issues and governance-row fences
are conservative and bounded by lock/statement timeouts; timeout/deadlock rolls
back. The existing heartbeat scheduler dispatches after commit and on restart;
there is no second recovery loop. Projection statusVersion and actual latest
blocked-transition audit must agree; unknown/change-of-blocker history fails
closed. No updatedAt heuristic, blind PATCH, board credential reuse or production
fixture is used.

Run focused HTTP/eligibility tests with:
  node --import ./cli/node_modules/tsx/dist/loader.mjs --test tests/desktop-recovery/http.test.ts tests/desktop-recovery/eligibility.test.ts
Run native migrated PostgreSQL/API checks, as a non-root user, in a disposable
run-scoped namespace with no production credentials:
  node --import ./cli/node_modules/tsx/dist/loader.mjs --test tests/desktop-recovery/native-integration.test.ts
Database orchestration tests additionally use test-only @electric-sql/pglite;
postgres.test.ts uses the native embedded-postgres and postgres-js dependencies.
Do not mistake injected-hook orchestration checks for native service validation.
