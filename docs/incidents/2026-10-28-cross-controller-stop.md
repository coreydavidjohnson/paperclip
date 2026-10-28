# Cross-controller Stop after runtime extraction

## Failure and scope

The historical PER-1108 owner-Stop fix was not on the cancellation path of the
current PER-316/PER-626 source. A request on another controller could not reach
the original execution owner. Restart observation also lacked the local control
registration needed to interrupt the original saved provider handle. An earlier
requested result snapshot could overwrite acknowledged termination proof.

This source-only port is based on PER-626 commit
`f730ffbd0ae5523ae8acf5612d2c1d6c307ac84a`. It does not replace that owner's
completed image, repeat staging, change production replicas, or authorize a
restart. The combined release stays on PER-316.

## Prevention contract

1. A foreign requester records Stop intent scoped to company, current controller
   boot and observer epoch. It never signals a requester-local PID for the run.
2. The original owner consumes only its matching intent through fenced lease
   renewal and uses the original saved handle. No new provider dispatch occurs.
3. Provider Stop does not stop lease renewal during settlement/copyback. A lost
   lease detaches observation and cannot establish provider termination.
4. An ownerless saved handle waits for its registered observer rather than taking
   a requester-local cancellation shortcut. Control registration and cleanup are
   paired; the check/set has no intervening await.
5. Terminal cancellation requires actual termination proof when the execution is
   externally controlled. Company/boot/epoch and proof compare-and-set conditions
   prevent stale owners or stale result snapshots from releasing the run.
6. Unknown termination remains pending/conflict. Preserve workspace recovery
   metadata, original Stop options, and native/budget cancellation fences.

## Evidence and retained failures

- Red source `ef96f1c00ef43e274986bfcbee2f2dd82e575d22` reproduced two product
  failures: no saved-intent consumption and overwritten acknowledgement.
- Corrected source `50ba11587e6b5d55a41f4f049237da00490f1556` passed all 63 tests
  across the run-control, lease and assembled external-observer suites.
- Independent Opus static review returned findings, not clean approval. The fix
  round added ownership/proof race fences, target-bound intent/options, continued
  renewal and no-proof/lease-loss observer tests. Its suggestion to change the
  public API to asynchronous 202 is not part of this narrow port. The existing
  bounded 60-second wait can still return pending 409.
- The first 4 GiB typecheck was OOMKilled. A correctly sized 12 GiB rerun passed
  DB types and found one server inference error on executionCancellation. The
  final source accesses that value through the existing parseObject guard.
- Final exact-source test/type receipts and the review response are retained in
  the PER-1108 handback. Disposable fixtures are removed by their owned helper.

## Release gates not satisfied by this document

This is not a clean independent review or a full repository build/test receipt.
PER-316 must compose the current source with its composer-409 and post-commit
wake-delivery fixes, obtain final review, and qualify the one combined release.
Production restart/Stop journeys, replica safety, database-load acceptance and
six consecutive scheduled sweeps remain live acceptance work on PER-1108.

## Route qualification follow-up: local ownership fixture mismatch

PER-316's composed-source check reproduced four 15-second route timeouts on
unchanged source `2b8ce80b298d724975fd2942f4a8c782ffbf7b18`, excluding its comment
delta as the cause. These were both owned-adapter HTTP handoff variants, client
disconnect between acknowledgement and settlement, and exact-approval interrupt.
The original failed receipt remains retained, SHA256
`7f9ee1f81014ff8a425728613abf731da2e250924a6b267a808ca4078204adfb`.

The fixtures contradicted their own ownership setup. The handoff helper registered
a local adapter execution control while stamping the run with a random foreign
controller boot. The approval-interrupt test spawned and registered a local
process but inherited a foreign boot from its shared queue fixture. The new Stop
fence correctly refused those process-local controls as authority for a foreign
owner and saved intent for the nonexistent owner instead. No owner could consume
that intent, so the route waited within its normal 60-second pending window and
the tests crossed their unchanged 15-second deadline.

Correction `2f89fbeec544884fb9a278a2b384f51b8d1f216b` imports the actual controller
boot UUID and stamps only these locally owned fixtures with it. It does not
change shared foreign-owner fixtures, production code, assertions, test names,
request ordering, Stop proof, settlement gates, deadlines or Vitest settings.
The existing foreign-controller tests still register stale local process/control
entries and require zero local interrupt or termination effects; these are the
negative controls against weakening the ownership fence.

The complete queued-comment route module and all three prior Stop modules are
run together for this correction, retaining the four original cases and the
63-check receipt as separate evidence. DB/server types are checked on the same
source. Final verdicts and disposable-cleanup receipts belong to the published
PER-1108 handback, not an inferred production acceptance claim.
