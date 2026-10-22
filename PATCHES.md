# Luma Paperclip patches

Base: `v2026.1005.0`, commit `467125fafb47a8520856504fecc48d6e32055db1`.
`upstream` follows `paperclipai/master`; `luma` carries the following separate
commits. There are no upstream issue or PR links by Corey's instruction.

## 1. External adapter composer capabilities

- Upstream choice (observed source; intent unverified): pinned `467125f` and
  released `v2026.1012.0` use `MODEL_ADAPTERS` and adapter-specific effort/key
  mappings. These encode built-in contracts, not an established intentional
  ban on external catalogs. Our catalog-backed capability adds external support
  while preserving built-in keys. Retain until a released equivalent exists.

- Why: the built-in adapter allowlist hid task model/effort controls for
  external adapters even when they advertised models.
- Files: `packages/adapter-utils/src/types.ts`, `ui/src/api/agents.ts`,
  `ui/src/components/task-chat/composer-run-settings.ts`,
  `ui/src/components/task-chat/ComposerRunSettingsPicker.tsx`, and their two tests.
- Contract: a nonempty model catalog enables model selection. Optional
  `AdapterModel.reasoningEfforts` declares each model's effort choices.
  External settings use native `issue.assigneeAdapterOverrides.adapterConfig`
  `model` and `effort` keys. Built-in mappings remain compatible.
- Removal condition: upstream ships equivalent capability.
- Test: `pnpm --filter @paperclipai/ui exec vitest run
  src/components/task-chat/composer-run-settings.test.ts
  src/components/task-chat/ComposerRunSettingsPicker.test.tsx`.
  Includes an arbitrarily named external adapter, catalog fetch, effort/model
  selections, reset, unrelated override preservation and built-in regressions.

## 2. Patch tests gate production image builds

- Upstream choice (observed source; intent unverified): pinned `Dockerfile`
  builds UI/server and checks emitted output, without a carried-patch Vitest
  gate. Upstream CI was not inspected for this review; its rationale is
  unverified. Our image gate protects the private patch stack, not a claimed
  upstream defect. Retain until the owning pipeline gates every regression.

- Why: prevent publishing a fork image with a broken carried composer patch.
- Files: `Dockerfile`.
- Removal condition: upstream ships equivalent capability.
- Test: build `Dockerfile` target `production`; the `luma-patch-tests` stage
  must pass both composer test files, `ui/src/context/FileViewerContext.test.ts`
  and `pnpm check:token-gates` before app copy.

## 3. Ignore stale task file-browser navigation

- Upstream choice (observed source; intent unverified): pinned file-viewer
  navigation compares search parameters, not the callback's captured pathname.
  Released `v2026.1012.0` retains that check.
  Same-route updates work, but departed-route callbacks are not rejected.
  No evidence establishes that restoring a departed route was intentional.
  Our guard rejects stale callbacks and preserves current-task updates.
  Blame is shallow-boundary-limited; do not assign origin to `d8b95805`.

- Why: a task file-browser callback could redirect Inbox back to a task after
  the user had left it. Turing authored source commit
  `efe29176c014c961a2e1fe5681c0326be723fd8c`.
- Files: `ui/src/components/task-side-panel/TaskSidePanel.tsx`,
  `ui/src/context/FileViewerContext.tsx` and its test.
- Contract: reject file-viewer search navigation when the current pathname
  differs from the route that created the callback.
- Removal condition: upstream ships equivalent capability.
- Test: `pnpm --filter @paperclipai/ui exec vitest run src/context/FileViewerContext.test.ts`.
  Covers navigation to Inbox, another task and updates on the current task.

## 4. External adapter create-task options

- Upstream choice (observed source; intent unverified): pinned and inspected
  released create serializers admit only `claude_local`, `codex_local` and
  `opencode_local`, with built-in effort keys, independently of the composer.
  No documented reason for excluding other adapters was established. Our
  catalog-backed serializer closes that integration gap; display `modelsCount`
  is not capability. Preserve built-in keys and pending external draft settings.

- Why: `NewIssueDialog` has its own three-adapter allowlist, independent of the
  chat composer. It disabled catalog fetching and discarded external overrides.
  `modelsCount` is adapter-manager display metadata, not a dialog capability.
- Files: `ui/src/components/NewIssueDialog.tsx`,
  `ui/src/lib/issue-assignee-overrides.ts`, their tests and `Dockerfile`.
- Contract: fetch the company-scoped dynamic catalog for the selected adapter.
  A nonempty catalog enables the existing model-lane controls; declared
  `reasoningEfforts` supplies external effort choices. Submit native
  `assigneeAdapterOverrides.adapterConfig.model` and `effort`. Primary lane
  sends no override; empty catalogs stay unsupported. Built-in mappings remain
  unchanged. Pending catalog fetches must not reset external draft settings.
- Removal condition: the pinned release's create dialog supports catalog-backed
  external overrides; re-evaluate on the next fork upgrade.
- Test: `pnpm --filter @paperclipai/ui exec vitest run
  src/components/NewIssueDialog.test.tsx src/lib/issue-assignee-overrides.test.ts`.
  An arbitrarily named external adapter exercises catalog fetching, model and
  effort selection, and the issue-create payload. Serializer tests cover empty
  catalogs, default lane and unchanged built-in keys. Include these tests in
  the lightweight homelab `Fork.Dockerfile` UI-rebuild gate too.

## Earlier image modifications inventory

Before this fork, homelab used the unmodified upstream release image and added
its own OmniGenT adapter plus `register-adapter.sh` entrypoint. These remain
homelab-owned integration files, not carried patches to Paperclip source.
The old held `omnigent-task-chat-picker.patch` was never applied or deployed;
it is superseded by patch 1, not part of the fork build.

## Homelab-owned database indexes (not fork server patches)

The deployment source is coreydavidjohnson/luma-homelab. Production
k8s/paperclip/70-db-indexes.yaml and its paperclip-staging copy own concurrent,
idempotent PostSync index builds. These indexes change no API or ownership rule.

- heartbeat_runs_company_ctx_paperclip_issue_idx: company ID and
  ((context_snapshot -> 'paperclipIssue') ->> 'id'), for secret-redaction issue
  lookups. Retire when an upstream migration supplies equivalent coverage.
- heartbeat_runs_company_effective_issue_idx: company ID,
  coalesce(native_issue_id::text, context_snapshot->>'issueId'), created_at DESC,
  id DESC. Covers the unchanged conversation ownership check. Homelab release
  f25c3ecdae58b827ead57a1fc588faff06df5271; retirement requires equivalent
  upstream coverage or all callers using existing native/context indexes.
- heartbeat_runs_company_creation_source_idx: company ID and
  coalesce(native_issue_id::text, nullif(context_snapshot->>'issueId', ''),
  nullif(context_snapshot->>'taskId', ''), nullif(context_snapshot->>'taskKey', '')).
  Covers creation provenance matching source UUID or identifier, preserving
  native-ID precedence and empty-string fallback. Homelab candidate/release
  source 69986e5739b0588abca8dfd5ddd4c9f05ba8312f. Deployment must be established
  from the owning Argo hook, live validity/readiness and unchanged query plan;
  this ledger entry alone is not deployment evidence. Retire only when upstream
  supplies equivalent coverage or no longer needs this predicate.

Before removing any carried index, compare exact definitions and live plans.
Jobs repair invalid builds only and retain working indexes. The regression
check is homelab tests/test_paperclip_ownership_index.py. Database query speed
is not proof of browser or phone performance. None of these indexes is copied
into the current fork image or supplied by a fork migration.

## Run-history query repair (PER-218)

- Why / upstream choice: pinned and released `activity.ts` already use
  context-match OR company-scoped activity EXISTS. Both are legitimate
  membership, including activity-only runs; the UNION must preserve that
  contract, not widen it. Prior PER-218 verification is recorded below. Repeated JSON extraction is the existing company
  projection shape; no intentional performance trade-off was established.
  Retain full projections, non-object behavior, duplicate removal, ordering,
  company isolation, bounded results and redaction. Existing fixtures and
  baseline-failing shape tests are unchanged; this documentation review does
  not rerun those tests. Closed proposals are not released equivalents.

- Approved by Corey in PER-218 comment fcba4d07-2918-457f-9203-9c157defdc0d.
  Local fork only: do not submit this patch upstream.
- Files: server/src/services/run-history-query.ts, activity.ts, heartbeat.ts,
  and run-history-query*.test.ts. No schema change or migration.
- Task membership uses the union of company-scoped context and activity run
  IDs. Outer company checks, agent join, ordering, projections, liveness and
  route authorization remain unchanged. Duplicate activity cannot duplicate results.
- Company list uses one lateral jsonb_to_record extraction for the same eight
  allowlisted text fields. Non-object context yields null fields. Existing
  bounded results, response assembly and secret redaction stay intact.
