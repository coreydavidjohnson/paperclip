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
