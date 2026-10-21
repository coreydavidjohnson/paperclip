# Keep retained run context off the hot read path

## Result and recommended minimum

Reuse the existing compact-context candidate on the current deployed fork base.
Do not delete wake or continuation fields when a run becomes terminal. First move
only the small read projection into the already-tested side table, leaving the
original snapshot intact. This is a hot-read-size repair, **not physical storage
reclamation**. A second, separately tested lossless payload split can follow if
remaining raw-snapshot readers still dominate. Do not start with pruning.

## Upstream check (22 October 2026)

Inspected upstream/master `341b622604b639b056fc58b10e2dd3312d40385c` and latest tag
`v2026.1012.0`, not just proposal status. Upstream's `heartbeat/task-context.ts`
constructs `executionContinuation` and `paperclipWake`; heartbeat.ts persists the
complete context. Its schema still stores context_snapshot as one JSONB column.
The inspected task preparation and lifecycle code do not offload these two keys
or remove them at run completion.

Upstream `4de6335c3bba6de631a469fddac6bc511f890aa7` (#16577) narrows the initial
agent-authentication projection; it does not reduce retained snapshot size or
solve the company-history extraction. `e9b6c4d44c1f8c1ab7d0146c92397fbcdb0fba26`
(#16278) supplies expression indexes and chat-query changes, not a payload split.
Both are on inspected master, neither is an ancestor of the latest tag. A broad
upgrade is not the minimum storage/read-path repair. No upstream submission.

## Live evidence and cautions

At 22:35 UTC the primary had 9,830 run rows, 616 MiB total relation size and
15 MiB heap. Aggregate stored context_snapshot datum size was 414 MiB;
runner_profile_json was about 3.7 MiB. Extracted wake values occupied 444 MiB
and continuation values 408 MiB **in their extracted representation**. These
numbers cannot be added to physical table size: extraction changes compression
and wake itself contains another continuation envelope.

A later read-only sample of the newest 100 rows had 14,202,186 logical JSON text
bytes, versus 1,656,389 after excluding those two top-level keys diagnostically.
Top-level and nested continuation envelopes were identical in only 91/100 rows.
Do not blindly substitute one for the other. Their messages, acknowledged
comment coverage, human responses and recovery provenance have control-plane
meaning. execution-continuation.ts explicitly reads a previous run's saved
messages to construct resumeDelta. Terminal status alone is not a safe expiry.

The current recovery projection additionally recomputes SHA-256 over the whole
snapshot, and includes the full paperclipWake. That is our current fork's read
shape, not evidence that every slow read is unchanged upstream. The compact list
candidate does not eliminate this recovery cost. Preserve its race check until
an equivalent stored fingerprint/version is maintained transactionally.

## Implementation and verification sequence

1. Retain the successfully built old candidate as evidence, not a deployable
   replacement for the newer recovery release. Integrate its compact sidecar,
   fixed keyset backfill and native equality/scale tests on fork base
   `12e3abaf98baa25ae58bf53dcc3f4d10594b6293`. Keep current timing and recovery code.
2. Use `heartbeat_run_list_context` for list/Attention/execution-summary fields.
   Insert/update triggers maintain projection and company identity in the same
   transaction. Missing backfill rows use exact original snapshot behavior.
   Retain the existing expression-index predicates. Never use a sidecar as an
   authorization grant or change JSON null/type/coercion behavior.
3. Create only the new table/trigger in the startup migration. Historical copy
   uses indexed ID batches of 100, skips existing sidecar rows before reading
   snapshots and cannot overwrite a newer trigger value. No generated columns,
   full-table rewrite, bulk UPDATE, VACUUM FULL, or production deletion.
4. Run the complete packaged tests/typecheck and production-sized PostgreSQL
   fixture on the merged exact source, then exact infrastructure CI. Because
   this adds schema/trigger/backfill behavior, use disposable staging and its
   PostSync canary; do not skip that database-specific check under the default
   source-only landing route. Verify teardown and normal Argo reconciliation.
5. Re-measure identical endpoint parameters with timeouts and payload bytes,
   same statistics reset/identity, database execution seconds/minute, CPU and
   throttling. Keep request-log observations separate from sequential samples
   and phone render acceptance. Recheck all required fields and company fences.
6. If recovery remains dominant, extend the same read model with a bounded
   recovery projection and an exact full-snapshot fingerprint, computed only
   when the snapshot changes. Prove stale-context rejection, JSON edge cases,
   concurrent updates and both fresh/existing-row migration behavior first.
   Do not silently replace the fingerprint with updated_at.

## Alternatives not chosen now

- **Full lossless offload:** preserve each original context in a run/company-
  bound cold table and hydrate it for dispatch, retries, raw detail and audit.
  Cut over readers before compacting the original column in small locked batches;
  compare reconstructed snapshots exactly, retain rollback data and test backup
  restore. More invasive than the existing read-sidecar; total DB size may grow
  during transition and ordinary vacuum does not return all space to the OS.
- **Prune terminal snapshots:** rejected without an explicit retention contract
  and approval for data deletion. Terminal runs are still recovery inputs.
- **More indexes:** not the first fix for reading/decompressing large values
  from already-selected rows. The saved recoveryActionId index candidate's CI
  failed an unrelated descendant-start test; it is not a green release receipt.

No live improvement or under-two-second phone acceptance is claimed by this plan.