- Database-only option: existing company-created/context/activity indexes
  already serve these queries. Another index cannot remove repeated context
  detoasting. Read-only lateral comparison returned identical full projections,
  200 rows, 402–415 ms versus 102–111 ms.
- Released upstream: inspected v2026.1012.0 and deployed v2026.1005.0;
  their company context extraction and task OR/EXISTS remain. Closed proposals
  #6975/#7003/#7311 do not prove a shipped equivalent. No rebase.
- Tests: run-history-query.test.ts, run-history-query-db.test.ts,
  heartbeat-list.test.ts, activity-service.test.ts,
  heartbeat-context-summary.test.ts: 62 passing; server tsc --noEmit passes
  against the pinned dependency image. Fixtures cover non-object/null/scalar
  JSON, text compatibility, allowlist exclusion, duplicate paths, ordering,
  cross-company membership. Query-shape tests failed on baseline.
- Build: homelab Fork.Dockerfile must compile these three server sources and
  copy emitted JS. Base DB packages/migrations stay unchanged; lockfile
  equality mandatory. Remove when a released upstream equivalent passes
  these tests and comparable measurements, not when a proposal closes.

## Self-assigned decomposition (PER-258 / PER-135)

- Corey requested this repair in PER-258 on 2026-10-13; publish only to our fork.
- Adopt only the self-assignment delegation-guard hunk from upstream
  4039d4f06b4dfb4d12bd59831a0aabf2401053dc, not unrelated low-trust policy edits.
- Pass actorAgentId from both create routes; skip ancestor-delegator lookup
  only when assigneeAgentId equals the same actor. Company, ownership,
  assignment, approval and dependency-cycle checks remain unchanged.
- Regression: issue-assignee-invokability-routes.test.ts covers self-decomposition
  with an open actor-created ancestor and retains rejection of returning work
  to another open ancestor creator.
- Companion source-owned MCP repair in coreydavidjohnson/luma-homelab makes
  the existing direct-manager allowance independent of the subtree branch.
  It grants no peer, sibling or non-direct-ancestor assignment.
- Retirement: drop this hunk on a released upstream upgrade containing the
  same fix and passing this regression.
- Packaging must compile and copy server/dist/routes/issues.js; a fork pin
  alone cannot deliver this behavior through the current narrow overlay.

## Homelab-owned PostgreSQL JIT setting (PER-288 / PER-289)

- Owner: coreydavidjohnson/luma-homelab, k8s/paperclip/10-cnpg.yaml.
  Main commit 9cd742b1a890dd160011a24c94672cd51fe65371 sets jit: "off".
  This is deployment configuration, not a fork code patch or migration.
- Why: PostgreSQL compilation dominated the shared external conversation
  projection, even with empty chat tables. Five paired SQL diagnostics gave
  median 401.948 ms with JIT and 5.413 ms without it; not page acceptance.
- Verification: exact-source six-shard CI, synthetic Paperclip security canary,
  full owning Argo sync and SHOW jit=off on both production CNPG instances.
  Postmaster times did not change. Exact deployed selected-field projections
  matched with transaction-local jit on/off; 292 rows, JIT-off execution
  4.576 ms. Existing PER-218 UNION and creation-source index remain.
- Reconsider only after a released query change and comparable exact API/page
  measurements justify JIT. Retain authorization, ordering, projection and
  secret-redaction contracts. Do not reset shared pg_stat_statements.
- This ledger records the setting, not API p50 or full-render acceptance.

## External-conversation projection rationale review (PER-289)

- Upstream `8725d6ce0900d88bac1bd33a679d7b7a3c5d389d` explicitly
  aims to settle published successful Slack turns as Idle, resume the same
  conversation on an admitted message, and preserve unfinished work, delivery
  errors and explicit dispositions. This author rationale is verified.
- CASE is a correctness/liveness contract: waiting requires an in-review issue
  without live execution/heartbeats, pending interactions/approvals, unsent/failed
  publications, active wakes/sessions/monitors or unresolved dependencies.
  It selects the latest eligible company-scoped conversation for the assigned
  agent/endpoint. Empty production chat tables do not authorize removing these
  predicates or weakening review, delivery, tenant or assignment semantics.
- Pinned `467125f` and released `v2026.1012.0` have identical projection source.
  Inspected master `40ecacff4cf77ac28da67266e34771c0276e854d` adds Speko
  eligibility, not a demonstrated JIT performance repair. This is an
  inspected dated ref, not a claim about future upstream HEAD.
- Measured JIT compilation overhead is a scale/execution-setting issue, not
  proof that upstream intended latency. Homelab disables JIT without CASE or
  Drizzle changes. Failed API targets alone do not justify a projection rewrite.
- This review is after deployment, not satisfaction of the missed pre-ship
  gate. Saved exact page API measurements still fail p50 <200ms; browser full
  render <1 second remains unmeasured. No acceptance is claimed.

## Native Home Lab child delegation (PER-309 / PER-327)

- Why: platform work uses the existing child-create route even outside the
  caller's report tree or beneath an open Home Lab-created ancestor. The MCP
  board bridge had a parent-ownership race and must not be deployed.
- Contract: only authenticated standard agents with a bound running run can create a todo child
  for the unique active same-company Home Lab, from their own exact running
  parent run, with a native parent blocker. Admission is repeated under locks
  in the child-plus-blocker transaction, including cancellation and run identity.
  Ordinary assignment, standalone creation, reassignment, low-trust, watchdog,
  environment and monitor checks are unchanged. No new endpoint or grant.
- Files: server/src/services/home-lab-delegation.ts, services/issues.ts,
  routes/issues.ts and focused delegation tests.
- Removal condition: the pinned upstream implements equivalent shared-target
  child delegation with atomic ownership/run/cancellation enforcement; or
  Home Lab no longer serves as the shared platform delegation target.
- Local-only fork patch by Corey's decision; do not propose upstream.
## Controller admission and bounded completion drain (PER-282)

- Authorized PER-282 task branch; based on exact production pin
  1270c9f1e53f64e450f82cc977a11b16b2791c36. Not deployed.
- Upstream inspected at master e0f30a4c7186498b71b2637f253b3399997dac7d
  and supplied release v2026.1012.0 bba6a45f0d364cfd962ac59b3bdf2426a8222adb.
  Upstream master still invokes interrupting heartbeat drain in signal shutdown;
  its existing boot lease is reused rather than adding another leader lease.
- Files: server/src/index.ts, shutdown.ts, controller-drain.ts,
  routes/health.ts, services/heartbeat.ts, services/run-admission.ts,
  services/native-runtime/native-review-dispatch.ts, controller-drain.test.ts,
  __tests__/fixtures/controller-{worker,exercise,faults}.ts and
  scripts/smoke/per282-controller/{exercise.sh,fixture.yaml,postgres.yaml,README.md}.
  No DB migration, grant, secret, dependency/lockfile, production manifest, or
  live-events.ts change.
- Shared claim transaction uses PostgreSQL advisory agent fence plus running
  count. All ordinary/comment/reviewer claim routes use it. Existing timer CAS,
  routine claims and DB-clock boot leases stay authoritative. Shutdown prevents
  scheduler/turn admission, waits boundedly for current work/finalizers without
  operator cancellation, retains run-scoped HTTP access, and exits with bounded
  teardown allowance. Readiness and loopback preStop share a one-way deadline.
- Dispatched OmniGenT runs with expired ownership are retained on the original
  run as awaiting_external_evidence; detachment skips terminalization and
  environment release. This is preservation, NOT completed same-run recovery.
- Exercise: unique disposable namespace, digest-pinned test images, separate
  real controller processes and PostgreSQL, no mocks for controller/DB/process.
  Tested simultaneous admission/timer claim, live-owner startup overlap, long
  process completion, finalizer suppression, timeout, readiness/preStop,
  locked renewal and unreachable DB. Tests/limits are described in the README.
- Remaining gates: actual isolated OmniGenT long-turn checkpoint/reattachment,
  production-router run token exercise across both API pods, full exact-SHA
  typecheck/CI and immutable image integration. Never present seeded retention
  or fixture shared-DB reads as provider/production API acceptance.
- Remove when released upstream ships equivalent behavior and passes these
  two-controller and actual provider recovery gates, not on proposal closure.
## Cross-instance ephemeral UI events (PER282)

- Authorized fork-only overlapping-pod patch. Exact base:
  `1270c9f1e53f64e450f82cc977a11b16b2791c36`. No schema, migration, new
  dependency, external broker, production deployment, or uncertain write replay.
- Rechecked stable `v2026.1012.0` (`bba6a45f0d364cfd962ac59b3bdf2426a8222adb`)
  and upstream master `e0f30a4c7186498b71b2637f253b3399997dac7d`: both still
  use the same process-local EventEmitter. Retire when released upstream
  provides equivalent isolated cross-instance UI hints and reconnect semantics.
