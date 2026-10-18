# External liveness setup can retain ownership or stall sweeps

Independent review of PER-1010 found two candidate-only P1 defects. No deployment or production impact was established.

Observer configuration resolution occurred after lease renewal started but before its try/finally. A rejected lookup abandoned the renewing watcher. Configuration resolution in the sweep was outside the probe timeout; a never-settling resolver retained the scheduler single-flight indefinitely.

Correction: put all observer setup inside lease cleanup and apply the existing ten-second operation bound to configuration lookup in probe, observe and stop paths. A timed-out resolver cannot resume provider execution after it settles late.

Rule: acquire renewable ownership only inside a cleanup scope; bound dependencies before entering a globally single-flight job.

Regression tests: heartbeat-external-observer-integration.test.ts covers rejected and hung setup followed by observe-only recovery. heartbeat-external-liveness-db.test.ts covers a hung lookup, a subsequent unrelated deadline, and injected failure in the real finalization outbox transaction.

Release remains gated on exact-revision full validation, independent re-review, and the parent staging/mixed-version drain checks.

Dependency follow-up: an assembled PostgreSQL test showed unresolved blockers retained the relation but reduced the liveness wake to a skipped diagnostic. Recovery context was not available to the later dependency wake. Queue admission now defers the original liveness receipt for dependencies as well as pending cards. Outbox redelivery rechecks gates before promoting a saved liveness receipt; stranded-wake admission retains its idempotency key so the same checks still apply. Concurrent outbox redelivery must retain one receipt, and resolution must produce one successor with predecessor/outcomes-unknown context.

Rule: a gate may postpone recovery, never replace its durable intent with a diagnostic receipt.
