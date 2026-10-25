# Luma Paperclip patches

Base: upstream `paperclipai/paperclip` master `4415665d67b16ffefbe4519c4bdd521f37bb87b9`
(2026-10-17; after nightly `v2026.1017.0-nightly.0`, newest release `v2026.1012.0`).
Branch `task/per980-rebase` carries only the patches below as separate commits on
that base. Previous base was `v2026.1005.0` (`467125faf`), 647 commits behind.
No upstream issue or PR links, by Corey's instruction.

The PER-980 audit (drop/carry per old commit) is in the PER-980 ticket. Every
carried patch below has a regression suite run by the `luma-patch-tests`
Dockerfile stage, which also runs `pnpm -r typecheck` and `pnpm check:token-gates`.
The production stage copies from that stage, so an image cannot exist unless
the gate passed.

Not carried any more (upstream covers them, or the PER-966 lifecycle replaces
them): create-task dialog overrides (upstream dialog uses the task composer),
PER-258 self-assigned decomposition (upstream 4039d4f06), PER-912 indexed
execution identity (upstream bd64eb27b), PER-218 single context extraction
(upstream ebeac833a), the guarded desktop recovery endpoint (PER-591, never
activated; PER-580 must re-propose it on this base), and all OmniGenT
run-lifecycle layers: PER-282 attachment/observation, PER-708 admission
suspension, PER-902 observer retirement and the omnigent branches in
heartbeat.ts.

## PER-316 queued-interrupt restart carry

- Why: a server exit after saving a queued interrupt but before cancellation
  left the original running. Recovery also missed the current indexed issue
  identity and historical `taskId` identity when guarding successor runs.
- Contract: record the original run in the existing durable queue transaction.
  Recovery revalidates company, issue, assignee, actor, current queue and task
  eligibility before retrying only that target through native cancellation.
  Indexed issue identity wins over conflicting legacy context. Targetless old
  receipts cannot gain stop authority. Existing process-stop and admission
  fences remain required; never wait for provider cancellation under issue locks.
- Files: `server/src/routes/issues.ts`, `services/operator-interrupt.ts`, and
  `services/heartbeat/run-control.ts`. Real-database/process regressions live in
  `issue-queued-comments-routes.test.ts`, already part of the image gate.
- Scope: this is not the normal comment-POST replay repair. Automatic resend
  remains disabled until whole-operation replay and staging qualify it.
- Remove when upstream saves original queue interrupt authority and recovers it
  with equivalent indexed/legacy identity and successor safety.

## PER-1009 production carry and recovery conflict corrections

- The rebased readiness route must retain the deployed `c069c7a942` behavior:
  use the existing `persistentDedicatedDb` connection for readiness, never the
  occupied shared query pool. Restore the deployed synthetic and real-database
  regressions, preserving single-flight and the two-second failure deadline.
  The synthetic suite reproduced two failures before the correction.
- Recovery-action upserts must recognize both authorized unique constraints
  inside Drizzle's `cause` chain. Reuse the existing `isUniqueViolation`
  helper rather than introducing another error unwrapper. Unrelated unique
  constraints still propagate. The full image gate exposed four concurrent
  replay failures; deterministic unit coverage reproduced both wrapped
  recovery conflicts before the correction.
- The production image gate includes the real readiness fixture and the
  shared database-error helper tests. No failed test is waived, and no
  production rollout is implied by a focused result.
- Restore the deployed interactions GET read-only regression in the image
  gate. The route already preserves that behavior; restoring its test does
  not reintroduce expired-interaction sweeps or activity writes on reads.
- Reconciliation delivery must acknowledge the exact already committed wake
  before considering task closure or reassignment. Bind the company, owner,
  mutual wake/run IDs, system actor, source issue, recovery action and recorded
  decision; never call wake again for that receipt. Real database regressions
  reproduced four lost-ack failures and then passed all eight selected cases,
  including rejection of mismatched owner, source, decision and actor receipts.
