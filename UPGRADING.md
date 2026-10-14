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
