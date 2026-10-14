# Upgrade the Luma fork

1. Fetch `paperclipai` and `origin`. Confirm upstream's default branch
   (`master` at creation), advance `upstream` to that branch, and push only
   to our fork. Never submit upstream communications without Corey's approval.
2. Select an upstream release tag and record its full SHA. In a clean worktree,
   rebase `luma` with `git rebase --onto <new-release-sha> <old-base-sha>`.
   Keep a local backup reference before rewriting the patch stack.
3. Compare each entry in `PATCHES.md` with upstream. Drop a patch only when
   upstream ships equivalent capability; retain or adapt regression tests.
   Update the base SHA, patch inventory and removal conditions.
4. Run the focused patch tests in `PATCHES.md`, `pnpm check:token-gates`, and
   relevant typechecks. Follow upstream's full test/build requirements when
   claiming broad compatibility. Do not hide failing tests.
5. Publish the verified `luma` stack to our fork. Coordinate branch rewrites
   with other operators; use an explicit observed-SHA force-with-lease only
   for a release rebase. Never force-push homelab `main`.
6. In a fresh homelab worktree from `origin/main`, update
   `services/paperclip/fork.lock.json` with the fork URL, `luma` SHA, release
   and base SHA. `scripts/build-paperclip-image.sh` fetches `luma`, verifies
   the pin is on that branch, exports exactly the pinned source and builds
   the fork's production target on the cluster. It then adds the homelab
   OmniGenT adapter. Use a new immutable `YYYYMMDD.N` tag.
7. Pin the returned image digest in both production and staging manifests.
   Run exact CI on the complete homelab candidate SHA. Publish the guarded
   candidate on main, then immediately stage with
   `scripts/stage up paperclip --sha <candidate-sha>` and inspect readiness,
   health and the staged logs. Staging is synthetic, not a copy of live data.
   Tear down only this staging environment after verification.
8. Before pushing, fetch homelab main again. Only push
   `git push origin <candidate-sha>:main` if `origin/main` is an ancestor;
   otherwise rebase and repeat exact CI. No force push.
9. After staging passes, trigger a full Argo `paperclip` sync at the candidate
   SHA, not a selective sync: snapshot PreSync -> deployment -> seed/recover
   PostSync. Verify all hooks, Synced/Healthy and the deployed digest.
10. In the browser, use a harmless Tests-project task and an OmniGenT agent.
    Select Sonnet 5.5 and High in the task composer, run it and verify the
    actual OmniGenT session model and effort. Also verify the agent's upper
    Model / Thinking effort controls save and survive a reload. Restore any
    temporary agent defaults and archive test sessions; never delete them.

Keep the deployment receipt with CI, image, fork and homelab SHAs, hook results,
browser screenshots and the acceptance session ID.

## Current homelab image build boundary

Check services/paperclip/Fork.Dockerfile in the pinned homelab source.
The approved PER-218 build extends the lightweight upstream dependency image
with a narrowly compiled server overlay: activity.js, heartbeat.js and
run-history-query.js. The image build checks lockfile equality and gates the
overlay with five run-history/regression test files and server typecheck.
It ships upstream DB packages/migrations unchanged; do not silently ship
schema/dependency changes. Pin fork source and immutable image together.
Broader changes need build-boundary review; do not assume every fork file
ships. UI source, adapter-utils and token gates are still tested.

The indexes listed in PATCHES.md are homelab PostSync operations, not source
patches or migrations in this fork. On every upgrade, compare the release's
exact predicates and migrations with these definitions. Do not infer merge
from a closed proposal. A release upgrade that retains the same expensive
JSON projection is not itself a measured performance repair.

The homelab CNPG configuration disables PostgreSQL JIT (PER-288/PER-289).
Do not remove that setting as incidental upgrade cleanup. Compare the released
external-conversation projection and exact page APIs first. Change the setting
only in homelab source with exact CI and full Paperclip reconciliation; verify
both CNPG instances. The fork image contains no database setting or migration.