- Wake admission must use its reserved transaction connection for issue,
  routine and responsible-user reads. Run filesystem workspace preflight before
  taking the admission transaction, only for issue wakes with isolated
  workspaces enabled, and revalidate dependencies under the lock. Restore the
  deployed one-connection real-database regression in the production image gate;
  do not compensate for nested acquisition by increasing the pool.
- Remove these carries when upstream retains readiness isolation and uses
  constraint-aware wrapped-error detection in recovery-action upserts, and
  delivery recognizes exact committed acknowledgments without a second wake.
  Retire the admission carry when all transactional wake reads stay on their
  reserved connection and slow filesystem preflight cannot consume it.

## 1. External adapter composer capabilities

- Why: the task composer's model/effort controls use a built-in adapter
  allowlist and hide them for external adapters that publish a catalog.
- Contract: a nonempty adapter model catalog enables model selection; per-model
  `reasoningEfforts` declares effort choices; external adapters use native
  `adapterConfig.model` and `effort`. Built-in keys unchanged. Upstream's
  create-task dialog now uses this same composer, so this also covers it.
- Files: `packages/adapter-utils/src/types.ts`, `ui/src/api/agents.ts`,
  `ui/src/components/task-chat/composer-run-settings.ts`,
  `ComposerRunSettingsPicker.tsx` and both tests.
- Remove when: upstream enables model selection from a nonempty catalog.

## 2. Ignore stale task file-browser navigation

- Why: a file-viewer callback from a task the user has left could navigate the
  user back to it (seen from Inbox).
- Contract: drop search navigation when the current pathname differs from the
  route that created the callback.
- Files: `ui/src/context/FileViewerContext.tsx` and test, `TaskSidePanel.tsx`.
- Remove when: upstream rejects departed-route callbacks.

## 3. Task run membership through indexed lookups (PER-218)

- Why: task run history used `issue_id = X OR EXISTS(activity ...)`, which
  scans every company run. Upstream ebeac833a already ships the
  single-pass context projection, so only the membership half remains.
- Contract: `issueRunIdsCondition` = `id IN (runs with issue_id = X UNION
  activity_log runs for X)`, company-scoped; same membership, no duplicates.
  Used by `activityService.runsForIssue`. The liveness backfill keeps its
  upstream predicate.
- Files: `server/src/services/run-history-query.ts`, `activity.ts`, tests
  `run-history-query*.test.ts` (old/new membership parity on PostgreSQL).
- Remove when: upstream replaces the correlated OR-EXISTS.

## 4. Native Home Lab child delegation (PER-309 / PER-327)

- Why: platform work is delegated to Home Lab from outside its report tree.
- Contract: an authenticated agent with a bound running run may create a todo
  child for the unique active same-company Home Lab from its own running parent
  run, with a native parent blocker. Admission is re-checked under locks inside
  the child-plus-blocker transaction. No new endpoint or grant.
- Files: `server/src/services/home-lab-delegation.ts`, `services/issues.ts`
  (`createChild` transaction), `routes/issues.ts`, two delegation tests.
- Remove when: Home Lab is no longer the shared delegation target, or upstream
  ships equivalent cross-tree delegation.

## 5. Bounded controller drain and admission fence (PER-282, D10)

- D10 re-check: upstream hot restart (`prepareHotRestartShutdown`,
  `reconcileHotRestartAdoption`) covers local child processes that survive a
  same-host restart, using an intent file on local disk. It does not cover a
  Kubernetes rolling update: the new pod is a different process with no shared
  intent file, and upstream's graceful drain interrupts every legacy run with
  `server_shutdown_interrupted`. Upstream has no readiness drain either. So the
  drain is carried; its OmniGenT-specific parts are not.