- `packages/db/src/index.ts` exposes the existing postgres.js driver.
  `server/src/services/live-events-transport.ts` uses one dedicated session
  per process, shared-database LISTEN/NOTIFY, no table/migration. Reuses the
  Db client resolved connection/TLS/multi-host configuration. Direct PostgreSQL
  (or session-mode pooling) is required; transaction-mode poolers cannot LISTEN.
- `publishLiveEvent`/`publishGlobalLiveEvent` remain synchronous, return numeric
  origin-local IDs, and immediately notify existing business observers.
  Remote hints use separate UI-only subscriptions: they never re-enter the
  all-company chat completion observer or plugin session/business observers.
  Public company/global subscriptions are not conflated. WebSocket delivery
  IDs remain numeric and monotonic per receiving process, not replay cursors.
- Both origin and peers deliver UI hints through the same ordered PostgreSQL
  stream (no local echo duplicate). Sender UUID/sequence dedupe is bounded to
  1024 origins per connection generation. Payloads are bounded to 7500 UTF-8
  bytes, queued sends to 128 hints; oversized/nonserializable payload or queue
  overflow sends a tiny reset hint causing every peer to close/refetch, never
  truncating log chunks. Slow WebSocket readers terminate after 1 MiB buffered.
- Startup is not ready until LISTEN succeeds. One-second same-session probes,
  three-second query deadlines and socket-close callbacks fail readiness
  closed; pending hints are discarded, never replayed after ambiguous writes.
  Retry starts a fresh generation after one second. WebSockets close (1013)
  on loss/reset, reject upgrades (503) until ready, and reconnect using the
  existing UI active-query refetch. `%2A` company subscriptions are rejected.
- Global `plugin.ui.updated` reaches authorized company WebSockets and refreshes
  UI plugin queries without passing into company-specific component handlers.
  No company data is published onto the global stream.
- **Controller integration required (index owned by PER281/parent):** call
  `const liveEvents = startLiveEventTransport(db)` after database setup and
  before listening; include `liveEvents.isReady()` in application readiness;
  `await liveEvents.stop()` before DB pool shutdown. This commit intentionally
  does not edit `server/src/index.ts`. Once enabled, there is no local-only
  fallback on DB loss. Startup can wait for readiness or expose 503 while
  probes retry; startup failure must call stop before disposing DB resources.
- **Image integration required:** compile/copy the changed DB index export,
  live-events.js, new live-events-transport.js and live-events-ws.js, plus
  controller index and rebuilt UI. Existing Fork.Dockerfile only overlays
  PER218 server files, so cherry-picking alone does not update its image.
- Exercised on a bounded, digest-pinned disposable cluster runner (Node
  24.21.0/pnpm 9.15.4) and synthetic ephemeral PostgreSQL, no production
  credentials or storage: 19 focused server tests and 61 UI tests passed;
  server `tsc --noEmit` and token gates passed. Two real forked Node processes
  plus native WebSockets verified company isolation, global events, origin-only
  side effects, ordered IDs/events, dedupe, oversized UTF-8 payload, queue
  overflow, backend termination, login-denial DB loss (503), and controller
  destruction/recreation of synthetic DB with recovery/no stale replay.
- Tests: `server/src/__tests__/live-events-transport.integration.test.ts`,
  `live-events-process-fixture.ts`, existing live-events-ws/chat publication
  tests, `ui/src/context/LiveUpdatesProvider.test.ts`. Integration suite is
  opt-in via `LIVE_EVENTS_TEST_DATABASE_URL`; it refuses anything lacking the
  synthetic fixture marker, intentionally terminates DB backends, and restores
  the role even on failure. Controller DB destruction is opt-in separately.
- Deliberate ceiling: ephemeral invalidations, not durable business dispatch
  or replay; no cross-restart total ID ordering. Internal plugin session
  observers stay origin-local. Full fork/image/exact-SHA acceptance remains
  the parent acceptance lane, not this focused transport exercise.

## PER-282 integrated startup and teardown

- Start UI transport before traffic, require it for readiness, stop before normal and startup-error DB cleanup.
- No production deploy; image/typecheck/provider handover gates remain.

## PER-282 follow-up: durable OmniGenT same-run controller attachment

- **Base:** `bbc0e958ded599ff182507454dbcfa4b7e4f5e60` (production fork pin
  `1270c9f1e53f64e450f82cc977a11b16b2791c36`).
- **Why carried:** retention alone parked expired remote work forever; the
  controller shutdown timeout could close the pool while finalizers were live.
  Current inspected upstream stable `bba6a45f` and master `e0f30a4c` have no
  equivalent for the home-owned external OmniGenT adapter. Reuses that adapter's
  existing read-only rollout attach implementation, not a provider scheduler.
- **Behavior:** commits a versioned run/company/agent/session dispatch intent
  before the provider message POST; stores accepted pending ID and observed
  original user/response/turn identifiers. PostgreSQL boot-lease CAS claims the
  same running row after expiry. The real heartbeat executor passes the durable
  receipt into read-only attachment; no new heartbeat, prompt, session or tool
  replay. Session/user/response/turn binding cannot change during receipt updates.
  Ambiguous delivery remains retained until transcript evidence appears.
- **Checkpoint:** at completion-grace expiry, aborts only the local observer
  with the existing ownership-loss reason (not operator cancellation), joins
  actual executor finalizers, then expires its lease. A periodic reaper on the
  next controller attaches automatically. Original run-scoped tokens remain
  valid across controllers sharing the same signing/instance configuration.
  Missing evidence never grants dispatch authority.
- **Coupled change:** home-owned `services/paperclip/adapter/src/server/execute.ts`
  and `omni-client.ts` in luma-homelab. Approval-create/resolve and final-mirror
  intents persist before their side effects; handover reuses approval IDs and
  never repeats an uncertain write. Removes old cold-start prompt resend.
- **Parent-owned wiring:** `scripts/smoke/per282-controller/INDEX-INTEGRATION.md`
  lists exact `server/src/index.ts` shutdown callback changes. This branch does
  not touch index/live-events/WebSocket/UI/db exports because parent integrates
  those concurrently. Both branches and the index hook must ship together.
- **Verification:** isolated pinned-image real PostgreSQL / two API controllers /
  real home-owned adapter against an exact-HTTP-contract OmniGenT stub. A turn
  outlived the full **120000ms** completion grace, checkpointed and succeeded on
  controller B with original run/session/user/response/turn. Original JWT exercised
  production auth + agents + issues routes on both controllers before/after drain.
  Exactly one prompt, zero interrupts/approval replays, one original run.
  143 adapter tests and 22 focused fork tests passed; changed server production
  modules transpiled with esbuild. Cleanup verified namespace absent.
- **Limits:** stub integration is not real OmniGenT acceptance (PER-285 owns
  that). Tests are source overlays on immutable dependency images, not an image
  build. Full server typecheck previously exited 137; not claimed as passed.
  Parent exact-SHA CI/image build and index wiring remain required, no deploy here.
- **Retire:** drop when upstream + external adapter provide equivalent durable
  same-run remote attachment, identity fencing and no-replay checkpoint semantics.
### PER282 follow-up: dedicated-session isolation and fault receipts

- Checked upstream master `3e8e1efb84d3c9dbf438bf6d0a68eec1873c6539` before
  this correction: upstream live-events remains process-local; no transport
  replacement exists there.
- Remove postgres.js parsed-options `shared` sentinel when cloning resolved
  client options. Otherwise its parser returns the options unchanged and
  mutable retry/type state leaks between the DB pool and event session.
  Retain password callback, TLS, host/port arrays, target-session selection
  and startup parameters; bound the dedicated session pipeline to one.
- Enforce the WebSocket 1MiB ceiling *including* the pending frame and its
  maximum protocol header, not only the already-buffered bytes.
- Add real idle TCP-blackhole, paused native reader, pending-startup cleanup
  and driver-option/stale-epoch regression tests. Parent API unchanged.
- Verified parent controller/readiness overlay `002c2b5`: actual health 503
  and websocket fences passed; integrated server typecheck exit 0. Focused
  server 24 tests, UI 61 tests and token gates passed. See
  `scripts/smoke/per282-events/README.md` for fixture scope and receipts.

- Integrated same-run checkpoint hook. Timed-out shutdown keeps DB/HTTP alive until bounded process exit; checkpointed finalizers permit normal teardown.

## PER282 admitted-turn observation after issue completion

- Source: saved fork 5eb12cd3ae6016b4ac8a002c6a029f8eb2a04a61.
- Actual-image handover rebuilt dispatch authority and rejected the done issue
  before observing the existing provider turn.
- Recovery now enters server-owned receipt/boot-lease-bound observation before
  dispatch identity/context/workspace preparation. No prompt, token, tools or
  new continuation envelope. Terminal CAS fences receipt, company/agent/run,
  live boot lease and current non-cancelled task ownership.
