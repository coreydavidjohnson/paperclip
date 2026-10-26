# PER-316 saved-direction scan starvation

## Verified cause

The shared stranded-wake sweep ordered deferred receipts by original request
age and always selected at most fifty. Normal admission correctly refused
fifty old requests held after an acknowledged operator Stop. Those same
requests nevertheless occupied every future scan. A valid later task message
never reached normal admission. This reproduces with supported Node 24.22.1
and real embedded PostgreSQL, not only with query mocks.

This proves a general starvation defect. It does not prove the entire historic
PER-1125 delay. The positive release/drain control worked despite a future
monitor, and historic selected-batch and lock evidence is incomplete. A foreign
checkout defect and stopped-task handoff repair remain separate ownership paths.
The product regression uses a valid same-task prior run, not a foreign checkout.

## Repair invariant

Treat the existing receipt `updatedAt` as a persisted last-attempt cursor for
this sweep. Select the same eligible rows with the same limit, ordered by last
attempt, original request time, then ID. Lock only selected wake rows with
`SKIP LOCKED`; stamp the complete selected batch using database statement time
and commit before calling any admission or provider callback. Every selected
path rotates, including generic wake errors, same-task deduplication and missing
interaction results. A restart preserves progress. Busy receipt rows do not
block the sweep, and joined task/company rows are not locked by this scan.

Rotation does not claim delivery. Concurrent or subsequent scans may revisit
an attempted receipt; existing transactional admission remains authoritative.
No eligibility predicate, Stop/recovery authority, approval, input, scope,
active-work gate, retry cap or request content is relaxed or discarded.

## Regression and release boundaries

`server/src/services/heartbeat/queue.test.ts` is part of the image gate. The
negative control restores the original current-production queue source and
must fail the new behavior assertions. The repaired source must pass all
existing queue tests plus real admission, sequential/concurrent fairness,
all-selected early-return rotation, deterministic ties, queue recreation, and
locked-row isolation. Full composition still needs semantic typecheck, image
gates, independent review and isolated runtime acceptance before production.

The composition starts from current production fork b47e08201e9b and merges the
previous tested PER-316 source a5fb7bea4ca4. Both history-delta and guarded-status
repair contracts remain present. Only the import list and additive patch ledger
conflicts needed manual resolution. No application deployment, lost-before-save
recovery qualification, latency target or historical queue replay is implied.
Automatic UI retries stay disabled.

The first combined semantic gate passed the database compiler but rejected the
new test fixture: it cast real services to mock-only shapes and inferred a
no-argument/undefined-return release mock. Runtime transpilation had hidden
those type errors. Keep the real service objects as real dependencies and type
the release mock to `HeartbeatQueueDependencies` while awaiting its real result.
Do not coerce through `unknown`, skip the compiler, or change production types
to accommodate the fixture. Retain the failed exact-revision receipt separately.

## Combined image-gate preflight failures

The original exact `bef26c7242e2` 72-file preflight failed with 2,345 tests
passing and three failures. Its final log, exit 1 and namespace cleanup remain
preserved. It is not a successful gate.

Two failures are traced fixture assumptions. The new fair-scan transaction
became the first transaction, so a blanket first-transaction fault no longer
exercised release promotion. Let the scan complete, then inject the promotion
failure and require exactly those two calls. Keep the deferred receipt and
fresh-service single-delivery assertions. The disposable tmpfs also changed
Git's ordinary-directory error into its filesystem-boundary diagnostic. In
only the known-local-path fixture, permit discovery across filesystems and
restore the prior setting in `finally`. Keep the strict production error
classifier, metadata-absence proof, board action and no-Sentry assertions.

The pending-question receipt failure did not reproduce in either isolated or
ordered stop-suite diagnostics. No cause or repair is claimed for that
intermittent result. Its assertion now includes the exact run's outbox state
on failure, without adding retries, sleeps or changing the assertion. The
full image gate must still run with this evidence in place. A focused selector
is not a full-suite result, and its intentionally unselected tests are reported
as such.


The corrected exact `57e983114b94` preflight passed all 2,348 tests in all 72
Dockerfile server-gate files, with zero skips, in 605.91 seconds. The original
failed run remains preserved. The pending-question case passed in this complete
run, but its original intermittent failure still has no established cause.
Keep its outbox diagnostic and do not describe a green repeat as a root-cause
repair. This pinned-runtime preflight is not an image build or live acceptance.