- Contract: loopback `POST /api/health/drain` (preStop) starts a one-way
  120-second deadline. `/api/health/ready` returns 503 while draining. All
  schedulers and sweeps stop; every queued-to-running claim takes a per-agent
  advisory lock and re-counts running runs in the same transaction. Shutdown
  waits for current finalizers until the deadline, never interrupts or replays
  a run, and force-exits 10 seconds after the deadline.
- Dropped from the old patch: the reaper's `awaiting_external_evidence`
  retention and the OmniGenT lease-loss ownership branches. The PER-966
  liveness worker owns ending external runs.
- Files: `server/src/controller-drain.ts`, `services/run-admission.ts`,
  `shutdown.ts`, `index.ts`, `routes/health.ts`, `services/heartbeat.ts`
  (scheduling suppression), `services/heartbeat/queue.ts` (claim fence),
  `native-runtime/native-review-dispatch.ts`, `controller-drain.test.ts`,
  `scripts/smoke/per282-controller/` (two-controller exercise).
- Deployment coupling: homelab `k8s/paperclip/20-paperclip.yaml` preStop calls
  the drain route; `terminationGracePeriodSeconds: 150` covers 120 + 10 + slack.
- Remove when: upstream drains overlapping controllers without interrupting
  admitted runs.

## 6. Cross-pod ephemeral UI events (PER-282 / PER-619)

- Why: upstream `live-events.ts` is still a process-local EventEmitter; with two
  overlapping pods, browsers on one pod miss the other's updates.
- Contract: one dedicated PostgreSQL LISTEN session per process carries UI
  hints only (business observers stay origin-local). Bounded payloads and
  queue; overflow sends a reset hint that makes clients refetch. Readiness
  requires LISTEN. WebSockets close 1013 on transport loss or reset.
  Upstream's per-event delivery-time authorization (`visibleEvent`) is kept and
  applied to both company and global hints; the 1 MiB slow-reader cap counts
  the pending frame.
- Files: `packages/db/src/index.ts`, `services/live-events.ts`,
  `live-events-transport.ts`, `realtime/live-events-ws.ts`, `index.ts`,
  `routes/health.ts`, `ui/src/context/LiveUpdatesProvider.tsx`, transport
  unit/integration/fault tests, `scripts/smoke/per282-events/`.
- Remove when: upstream ships a cross-instance live-event transport.

## 7. Minimal blocked projection for Attention (PER-716)

- Contract: `listBlockedForAttention` selects only the fields Attention uses
  and keeps the list's order and blocker analysis. It now takes upstream's
  actor `readCondition`, so private-task visibility is unchanged.
- Files: `services/issues.ts`, `services/attention.ts`, attention test.
- Remove when: upstream stops hydrating the full issue list for Attention.

## 8. Decision queue listing reads (PER-715)

- Contract: one company-scoped join per queue instead of two reads per item;
  each item is still authorized normally. At most four queries per listing.
- Files: `services/decision-queues.ts`, `decision-queues-routes.test.ts`.
- Remove when: upstream batches these reads with the same authorization.

## 9. Pending wake comments stay in current events (PER-806)

- Contract: pending wake comments always render once in the wake section;
  only exact history copies are omitted from the displayed continuation.
- Files: `packages/adapter-utils/src/server-utils.ts` and test. The homelab
  OmniGenT adapter must build against this adapter-utils revision.
- Remove when: upstream keeps pending wake bodies exactly once.

## 10. Bounded company refreshes and issue polling (PER-827)

- Contract: company issue/attention invalidations flush at most every 10 s;
  issue details keep 300 ms. Live-run, run-history and browser polling at
  15 s. Attention and issue lists use a private weak ETag.
- Files: `ui/src/lib/query-invalidation-batcher.ts`, `LiveUpdatesProvider.tsx`,
  `pages/IssueDetail.tsx`, `hooks/useTaskBrowsers.ts`,
  `server/src/middleware/private-json-etag.ts`, `routes/attention.ts`,
  `routes/issues.ts`, and three tests.