- Ordinary buildExecutionContinuation and new-dispatch guards are unchanged.
  Stop, reassignment, receipt mismatch and expired/foreign lease fail closed.
- Regression: services/omnigent-observation.test.ts and actual-image full-app
  done-before-finish fixture. Home-owned adapter skips label/approval writes
  during observation and verifies original turn identity.
- Retirement: drop when upstream supplies equivalently fenced admitted-turn
  observation/finalization; never relax the new-dispatch security guard.

## Reset hints do not fail the live-event session (PER-619 / PER-608)

- Valid own/peer reset envelopes advance bounded origin dedupe and request UI
  resync (WebSocket 1013) without changing readiness or replacing LISTEN.
  Malformed envelopes, connection loss and the three-second blackhole fence
  still fail closed. No reconnect grace, replay, schema or dependency change.
- Every effective transport failure logs its reason and generation. Reset
  publication logs oversize byte count, queue_full or serialization_error;
  reset receipt logs reset_received separately, never as a database failure.
  Logs contain no event bodies, credentials or company data.
- Regression: live-events-transport.test.ts covers own/peer reset, dedupe,
  malformed payloads, oversized publish and unchanged session/readiness.
  The two-process integration verifies 1013 resync and identical PostgreSQL
  backend PIDs/readiness for oversized and queue-full resets.
- Upstream master inspected on 2026-10-15 and released v2026.1012.0 do not
  contain this downstream transport; no upstream equivalent to upgrade to.
  Retire with an equivalent released transport and these regressions passing.

## Minimal blocked projection for Attention (PER-716)

- Why: Attention discarded labels, active-run/watchdog hydration, last-activity
  aggregates and blockedBy summaries returned by the full issue list. A loaded
  isolated profile measured 15 SQL queries in that phase (59 total).
- Change: `issueService.listBlockedForAttention` selects only consumed fields,
  reuses the existing company/execution/plugin predicates, exact legacy order
  and batched blocker analyzer. No cache, schema, dependency, authorization,
  graph cap, queue/retention mutation, sorting, deduplication or cursor change.
- Verification: RED unwanted-label query regression; 56 focused tests GREEN,
  including permanent legacy-projection parity and company/hidden/harness/
  conversation/plugin exclusions. Same-fixture alternating 12 legacy/candidate
  HTTP pairs: payload equality except generatedAt; queue and retention state
  equality after each request. 180 blocked, 30 review, 142 dependency edges
  (including cycle), one child edge, 40 interactions, 80 failed runs carrying
  100KB context each. Queries 59 -> 54; blocked phase 15 -> 10. Boundary median
  251.09 -> 226.77ms, nearest-rank sample p95 331.89 -> 267.40ms; blocked phase
  median 63.19 -> 43.22ms. These are synthetic results, not production benefit.
- Scope: `attention.ts`, `issues.ts`, `attention-service.test.ts`. Decisions
  queue optimization is independent. Parent owns image/build/deploy/final p95.
- Upstream observed 2026-10-15: released v2026.1012.0 and master
  5ec93dae014c16ff33953fb0fb0274e4efc7819f still use full issue list. No author
  rationale is inferred. Drop when a released equivalent preserves the fixed
  list's visibility/read policies, ordering and blocker semantics, with parity
  and query-count regressions passing. Master now has readCondition; port it
  into this path when upgrading, never discard the new authorization predicate.
- Focused check: `pnpm --filter @paperclipai/server exec vitest run
  src/__tests__/attention-service.test.ts src/__tests__/issue-blocker-attention.test.ts
  src/__tests__/issue-review-attention.test.ts`.
## Decision queue interaction listing reads (PER-715)

- Why: each listed issue-thread interaction performed a source SELECT and an
  issue SELECT before authorization, even for the implicit board actor.
- Upstream: released v2026.1012.0 and inspected master
  b1566ca494f4af6e8d4418fa37393c5caee02582 retain the sequential path; path history
  was last changed September 11. Minimal private carry approved for PER-711.
- Change: one company-scoped interaction/visible-issue join per nonempty queue;
  reuse the exact issue-resource projection, then authorize every item normally.
  Other source kinds and single-source/mutation/retention checks are unchanged.
  No global cache, actor shortcut, schema, dependency, or production change.
- Regression: server/src/__tests__/decision-queues-routes.test.ts uses synthetic
  embedded PostgreSQL. At 271 interactions / 189 issues, count and item listings
  must each use at most four queries and retain exact ordering/results. Parity
  checks cover missing/hidden/foreign sources, board/agent/unauthenticated actors,
  responsible-user denial, low trust and visibility changes between calls.
- Run: pnpm --filter @paperclipai/server exec vitest run
  src/__tests__/decision-queues-routes.test.ts
  src/__tests__/authorization-service.test.ts
  src/__tests__/decision-retention-service.test.ts
- Retire: drop when a released upstream equivalent passes the query ceiling and
  security regressions. Parent PER-711 owns image-gate wiring, integration,
  deployment and final latency; PER-705 owns phone acceptance.

## Pending wake comments remain current events (PER-806)

- Why: an assignment deliberately omits wake bodies, but adapter-utils also
  removed pending comments found in continuation history. Agents saw IDs
  without current-event bodies and ignored new board direction.
- Change: always render pending comments in the wake section. Remove only
  matching ID/body history copies from the displayed continuation snapshot or
  resume delta so the pending body appears once. Do not mutate the envelope;
  preserve edits, distinct IDs, deleted records, foreign-issue history and
  existing objective/approval/source-trust guards.
- Regression: `packages/adapter-utils/src/server-utils.test.ts`, run-2757f0d9
  shape: 13 history messages, two pending comments, resumeDelta present; both
  fresh and resumed prompts require each body once, in wake order. Existing
  edited/distinct-ID and objective-source checks remain. 129 focused tests pass.
- Upstream inspected 2026-10-16: master
  78b833c4958465b5e345b0e337018011b00dab72 and release v2026.1012.0
  retain the suppressing filter; no released equivalent to upgrade to.
- Retire when an upstream release preserves pending wake bodies exactly once
  with the regression passing. Requested private fork carry in PER-806;
  no upstream communication or dependency/schema change.
## Guarded desktop recovery (PER-591)

- Pinned upstream has no registry-bound desktop recovery transport. This private
  service extension uses existing issueService transactions and native scheduler
  outbox, not an agent/board token or a second recovery loop.
- Dedicated authentication, strict bound evidence, actual blocked-transition
  audit, governance fences, durable incident/resume receipts and explicit
  restore-only child closure. Default unconfigured, resume disabled.
- Files: desktop-recovery route/service/eligibility, app mount, token redaction,
  shared status-wake-intents helper and native heartbeat dispatch guard.
- Contract and activation gates: doc/DESKTOP_RECOVERY.md. No new production
  Secret, credential or network grant is included. PER-580 owns client wiring.
- Tests: tests/desktop-recovery (HTTP, policy, isolated DB/races/native services).
- Removal: upstream provides the same restricted transport and native atomic
  fences; retire this patch instead of retaining a duplicate implementation.
## Bounded external-observer admission (PER-708)

- Upstream inspected through 67a9d5cc3 (2026-10-15), including #14979
  silence diagnostics and #16451 remote warm recovery. Neither implements
  admission suspension for the downstream OmniGenT legacy adapter. No new
  dependency, migration or upstream runtime patch.
- A server-owned runner-profile receipt separates admission from ownership.
  After 30 seconds of a blocked/review/done disposition, or five minutes
  without output, the periodic reaper suspends admission only with exact
  company/agent/run/issue/session binding. The original run remains running;
  provider work, receipt, issue blockers and execution locks are untouched.
- All new claims use the same transaction-scoped agent and issue advisory
  fences. A running original run excludes another claim for its issue even
  after issue lock cleanup or reassignment. Unrelated work can use capacity.
- Intent is ambiguous delivery, not proof of rejection. Suspension does not
  cancel, signal, replay, classify effects, or finalize. Original receipt/boot
  lease observation and Stop/execution holds retain their existing authority.
- Regressions: omnigent-admission.test.ts uses real disposable PostgreSQL for
  thresholds, late acknowledgement, blockers/cards, capacity and cross-agent
  claim races. Existing observation tests retain Stop and identity refusals.
- Retirement: remove when a released upstream supports equivalently bound
  external-observer admission and same-issue exclusion, with these tests passing.

- Revalidated over production fork 710551e553870ef2810b689a091bef37e09dddab. Receipt intent is not negative dispatch evidence; idle/no-runner alone is not exact turn-stop evidence. Unknown work stays owned, not finalized.

## Opt-in omission of unused issue-list metadata (PER-826)

- The standard UI list client explicitly sends `includeReviewAttention=false`
  and `includeUnblockDescriptor=false`. The former skips review-path hydration
  and omits `reviewAttention`; the latter projects SQL NULL instead of fetching
  descriptor JSON. Default API/service callers retain both fields, and explicit
  `true` restores them. Detail responses and governance/mutation paths are unchanged.
