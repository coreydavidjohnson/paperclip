# Luma Paperclip patches

Base: `v2026.1005.0`, commit `467125fafb47a8520856504fecc48d6e32055db1`.
`upstream` follows `paperclipai/master`; `luma` carries the following separate
commits. There are no upstream issue or PR links by Corey's instruction.

## 1. External adapter composer capabilities

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

- Why: prevent publishing a fork image with a broken carried composer patch.
- Files: `Dockerfile`.
- Removal condition: upstream ships equivalent capability.
- Test: build `Dockerfile` target `production`; the `luma-patch-tests` stage
  must pass both composer test files, `ui/src/context/FileViewerContext.test.ts`
  and `pnpm check:token-gates` before app copy.

## 3. Ignore stale task file-browser navigation

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