- Remove when: upstream bounds the same refresh paths.

## 11. Lean recovery and Slack run lookups (PER-826)

- Contract: recovery selects allowlisted context/result keys plus a SHA-256
  fingerprint of the whole context (for the repair race check) instead of the
  full JSON. Failed provider results stay whole. Added
  `reviewPathRecoveryAttempt` to the allowlist for upstream's review-path
  recovery.
- Files: `services/recovery-run-query.ts`, `recovery/service.ts`,
  `slack-conversation-lifecycle.ts`, `recovery-run-query-db.test.ts`.
- Remove when: upstream projects recovery reads.
- Upgrade rule: diff every new `contextSnapshot`/`resultJson` key that
  `recovery/service.ts` reads against the allowlist before carrying.

## 12. Opt-in omission of unused issue-list metadata (PER-826)

- Contract: the UI list client sends `includeReviewAttention=false` and
  `includeUnblockDescriptor=false`; API defaults are unchanged.
- Files: `routes/issues.ts`, `services/issues.ts`,
  `packages/shared/src/types/issue.ts`, `ui/src/api/issues.ts`, two tests.
- Remove when: upstream offers an explicit slim list projection.

## 13. Bounded skills and external model caches (PER-826)

- Contract: process-local, 256 entries. Company skill lists 5 s, partitioned
  by company, actor and query; external adapter models 30 s. Authorization
  runs on every GET. Skill-route writes, skill-service writes and every agent
  lifecycle transaction (create, update, terminate, remove, rollback, hire
  decisions) invalidate before and after the write.
- Files: `server/src/lib/async-ttl-cache.ts`, `services/company-skills-cache.ts`,
  `routes/company-skills.ts`, `services/company-skills.ts`, `services/folders.ts`,
  `services/agent-lifecycle.ts` (transaction wrapper), `adapters/registry.ts`,
  `routes/agents.ts`, four tests.
- Remove when: upstream caches these with tenant boundaries and invalidation.

## 14. Reconcile obsolete holds without resuming blocked work (PER-894)

- Contract: the board can reconcile a failed recoverable legacy turn's hold
  while the issue stays `blocked` on a real dependency. Delivery is recorded
  as `not_requested`; nothing is woken or replayed. Live work, competing
  actions and dependency races are rejected under locks.
- Files: `routes/issues.ts`, `services/execution-projection.ts`,
  `services/execution-recovery-resolution.ts` (`deliverContinuation` option),
  `issue-recovery-actions.test.ts`.
- Remove when: upstream reconciles settled holds without forcing `todo`.
  (Upstream 976cdc77e lists settled holds; it does not change this.)

## 15. Test timeouts under cluster load

- Raises embedded-PostgreSQL setup timeouts in five test files so the image
  gate is stable on shared BuildKit nodes. Test-only.

## 16. Image gate

- `Dockerfile` stage `luma-patch-tests` (after `build`): full typecheck, token
  gates and every suite named above. `production` copies `/app` from it.
- Remove when: the fork carries no patches.

## 17. Core external-run liveness (PER-966)

- Why: a lost controller or quiet remote session must not occupy a run slot forever,
  and a retry must not repeat work with unknown outcomes.
- Contract: explicit turn-scoped dispatch handles, database progress/alive/deadline
  clocks, bounded read-only probes, confirmed-gone recovery, probe-gated observe-only
  takeover and observer-epoch/version fencing. Terminal transitions persist the
  epoch and provider-stop intent together; a claimed outbox retries cleanup.
  Unknown and deadline endings require reconciliation, never automatic replay.
  Confirmed-gone wakes preserve pending question/approval and dependency gates;
  one durable deferred receipt keeps recovery context until the gate is resolved.
  Release redelivery rechecks those gates; stranded admission retains receipt identity.
  Observer setup always releases lease renewal on failure. Configuration lookup,
  probe and stop each have a ten-second bound, including never-settling lookups.
  Prepared/submission-unknown handles become eligible for a probe after ten minutes.
  Completion transfers cleanup-event authority only from its accepted terminal row.
  Direct-Stop no-work accounting requires the exact settlement receipt and epoch.
  Newer recovery coalesces older input-free receipts; saved human input is retained.