- Production `ui/src` has no reads of either field. Keep description previews
  (list rows/quicklook/inbox) and all `blockerAttention` data (StatusIcon,
  inbox-live-descendants, TaskChatThread and task relations); do not remove these
  based on payload size. The blocked-leaf sweep's default projection is unchanged.
- Both ordinary/user-context and blocked-inbox list paths honor the flags.
  The normalized flags participate in the existing actor-scoped request key,
  separating full/slim responses; compact-view authorization and recovery
  revalidation remain unchanged. Invalid boolean values are rejected with 400.
- Tests: `server/src/__tests__/issue-list-metadata-routes.test.ts` and
  `ui/src/api/issues.test.ts`; run with `pnpm exec vitest run` plus these paths.
  Token gates: `pnpm check:token-gates`. No dependency/schema change.
- Source finding: pinned upstream hydrates review metadata for every list but
  only the detail endpoint's data is used by UI review controls. This is a
  narrow private-fork payload/query reduction, not a claim of sub-second p95.
  Retire when upstream offers equivalent explicit list projection with the
  default client contract and regression coverage preserved.
- Local hand-off verification for this projection: token gates and TypeScript
  syntax parsing passed; a dependency-free Node smoke exercised the actual
  UI query functions and server projection helpers. Vitest/HTTP DB coverage
  still requires the cluster dependency image (desktop has no node_modules or
  pnpm); no latency improvement is claimed before that run and live measurement.

## Lean recovery and Slack run lookups (PER-826)

- Why: recovery selected large prompt/history/result/usage payloads for status
  decisions; indexed lookups were cheap in EXPLAIN but expensive to return.
- Change: explicit recovery JSON/key and column projections; failed provider
  results (including adapter_engine_unavailable bootstrap evidence) remain whole for arbitrary error classification and lossless updates.
  Retry accounting retains its persisted counters. Slack settlement selects only
  its exact evidence fields. Company predicates, ordering and locks stay intact.
- The blocked-result repair retains an entire-context SHA-256 comparison under
  the existing issue lock, so changes outside the projection still reject repair.
- Upstream inspected 2026-10-16: master b294abb9eb96c33048b4f53a2a037e04886b7407
  still selects complete context/results in these paths; latest release tag
  v2026.1012.0 has no equivalent. Private reliability carry requested in PER-826.
- Regression: server/src/__tests__/recovery-run-query-db.test.ts checks JSON
  types/nested nulls, excluded large payloads, whole-context race detection,
  lossless failure results and retry-accounting parity with embedded PostgreSQL.
- Retire when an upstream release supplies equivalent lean projections and
  passes these contracts. No migration, dependency or permission changes.

## Bounded skills and external adapter model caches (PER-826)

- Upstream inspected: master `b294abb9eb96c33048b4f53a2a037e04886b7407`
  still calls the full skills listing and external `listModels` for each GET.
  Existing inventory coalescing only covers a concurrent inventory refresh;
  existing request memoization cannot reuse results across HTTP requests.
- Contract: process-local successful responses only, 256 entries per cache.
  Company skill lists live five seconds after completion and are partitioned
  by database, company, actor context and validated query. External adapter
  models (including OmniGenT) live 30 seconds, partitioned by adapter, company,
  actor, environment/provider and a hash of process configuration. Built-in
  model discovery keeps its existing behavior. Auth checks run on every GET.
- Concurrent cold requests share a promise. Rejections are evicted; invalidated
  in-flight loads cannot republish. Refresh invalidates model entries before
  discovery, including failed refreshes. Adapter register/unregister/pause clears
  model caches. Skill/source route writes, skill service writes, folder writes
  and agent create/update/rollback/remove/terminate invalidate skill lists before and
  after mutations, including partial failures; overlapping writes bypass reads.
  Filesystem, transaction-scoped and out-of-process changes are bounded by TTL.
- No response shape, schema, permission, dependency or client changes.
- Files: `server/src/lib/async-ttl-cache.ts`,
  `server/src/services/company-skills-cache.ts`, skills/agents routes,
  adapter registry, skills/folders/agents services and four focused test files.
- Tests: `pnpm --filter @paperclipai/server exec vitest run
  --hookTimeout=120000 --testTimeout=60000 src/lib/async-ttl-cache.test.ts
  src/services/company-skills-cache.test.ts
  src/__tests__/company-skills-routes.test.ts
  src/__tests__/adapter-model-refresh-routes.test.ts`.
  Larger timeouts cover cold module transformation in the cluster image.
  Run `pnpm check:token-gates` before carrying this patch.
- Removal condition: upstream ships equivalent bounded/coalesced caches with
  tenant/config boundaries, mutation invalidation and failure/race regressions.
- Verification: cluster dependency image, four files / 72 tests passed
  (`CACHE_VITEST_EXIT=0`, 56.43s). Executed directly with
  `cd /app/server && node /app/node_modules/vitest/vitest.mjs run` plus the
  arguments above to avoid Corepack network bootstrap in the isolated Job.
  All owned test namespaces were deleted and absence verified. Token gates,
  changed-source syntax and standalone cache typecheck passed. Full integration
  typecheck/build remains the parent integration gate; no live latency claim.
## PER-827. Bound company-list refreshes and reconcile issue polling

- Why: every issue activity invalidated the company issue prefix plus covered
  child keys in the 300 ms live-event batch. Open issues also polled live runs
  every second and browser discovery every three seconds.
- Upstream checked 2026-10-16: master `b294abb9eb96c33048b4f53a2a037e04886b7407`
  and release `v2026.1012.0` retain the short company-list batch and hot polling;
  no equivalent found in path/symptom history. Requested patch authorized by
  Corey's PER-824 step 5 and PER-827 description; no upstream proposal.
- Contract: company-scoped issue/attention live invalidations flush every ten
  seconds during activity (no debounce starvation), while issue details keep
  the existing 300 ms window. Covered child invalidations merge only when all
  other query filters agree. Direct user mutation refreshes stay immediate.
  Live-run, run-history and browser interval fallback is fifteen seconds.
- Reuse private JSON validators for full issues and attention. Attention uses
  a weak ETag excluding only top-level generatedAt; JSON bodies are unchanged.
  Private no-cache requires authorization and validation before cache reuse.
  This saves transfer, not the underlying feed generation work.
- Tests: query-invalidation-batcher.test.ts reproduces 60 issue/attention
  invalidations per minute before and six after, with 60 detail updates both
  ways. private-json-etag.test.ts covers 304, changed feed and authorization.
  issue-refresh-budget.test.ts guards interval settings. Live request counts,
  deployment and integration tests remain required, not implied by unit counts.
- Removal: drop on the next released upstream equivalent; re-evaluate these
  paths and preserve authorization, mutation refresh and missed-event repair.

## Suspended-observer wake ownership handoff (PER-902)

- Upstream checked at 9a3290fe10fb1dbe950b91028b58b038b812169a: no
  OmniGenT observer-retirement equivalent. Remove this private integration
  when upstream ships matching semantics and passes these regression tests.
- Fresh identity-bound offline/404 evidence plus a queued wake retires only
  the two-hour-silent observer. Evidence and unknown action outcomes remain;
  no provider stop or prompt retry. Normal release/claim and safety gates apply.
- Crash recovery retries release. Successors use a fresh generation with an
  inspect-before-mutation warning. Admission/recovery and adapter regression
  tests cover preserved receipts, fresh output races, native identity, online
  and pending-approval denial, and zero interrupt/retry effects.
## PER-894. Reconcile obsolete execution holds without resuming blocked work

- Root cause: resolved preserve_without_replay actions are omitted from the
  active recovery list but still project an execution hold; the resolve API
  formerly accepted new evidence only with restored/todo, conflicting with
  a real dependency wait.
- Own-fork repair: board-only exact-action reconciliation can retain blocked
  status when a legacy failed recoverable OmniGenT turn has an unresolved
  dependency. Keep native source/owner/process/lease validation, lock the
  terminal source and dependency, reject live queued/running/retry work and
  competing actions. Retain issue policy, approvals and relations unchanged.
  Store continuationDelivery=not_requested atomically; never wake or replay.
- Cancelled/interrupted/detached errors are outside this path. No automatic
  recovery class or API authorization expansion. Approval-only waits remain
  out of scope; this path requires an unresolved issue dependency.
- Upstream checked: master 73659c6b27c1d97226f2da9ca39f256eefddac66 and release
  v2026.1012.0 bba6a45f0d364cfd962ac59b3bdf2426a8222adb retain todo-only
  settled reconciliation. Drop this patch when a released equivalent preserves
  waits and does not schedule continuation.