## Rationale evidence on upgrade (PER-289)

Read each carried patch's Upstream choice/Why note. Separate verified author
rationale, observed source limitations and local improvements; unknown intent
is not a documented design choice. Retain the full external-conversation
contract in PATCHES.md: latest eligible conversation, tenant/assignment, review,
interaction/approval, publication, heartbeat, wake/session, dependency and
monitor predicates. Provider extensions are not measured
performance repairs. Do not infer origins from shallow-boundary blame.
Released equivalent source, preserved contracts and comparable measurements
are retirement evidence; closed proposals or master-only code are not enough.
The PER-289 review is after deployment, not retroactive release approval.

## Attention blocked projection (PER-716)

Keep the permanent legacy-projection equality and unused-query regressions.
`listBlockedForAttention` must inherit every new upstream read/visibility filter
(in particular master's actor `readCondition`) and preserve issue list ordering
before reusing the blocker analyzer. Retire when a released equivalent avoids
unused list hydration and passes payload, graph and queue/retention parity.
Synthetic profile gains are not production latency acceptance.
## Decision queue listing carry (PER-715)

On upgrade, compare decision-queues.ts visibleItems with the PER-715 ledger.
Keep the real-PostgreSQL query ceiling and single-source visibility parity
checks. Do not replace source/company/hidden checks or actor authorization with
same-company membership, implicit-board shortcuts or cross-request caching.
Parent integration must include decision-queues-routes.test.ts in its image
regression gate and preserve the pending reset-readiness carry in base 505f58abe.
This implementation commit is not production deployment or phone acceptance.

## Pending wake comment ownership (PER-806)

Keep the run-2757f0d9 fresh/resume regression when rebasing adapter-utils.
Pending comments must remain visible under the current-events wake section,
not disappear merely because task history contains them. Exact history copies
are omitted only from the displayed prompt; persisted continuation data and
approval/objective provenance are unchanged. Retire the carry only with a
released equivalent passing the exactly-once and edited/distinct-ID checks.
The OmniGenT external adapter must use this same adapter-utils revision, not
its older npm dependency copy; test the assembled image's buildPrompt too.
PER-358's execution-run-context candidate is prepared but not deployed. Its
PATCHES.md entry records SQL-only equivalence/performance and unfinished exact
API/render acceptance. Do not mistake a task-branch SHA for image provenance;
compile and copy both execution-projection and execution-run-context together
and retain the embedded database/tenant tests. Broad tsc previously OOMKilled
both BuildKit lanes; a 1536 MiB Node heap passed the focused verification.
The lasting source-owned build limit and repeated canaries belong to PER-377.

## PER-378 candidate: issue-run context single decode (not deployed)

The issue-run history projection now extracts wakeCommentIds as JSONB and
wakeCommentId/commentId/issueId as text in one guarded LEFT JOIN LATERAL.
Company predicates, membership, order, result/usage projection, redaction and
execution/liveness decoration are unchanged. Malformed/non-object contexts
retain one row with null fields. The database contract test compares all four
fields and unusual JSON types. Dependency lockfile is unchanged. Endpoint
benefit, packaging and deployment gates remain pending; do not label this live.

## Comment attribution candidate boundary (PER-382)

The PER-382 issues.ts candidate must be deliberately added to the narrow
homelab server overlay and its test gate by PER-378; a fork commit alone does
not ship this file. Keep the existing routing/run-history/execution overlays
and exact dependency lock. Check emitted issues.js, not only deployed src.
This candidate changes only indexed issue membership in comment attribution.
Explicit own-run IDs, outer tenant scope, timestamp bounds, lossless log
markers and secret redaction are invariants. Do not generalize the helper to
native_issue_id/taskId: that would change the old attribution contract.
Do not simplify externalConversationStateSql for this candidate. Its repeated
predicate was not the dominant cost in the bounded blocked-row plan; all
Slack liveness guards are retained. Endpoint benefit, attention <200ms,
combined pre-ship cross-review, CI/staging and deployment remain unverified.