- Confirmed-stop integration (PER-1011): operator cancellation retains its hold
  until a fresh original-turn probe returns gone/settled. Reconciliation and
  the existing keyed release outbox commit together; a retained proof prevents
  a lost ACK from stopping a reused session. The bounded cutover CLI defaults
  to read-only and reports unprovable sources. Ordinary task gates still apply.
- Files: adapter-utils contract, database migration `0355_run_liveness`,
  `services/heartbeat/external-run-state.ts`, `external-run-liveness.ts`,
  runtime/output/completion/lifecycle/recovery/queue integration, controller lease,
  `server/src/index.ts`, and their PostgreSQL and unit regression suites.
- PER-1009 / PER-1016 deferred-wake repair: an unlocked todo/in_progress issue
  retries its oldest saved wake after two minutes via normal queue admission.
  The issue lock fences competing sweeps; pending approval/question cards,
  dependencies, Stop, active no-replay holds and outstanding cleanup still gate it.
  Regression: `server/src/__tests__/heartbeat-stranded-wakes-db.test.ts`, included
  in `luma-patch-tests` (real PostgreSQL, refreshed updated_at, concurrent sweeps).
  Upstream recheck: `391dd15ff` recovers released comment queues but still filters
  for comment IDs or interaction responses; plain assignment wakes remain absent.
- PER-1009 reconciled user wakes adopt the exact pending native outbox decision
  under the issue lock. Admission retains the original conversation, authenticated
  comment provenance and fresh-session intent atomically with the successor.
  Lost acknowledgements reuse that successor. A newer accepted source invalidates
  obsolete delivery without changing its recorded outcomes or current ownership.
  A no-continuation decision remains no-dispatch. Board, session-preparation,
  explicit-continuation and history regressions are mandatory image-gate inputs.
- PER-1009 recovery repair: parent-child membership never creates dependency links.
  Recovery retires obsolete actions without mutating a newer accepted source.
  The remaining review-wait status repair locks the issue, compares source version,
  timestamp and ownership, and rechecks active paths and explicit links in the
  same transaction. Terminal dependency history is retained.
  Board reconciliation settles only older same-company/issue/cause/run/owner
  duplicate holds without workspace or existing delivery evidence. One selected
  action retains continuation ownership and its existing idempotency key.
  Regression suites: heartbeat-process-recovery and issue-recovery-actions,
  including a real lock-wait race, board resolution and lost-ACK admission.
- Production carry audit (PER-1009): preserve the net changes through production
  `12e3abaf98baa25ae58bf53dcc3f4d10594b6293` without restoring obsolete observer,
  admission-suspension or observer-retirement controllers. The split heartbeat
  modules retain claimed-lease adoption, isolated renewal pools, queued-comment
  delivery acknowledgements, staleness checks and explicit client-path priority.
  Retain scoped comment attribution, default projects, whole-note audit identity,
  typed routing-child cleanup, managed-compression provenance, owner handback,
  bounded readiness, attention/dashboard queries and UI refresh/read receipts.
  Upstream work-signal ownership, indexed issue identity, authorization and the
  split-module boundaries remain authoritative. The private migration 0294 was
  absent from the final production tree and is not reintroduced; lifecycle uses
  migration 0355. Completion timing follows explicit runtime/completion contracts,
  not an obsolete post-return controller assertion. Reattached completion uses a
  new local monotonic origin, never the old process clock.
  Regression fixtures model current query chains, indexed issue_id and encoded
  JWTs rather than public dotted domains. Access-hidden agents still receive 404.
  All carried changed server suites, UI read/refresh suites and Node checks are
  registered in the existing image gate; no existing gate is removed.
