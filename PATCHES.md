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
