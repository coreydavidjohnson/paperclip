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


## Restored recovery history and late disposition evidence (PER-422)

- Cause: restored wakes reference already settled actions, but the native read
  endpoint returned only active actions. A source update can also settle recovery
  before its repair turn writes the final note.
- Files: server/src/routes/issues.ts and issue-recovery-actions.test.ts. No schema,
  grant, ownership, scheduler or migration changes.
- Contract: return at most 50 company/source-scoped records, `hasMore`, or one
  exact UUID via `actionId`; `active` retains active-only semantics. Native read
  permissions remain intact. Missing or foreign exact IDs return not found.
- Board-only late notes for settled deliberate_wait_without_target actions must
  match current source status, with no newer active action. Append previous notes,
  deduplicate retries and audit; preserve resolution outcome/timestamps and never
  mutate the source or enqueue another run. Existing execution-reconciliation
  reopening and authorization gates remain unchanged.
- Source tests: the new disposable embedded-Postgres fixture failed on baseline
  with actions=[] after restore, then passed with note/source readback, retry
  deduplication, newer-action guard and malformed/foreign action checks.
- Upstream master at inspection still returns active plus only workspace restore
  holds, not general settled disposition history. Retire once a released native
  equivalent passes these regressions. No upstream communication is authorized.
- Homelab Fork.Dockerfile must compile and ship routes/issues.js; otherwise a fork
  pin alone does not deploy this repair. Add the recovery test to its gate.
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

## Unsupported blocked owner disposition (PER-404 / PER-270)

- Corey explicitly authorized minimal fork patches in board comment
  c84b473b-87bc-4c5a-9afc-77948134163c. Publish only to this fork, never upstream.
- A successful legacy run with blocked but no durable wait evidence enters the
  existing owner repair. Pending questions/approvals, unresolved blockers,
  monitors/review stages, pause/Stop/budget, changed ownership, native finalizers
  and active recovery/replay holds still prevent admission.
- Include blocked candidates in the stranded sweep, but route them only through
  successful legacy disposition repair. Failed/unknown side effects never use
  the generic replay paths. Keep the original episode's two-attempt budget,
  idempotent successor keys and deduplicated exhausted-board alert.
- Tests: legacy-continuation.test.ts and legacy-continuation-authority.test.ts
  cover bare-blocked one-sweep admission, replay deduplication, bounded attempts
  and retained pending human gates. Upstream and deployed classifier repro both
  failed before this patch. No database or API schema change.
- Packaging must compile/copy recovery/service.js and legacy-continuation.js;
  changing the fork pin without emitted server overlays does not deploy the fix.
- Retirement: remove this carry only after a released upstream equivalent
  passes these regressions. Restart-card repair remains a separate acceptance
  requirement; this patch does not answer human approval or clear replay holds.

## PER-404 routing-child deadlock prevention

Board scope added 2026-10-14, incident row 14: coordination/routing children
cannot be native blockers of their own parent. Child creation has explicit
childPurpose (implementation default), persists routing_child/coordination_child,
and suppresses blockParentUntilDone only for these purposes. Relation updates
reject the same edge. Owner repair removes already persisted typed routing edges
and invokes the parent's existing bounded, same-owner, duplicate-safe admission;
real task dependencies and pending human decisions still gate it. No upstream PR.
Upstream master f16c0ad5c818c627ac798ef5f31e266a6b256aac was fetched and inspected;
its createChild still unconditionally honors blockParentUntilDone and has no childPurpose.
Regression: legacy-continuation-authority.test.ts routing-child cases. The baseline
has five assertion failures and one genuine implementation-child pass. Deployment
and real-ticket acceptance must be recorded by the coordinated release owner.

Qualification: all 49 persisted authority tests passed in the cluster fixture; routing-edge removal is transactional and audited once. Recovery child discovery excludes typed routing children so it cannot recreate the deadlock. Explicit purpose avoids trusting issue prose. Pre-existing untyped children are not silently reclassified.

Routing parents use ordinary issue_blockers_resolved / normal_model wake routing, not issue_disposition_repair recovery-only presentation. Internal bounded episode authority is retained for dispatch safety and deduplication; this is not approval to replay unknown side effects. A failing-before wake-reason regression covers this distinction.