- Deployment coupling: PER-1009 owns the schema-gated old-controller drain,
  OmniGenT adapter, parked-wake cutover, real staging matrix and combined release.
  Do not deploy the rebased fork before those gates pass.
- Remove when: upstream owns the same durable remote-run lifecycle.

- Owned terminal completion transfers cleanup-event authority before fallible post-terminal effects; the real-database cleanup regression preserves the warning after a completion exception without granting stale observers a new epoch.

## Delivered comment revisions before questions (PER-316)

- Why: the current question guard reads only the initial run snapshot. An
  authenticated external comment delivery records a durable acknowledgement,
  but a later question still receives `newer_comment_not_delivered`.
- Scope: reread the source run under the issue/run fence and accept only its
  server-owned acknowledged receipt for the exact current comment revision.
  Delivery and ordered native steering record that revision. A fresh delivery
  can refresh an old versionless receipt; a question write cannot.
- Preserve unread/later/edited direction, foreign-run, pending/failed and invalid
  receipt rejection; do not mutate the launch snapshot or approve anything.
- Regression: real delivery-to-question route plus receipt negative controls in
  the complete interaction service suite, both retained in the image gate.
  Current-base red proof and limits are in
  `docs/incidents/2026-10-25-paperclip-comment-delivery.md`.
- Remove when upstream delivers the same revision-bound acknowledgement guard.

## Bounded delivery and control-failure telemetry (PER-316)

- Why: verify the comment latency target and distinguish an observed lease loss
  from an adapter-reported disposition failure without exposing task data.
- Contract: middleware starts before idle admission, parsing and authorization.
  Histograms use fixed methods, registered route templates and status only,
  with a 300 ms bucket and bounded overflow. Scrapes do not observe themselves.
  Process-local counters record one controller abort or one committed
  `paperclip_disposition_failed` terminal transition, not refused CAS writes.
- Regression: metrics and real comment-router response/error tests, controller
  lease expiry and lifecycle stale/replayed failure tests in the image gate.
- This adds the private scrape surface only. Production ingress exclusion,
  monitoring configuration and live verification must land together.
- Remove when equivalent upstream telemetry supplies these exact acceptance
  measurements and bounded, non-sensitive labels.

## Homelab-owned settings (not fork patches)

- Database indexes in `luma-homelab` `k8s/paperclip/70-db-indexes.yaml`
  (secret-redaction lookup, effective issue, creation source). Compare with
  upstream migrations on every upgrade before removing.
- PostgreSQL `jit: off` in `k8s/paperclip/10-cnpg.yaml` (PER-288/289).
- The OmniGenT adapter and `register-adapter.sh` live in
  `luma-homelab/services/paperclip`, not in this fork.

## Dependency-install worker budget (PER-1033)

- Why: BuildKit OCI RUN hides cgroup resources on the private builder. Node
  sees 24 physical CPUs while the pod has six CPUs and 6 GiB; pnpm 9.15.4
  starts 23 workers and the dependency stage exits 137.
- Contract: the existing resolution and frozen installs run through
  `scripts/pnpm-resource-budget.mjs`. Visible cgroup limits or explicit build
  allocations size the worker pool; hidden allocations fail with a clear
  request for build arguments, never a physical-host fallback. No dependency,
  lifecycle-script, lockfile, release-test or independent-build concurrency
  semantics change.
- Regression: `scripts/pnpm-resource-budget.test.mjs`, registered in
  `luma-patch-tests`; real deps-stage evidence and integration instructions
  are in `docs/incidents/2026-10-18-dependency-build-memory.md` and
  `doc/DOCKER.md`.
- Remove when: the pinned package manager detects the actual build allocation
  and its resource use fits the allotted builder capacity without this wrapper.