- Regression: issue-recovery-actions.test.ts, “reconciles a settled execution
  hold while preserving dependencies and approvals without replay”. RED at
  d0a35ab5afd3e8d8c5f07addc868e0723f6739a0: expected 200, got 409. Initial GREEN
  passed; full 76-test recovery suite passed at e26dda62d9d89cb0a32907a9473af8fd82b7511b.
  Final exact-source integration and live delivery remain separate gates.

## Indexed execution identity queries (PER-912)

- Adopt upstream bd64eb27b060cd54d3c3b8cbbee06aadfe0ae024 (#16291), inspected on master 564d4e1bce10b4e18f6daff09ebd4690e686872d. Latest release v2026.1012.0 exists; a whole-version upgrade is outside this independent fix and risks replacing combined private behavior.
- Apply upstream canonical lowercase UUID SQL guard, indexed status/recovery joins and split native/legacy ownership predicates. No migration, index, permission, delivery CAS, hold or replay change. Resolve older-base import/doc context only; do not import unrelated workspace-recovery behavior.
- Preserve PER-894 no-continuation delivery and dependency locks plus combined admission/UI/payload/cache history.
- Regression uses real disposable PostgreSQL with malformed/noncanonical/missing/foreign bindings, native precedence, existing status-delivery/recovery suites and 192KiB contexts with 1000 same-company issues. The benchmark disables hash/merge joins transaction-locally to reproduce the observed live nested-loop shape; its timings are not production/API/browser latency claims.
- Retire the backport when the next complete upstream upgrade includes this commit and passes the private contracts.
## Reason-coded readiness failures (PER-628)

- Requested private fork repair on production base
  `683f53c09e17fe3addbc3390a49ae8662086bdf8`: `/api/health/ready` returned
  unexplained 503s, including swallowed database probe errors. Timing alone
  does not establish the cause of the observed production failures.
- Every readiness 503 now emits one warning with `event: readiness_failed`,
  ordered `reasons` and `stage` (`preflight`, `database_probe`, `post_probe`).
  Codes: `transport_not_ready`, `controller_draining`, `startup_not_ready`,
  `auth_not_ready`, `database_missing`, `database_probe_timeout`,
  `database_probe_error`. Post-probe state flips report the current blockers.
  No error object/message, query details, headers, credentials or tenant data
  are logged. Ready responses emit no failure warning.
- Response status/body, fail-closed 2000ms deadline, one in-flight query and
  reset/LISTEN transport semantics are unchanged. A timeout is identified by
  a per-request error identity, never by a driver-controlled message.
- Dependency-free focused check (Node 24):
  `node --experimental-vm-modules --test scripts/health-readiness.test.mjs`.
  Executes the complete real health module with mocked imports; covers each
  503 path, simultaneous blockers, synchronous/rejected/late database errors,
  deterministic and real-time deadlines, shared queries and ready recovery.
- Retire when a released equivalent logs all readiness failure paths and
  passes these regressions. No new upstream-equivalence claim is made here;
  this is a narrow diagnostic extension to the existing downstream readiness
  carry. Production rollout and live reason-log acceptance remain separate.

## Client-blocking next-slot dispatch (PER-689)

- Requested private fork patch: upstream master and latest stable v2026.1012.0 inspected; native priority lacks client dependency-path preference.
- Home Lab only: ready queued high/critical issues on unresolved same-company blocks paths to open Co-Intelligence, Huron, AC Foods, AffirmedRx, Paragon or North Labs issues sort before internal work. Names deliberately match the requested client set; review this list on rename. Existing status/priority/FIFO remains within tiers and all claim/approval/dependency gates still run.
- One recursive query over queued candidates, with UNION cycle termination and company/hidden/terminal filters. No schema, credentials, config, preemption, ownership or cap changes.
- Native syncBlockedByIssueIds writes blocker issue_id -> dependent related_issue_id; query follows that direction.
- RED: two high/critical next-free-slot regressions fail original source. GREEN: both pass with patch; expanded dependency suite 18/18 passes (priority, hidden, terminal, nonclient and malformed cycle cases) against disposable PostgreSQL. Held fixture adapter is not live provider evidence.
- Retire when released upstream provides equivalent next-slot client-path dispatch and passes these contracts.

## Current-owner disposition repair hand-back (PER-1091)

- Root cause: the resolver required a blocked board-escalation action, while
  recovery creates agent-owned bounded_owner_disposition_repair actions on
  parked in_progress work. Fresh action IDs therefore failed stale validation.
- Permit only the current agent-owned bounded repair on blocked/in_progress
  work when owner, recorded return owner and locked source assignee agree.
  Keep exact-action, company, run, dependency, interaction, execution hold,
  approval, pending stage, pause, availability and budget gates unchanged.
- Keep the existing blocked board-escalation lane and action-ID replay.
  After the recovery-history merge, check authorized whole-note replay before
  the board-only annotation gate. New late notes remain board-only; original
  owner retries remain read-only even after intervening board annotations.
  The ordinary restored wake remains post-commit/best-effort; this patch does
  not add an exactly-once outbox or claim crash-window delivery guarantees.
- Upstream master 4970d5ed3d184b8b3ddfb2c1185be6cb6dc8c2ea inspected
  2026-10-19 still has the board-only predicate. This private own-fork repair
  is authorized by PER-1091. No schema, dependency, adapter or grant change.
- Regression: unpatched current-owner cases returned 409 instead of 200
  (3 failed, 14 safety/replay cases passed). Patched ownership routes pass
  152 tests; embedded PostgreSQL recovery suite passes 77, including persisted
  action history, one audit resolution and lost-response replay without a
  duplicate wake. Token gates pass. Local Node 22 is below the required 24;
  cluster typecheck/build and live delivery remain separate release gates.
- Independent GPT-6.1 Sol source review accepted the fix. Its initial missing
  run-ID concern was disproved by the existing route-level guard and a passing
  negative regression; no unnecessary guard was added.
- Retire when a released upstream equivalent admits current bounded owner
  repairs and passes these regression/safety/replay contracts.
## Bounded exhausted-run suppression (PER-218)

- Requested by Corey in df0fe808-0ca4-46ea-a836-0e457a49e609. Private fork only.
- Replace Inbox's all-later-agent-history fetch with a same-company/agent
  anti-lookup on each exhausted failed run. Preserve event deduplication,
  strict JavaScript millisecond Date ordering, original raw candidate JSON
  vs newer ->> text fallback semantics, and all feed fields/authorization.
- Expand newer issue/task fallback into separate predicates so existing
  company/context-issue and company/context-task indexes can serve it.
  No migration, snapshot deletion, retention change or new index is required.
- Read-only live diagnostic: unconstrained coalesce anti-lookup 13.56 s;
  equivalent split predicate using existing indexes 251 ms on current data.
  This is a query diagnostic, not a deployed or phone-speed claim.
- Regression: attention-failure-history-db.test.ts, baseline-failing first
  case, 12 fallback/type/isolation fixtures, duplicate events, timestamp ties
  and a baseline-failing microsecond precision case. All three tests pass
  against embedded PostgreSQL on the approved cluster builder.
- Upstream released v2026.1012.0 retains the history scan. Drop this patch
  when a released equivalent passes these regressions and live measurements.
- Production gate: exact fork typecheck/image tests, homelab CI, isolated
  staging, main and full Argo reconciliation, then comparable API/SQL windows.

## Stored lookup keys and observer no-op filtering (PER-218)

- Requested by Corey in df0fe808 and 1003b8d4; parent owns the company/agent/created index.
- Migration 0294 stores exact PostgreSQL text projections of issueId/taskId.
  Generated columns preserve null/empty/non-string JSON extraction and stay
  correct for every writer. Full snapshots, recovery and ownership data stay intact.
- Summary projection reads the stored key. Predicates retain existing JSON
  expressions so current expression indexes remain usable. New keys are internal
  and deliberately absent from the Drizzle row model and wire projections.
- Admission suspension prefilters the same receipt, issue, stage and age checks
  before attempting UPDATE. All authoritative write-time predicates remain.
  The expensive merge is an eligibility attempt, not an ever-growing append log.
- Database regressions cover generated keys on insert/update with large context
  and zero attempted writes for an ineligible observer. Exact semantic typecheck,
  CI, isolated staging and reconciler verification are release gates.
- Retire when released upstream provides equivalent behavior with these tests.

- Review resolution: readRunIssueId returns null for all nonstrings/empty keys,
  and the old map explicitly used ?? empty; no sentinel regression. createdAt
  is NOT NULL. Old map kept maximum Date, not last iteration. Finishing issues
  remain eligible without negative probe, exactly as the original UPDATE.
- Generated stored columns rewrite the table. Bound acquisition to 2s and
  the entire ALTER to 10s inside the existing transactional migration runner.
  Production gate additionally requires a representative synthetic large-blob
  migration timing and rollback-on-timeout check; no unbounded live rewrite.

- Fixed identity-test fixture: the first UUID segment must contain a letter
  before testing a partial-uppercase variant. All-digit random first segments
  made that variant identical to the valid canonical ID and caused false red.
  No production identity logic or acceptance assertion was weakened.

- Authenticated parent request d28ab627/09:27 follow-up: integrate PER-628
  fork 278f9c9 before shipment; do not touch production manifests until that
  release is live. Exhausted failures older than seven days are omitted from
  Attention only. Historical rows/events and recovery semantics are retained.
  Regression first fails without the cutoff (two results instead of one), then
  checks a recent result and continued existence of the old run.
## Per-agent task project defaults (PER-1106)

- Requested own-fork feature: project defaults from agent runtimeConfig.defaultIssueProjectId, validated by company and non-archived project. Explicit project/workspace choices win; parent workspace inheritance already checks project identity. Chat creation returns before this path.
- New assigned tasks and previously unassigned projectless tasks use their agent project. Saving an unchanged assignee does not refill an explicitly cleared project.
- Upstream master b448710986d0e79d73341c07470459fa11956965 inspected: no equivalent default. Retire when a released upstream equivalent supports the same contracts.
- Regression: issue-agent-project.test.ts exercises root, cross-agent child, explicit choice, assignment, no configuration and cleared project behavior against disposable PostgreSQL.

## Bounded recovered-run chart traversal (PER-218)

- Corey requested repair of recovered_runs in 8cc00e8e. Materialize the narrow company/chart-window run projection once, then traverse only that finite set with UNION deduplication. No arbitrary depth cap or persisted recovery backfill.
- Preserves long retry chains, branching, cyclic-link termination, dates/status/error-code totals and all response fields. Cross-company malformed retry links cannot confer recovery.
- Regression first failed cross-company isolation; all five dashboard tests then pass, including a 130-link chain and cycle. Live repeatable-read comparison returned 197 identical buckets; diagnostic old/new execution 1290/142 ms, not a release effect.
- Checked upstream master dashboard source on 2026-10-20; it retains the recursive wide-table joins. Retire when a released equivalent passes the same contracts.

### PER-218 / PER-827 reconciliation repair

- Base: deployed fork `23a6cd6ab06160615911c554b6eae245f836383b`.
  Rechecked upstream master `813e808af` on 2026-10-20: its batcher still
  lacks company-list isolation. Prior fork merge
  `71fa92ccbb6a88d93d9da0d4f25c72e5d171b77d` is not an ancestor of this
  base. Source comparison found the 15-second issue/browser polling,
  ten-second issue/attention batching and filter-safe prefix merging already
  present; preserve them rather than reimplementing.
- Restore only the two client protections present in that prior merge:
  route first-open/reconnect, visibility restore and disconnected fallback
  reconciliation through the shared company-list budget; keep in-flight
  issue/attention reads instead of aborting and restarting them each window.
  Other active queries still reconcile immediately. Inactive matching lists
  are marked stale. Direct user mutations remain outside the live batcher.
- Targeted TDD: existing 14 tests passed; new regressions failed for the
  missing recovery helper/provider wiring and aborted slow request before
  source restoration. A real QueryClient/QueryObserver six-minute simulation
  counts 37 issue and 37 attention reads including the initial fetch, versus
  157 each with broad invalidation restored; detail/other-company reads stay
  121 in both. Slow issue and attention reads finish without cancellation.
  The count is an offline regression budget, not observed Safari traffic.
- Verification: focused Vitest batcher and issue-refresh suites, standalone
  batcher/page-visibility TypeScript check, token gates and diff whitespace.
  No API, auth, response, ETag, redaction, infrastructure or dependency
  changes. Build/deploy and full integration/browser checks are intentionally
  delegated to the parent release gate; historical build failure is not
  claimed resolved. Retire with an equivalent released upstream implementation
  passing these same request-count and in-flight-read regressions.

### PER-218 / PER-827 trailing list refresh repair

- Non-cancelling company-list invalidations carry dirty filters to the next
  ten-second window while a matching request is fetching. Its stale response
  no longer consumes a later live event without a trailing refresh.
- Real QueryClient tests require one stale response followed by one fresh read,
  no request aborts, no extra idle reads, and no queued refresh after disposal.
  Sustained six-minute traffic retains 37 issue and attention reads each
  including initial loads; detail and other-company reads remain 121 each.

### PER-218 migration release correction

The startup generated-column migration timed out and rolled back on production. Do not rewrite heartbeat_runs to cache two JSON keys. The list projection retains the original JSON expression; the Attention anti-join, narrow cycle-safe recovered-run traversal and client refresh budget remain. Fresh-database regression rejects the generated columns and migration. This avoids a live table rewrite or widened application timeouts.


## Restored-wake and routing-parent delivery on current production fork (PER-436)

Reapply only the missing settled recovery history/exact actionId lookup, idempotent late disposition annotation, and typed routing/coordination child contracts from retained c9aab87c0 onto 5e83e5491. Preserve newer execution-hold reconciliation, dependency locking, admission fencing, list query and observer changes. Late annotations apply only to settled disposition actions; other kinds retain their existing idempotent resolution behavior. Original resolution outcome and timestamps remain unchanged. Ordinary blocked tasks remain terminal to the legacy continuation classifier; only an explicitly typed routing-child hand-back is evaluated as productive continuation, with every real wait, approval, budget and owner gate retained.

Regression evidence: current baseline failed both settled history tests and five typed routing-child checks. Helper action_id failed validation before restoration. Full recovery/legacy and helper suites must pass before image publication. Homelab build/typecheck contexts include shared validator source so childPurpose is not silently stripped by a stale dependency-image validator. Retire this carry when equivalent upstream contracts are available.
## Assignment wake comment carrier (PER-1092)

- Why: assignment-only markdown printed comment headings while omitting their
  bodies. The shared wake renderer owns those bodies; turning assignment bodies
  back on would duplicate them in native and OmniGenT prompts.
- Change: emit comment headings only with their bodies. Preserve follow-up
  policy and attachment descriptors when the wake prompt owns comments.
- Upstream checked: 06d4fe3121e57ca834b533e757bd0f540fadabc5 still has the same
  conditional-body/unconditional-heading behavior in heartbeat/task-markdown.ts.
  No equivalent fix found in the fetched recent comment/wake history.
- Retirement: drop when a released upstream renderer never emits bodyless
  headings and passes the real full/compact assignment carrier regression.
- Test: heartbeat-context-summary.test.ts combines real assignment markdown
  with five ordered wake comments on fresh and resumed paths, asserting each
  body exactly once and no bodyless headings; also covers a single comment.


## Split exhausted-run anti-probes (PER-218)

- Authorized isolated repair on released fork `7d1f98205876cc46dfdec9798b42750dc05030a8`.
- Replace the single newer-run `NOT EXISTS` containing three OR branches with
  three conjunctive `NOT EXISTS` probes. Reuse the unchanged candidate issue-key
  SQL expression; preserve raw JSON type/fallback behavior, blank/null handling,
  company and agent scope, and the JavaScript-millisecond newer boundary.
  Selection, ordering, retention and event deduplication are unchanged.
- Upstream checked: fetched `upstream/master` at
  `cb2d6e80d3f7ccb6cb6fb1ebbca528a608a9dd0e`; its service still has no newer-run
  suppression anti-probe. Latest locally listed upstream release tag is
  `v2026.1012.0`; no equivalent split repair found in service history.
- TDD: added database-backed generated-SQL shape regression. Released source
  fails with one probe instead of three (4 existing database tests pass);
  repaired source passes all 5 tests using disposable embedded PostgreSQL.
  Existing fallback/type/isolation, microsecond ties, duplicate-event and
  seven-day-retention cases remain intact.
- No migration, index, deployment, build, main-branch or production-data change.
  This commit carries no endpoint latency/p95 claim. Retire when upstream
  supplies equivalent bounded suppression and passes these contracts.

## Comment attribution run lookup (PER-218)

- Why: seven app-local comment GETs still took 3038–3246 ms for 25 rows.
  In that comments-only pg_stat_statements window, the attribution run lookup
  executed seven times for 20940.586 ms total database execution. Ambient
  traffic remains possible; this is not a browser or phone measurement.
- Minimal repair: reuse existing issueRunIdsCondition in issues.ts instead
  of context OR correlated activity EXISTS. The union retains context-only,
  activity-only and duplicate membership. Outer company, timestamp bounds,
  own-createdByRunId bypass, complete run projection/order, log evidence,
  persisted attribution, comment fields, pagination, authorization and secret
  redaction are unchanged. Applies to listComments and getComment.
- Upstream: fetched master cb2d6e80d and inspected released v2026.1012.0;
  attribution still uses OR/EXISTS. This reuses our existing approved
  run-history helper, not unrelated new upstream body/auth policy changes.
- Read-only production comparison: full eight-column projection returned 13
  rows on both sides with zero EXCEPT ALL differences. Initial EXPLAIN ANALYZE
  was 3582.486 ms old / 36.344 ms new. This establishes query improvement,
  not a deployed API latency claim. No index or migration required.
- Regression: issue-comment-attribution-query.test.ts failed on baseline for
  the missing helper call, then passed. Extended run-history-query-db.test.ts
  covers window boundaries/null fallback, activity duplicates, own-run outside
  window and cross-company exclusions. Offline PostgreSQL fixture and helper
  shape checks pass; parent owns full pinned-dependency CI and API verification.
- Retirement: remove when a released upstream lookup provides equivalent
  indexed membership and passes these contracts/comparable measurements.
- Packaging: compile/copy server/dist/services/issues.js with the existing
  run-history-query.js dependency; no build or deployment performed here.

Native service coverage added during delivery: real schema/comments/log-store tests cover membership, tenant isolation, own-run bypass, pagination, stored attribution and redaction. Equal created_at values retain the existing unspecified SQL tie order and first-in-input marker winner; no deterministic tie-equivalence claim. No migration or snapshot rewrite.

## PER-436: await fixture lifetime before teardown

- Test-only repair after exact combined-image qualification exposed trailing event
  writes racing dependency fixture deletion and contended embedded DB startup.
- Reuse the existing complete executor/wakeup drain before teardown, not the
  earlier terminal status or per-run live marker. Reuse the existing bounded
  embedded-Postgres startup/migration cost-class budget for both fixtures.
- Files: heartbeat-dependency-scheduling.test.ts, issue-comment-redaction.test.ts.
- No production behavior changes. Exact native full-image gate remains required.
- Removal: upstream fixtures use the same complete lifetime and startup budget.

## PER-1091: drain stale-queue test fixture lifetime

- Test-only extension of the existing PER-436 fixture-lifetime repair.
- Exact combined build exposed TRUNCATE racing trailing executor writes despite
  terminal status and the per-run execution-control marker. Reuse the complete
  wake/executor drain before mock reset and fixture deletion, and before DB stop.
- Release the three deliberately held adapter/row-lock gates before draining so
  test timeout cannot strand them; existing hook/test deadlines remain unchanged.
- No production code, concurrency limit, timeout increase or retry waiver.
- Regression: existing mandatory stale-queue suite and complete image gate.
- Retire when upstream fixtures wait for the complete executor lifetime.

## PER-209: bind managed compression recovery to the server-owned block

- Upstream checked at 043f2514e67c50320433a0013fb228a75a51325c (2026-10-22).
  It retains automatic no-replay settlement without a compression status receipt.
- Our source-owned helper must compact the same stopped session before native
  delivery; removing the premature ordinary retry exposed a resolved hold the
  helper previously skipped. Do not reopen arbitrary historical blocked actions.
- Native settlement writes managedCompressionBlock {runId,statusVersion,updatedAt}
  only when this legacy compression failure actually changes a nonblocked task.
  The supported resolver validates the receipt under its existing issue row lock,
  so later human blocks/edits and old receipts without provenance stay held.
- No action replay, new wake writer, provider patch, schema or deadline change.
  Existing latest-source, ownership, approval and dependency checks remain.
- Regression: scripts/managed-compression-block.test.mjs (21 cases; positive
  cases observed red before implementation), issue-recovery-actions.test.ts
  (real resolver guards/idempotence), native-safe-replacement.test.ts (native
  receipt and preexisting block). Cluster semantic/image gates still required.
- Retire when released upstream supplies equivalent status-provenance validation.
PER669: Completion-stage diagnostics

- Instance-local, closed-field monotonic spans for legacy adapter return and awaited controller finalization; no outbound telemetry, payload, URL or error text.
- Preserves polling, ownership, approvals, cancellation and original error identity. Includes immutable captured log handles in both callbacks.
- Focused checks: server/test/completion-timing.node.ts and completion-timing-semantic.node.cjs; normal full semantic/build gates remain required.
- Retire when an upstream release provides equivalent sanitized completion boundaries.

PER209 integration: the completion semantic fixture invokes the installed tsc
CLI because TypeScript 7 does not expose the old in-process compiler API.
It compiles the actual two callback blocks and also requires the original
mutable nullable-handle variant to fail with TS2345. No product behavior,
compiler pin, timeout relaxation or semantic gate removal.

## Atomic status and exhausted-disposition repair (PER-968)

- Upstream checked: master 4415665d67b16ffefbe4519c4bdd521f37bb87b9 lacks
  the common status refusal and guarded board contract. Released upstream
  v2026.1012.0 is the newest tag; this patch stays on the supplied combined
  fork base 5e83e54912d227e126382b2008756312a42d1511, not a whole-release upgrade.
- Root cause: status committed before best-effort recovery revalidation. A
  board escalation captured while blocked could survive a later status change
  and reject both the old-source hand-back and ordinary resume.
- Common issue update now refuses non-blocked status changes while an active
  board escalation exists, before relations, cards or run locks change. The
  existing resolve transaction settles the exact action before its status
  update; failure rolls both back. Same-status comments do not silently clear
  board escalation. No generic recovery clear or temporary blocker.
- Extend the existing POST /api/issues/:id/recovery-actions/resolve contract:
  authenticated board actor; actionId UUID; outcome=restored;
  sourceIssueStatus=todo; nonempty resolutionNote (short normal instruction);
  expectedSource={status,statusVersion,updatedAt,assigneeAgentId};
  expectedAction={fingerprint,updatedAt}. Both snapshots are required together.
  statusVersion is a nonnegative integer; timestamps are ISO-8601 datetimes;
  assigneeAgentId is a UUID. Current source status must be blocked, todo or
  in_progress. Match every supplied source/action field under source-then-action
  locks. Permit only deliberate_wait_without_target, board owner,
  board_escalation, terminalReason=unchanged_source_state_exhausted.
  Reject replacement actions, dependencies, pending questions/confirmations,
  approvals/review stages, pause/budget gates, active execution or owner changes.
- Normal continuation uses existing issue_commented / automation / system
  admission, with source issue.comment, saved authenticated board actor and
  only the short resolutionNote as paperclipAgentMessage. No recoveryActionId,
  forceFreshSession, reset, rotation or alternate saved binding. Existing
  agentTaskSessions supplies sessionIdBefore unchanged. The action transaction
  persists pending delivery; periodic execution-control sweeps retry it.
- Admission deduplicates guarded-status-repair:<actionId> under the source
  lock, including lost acknowledgements after the prior run is terminal.
  Delivered means admitted, not provider success; ordinary native run recovery
  owns subsequent failure. Never replay unknown provider effects. Newly active
  execution/holds defer in this same outbox without another queued receipt.
  Attempted outbox rows rotate updatedAt so 25 blocked rows cannot starve
  younger repairs. A newer source status/version/owner supersedes undelivered
  intent without a wake. Exact unchanged request replay returns 200; any new
  source/action decision returns 409 rather than overwriting it.
- Tests: issue-recovery-actions.test.ts covers the third trap, board comment
  and native in-run refusal, exclusion snapshots, action-row lock race,
  unchanged repeats, lost acknowledgement, concurrent sweep delivery, normal
  same-session payload, newer-decision supersession and batch fairness.
  Review findings for starvation and deferred duplication were reproduced
  failing then passing against real disposable PostgreSQL. No test memory.
- No migration, dependency, identity, model, grant or external-chat changes.
  Parent PER-631 retains sweep detector/prompt integration; agent comments do
  not independently authorize expanding this native atomicity patch.
- Retire when a released upstream equivalent passes the same atomicity,
  exclusion, durable-delivery and same-session regressions. Exact image CI,
  isolated staging and live acceptance remain required delivery gates.

### PER-968 current-production integration (2026-10-22)

Applies only the eight-file atomic repair patch e832dcda onto production fork
155e25d000fd08e80d1c6f58ffee2898982260ac (supersedes the 2026-10-21 44ec1436f
rehearsal). PER-1091's agent-owned disposition hand-back is retained; the board
branch additionally admits a non-blocked source only for a guarded request whose
exact expectedSource/expectedAction snapshots already matched under lock. The historical 352168030 branch and
its unrelated run-context candidates remain preserved, but are not revived by
this delivery. Current production code outside the atomic patch is unchanged.
Preserves atomic whole-note audit and late-note annotation. Guarded replay
validates its exact receipt before the ordinary annotation idempotency shortcut;
final outcome and delivery intent commit before post-commit publication.
Both existing stale-replay and late-note tests must pass. Cluster patch tests,
final image qualification and live acceptance are pending; no deployment claimed.
- Integrated 2026-10-22 onto production fork 689c637f (PER-669 timing
  diagnostics atop 155e25d0); only this ledger conflicted.
- Integrated 2026-10-22 onto production fork 7bd82cec (PER-209 compression
  provenance and timing gate atop 689c637f); only this ledger conflicted.
