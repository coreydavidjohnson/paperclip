# External liveness setup can retain ownership or stall sweeps

Independent review of PER-1010 found two candidate-only P1 defects. No deployment or production impact was established.

Observer configuration resolution occurred after lease renewal started but before its try/finally. A rejected lookup abandoned the renewing watcher. Configuration resolution in the sweep was outside the probe timeout; a never-settling resolver retained the scheduler single-flight indefinitely.

Correction: put all observer setup inside lease cleanup and apply the existing ten-second operation bound to configuration lookup in probe, observe and stop paths. A timed-out resolver cannot resume provider execution after it settles late.

Rule: acquire renewable ownership only inside a cleanup scope; bound dependencies before entering a globally single-flight job.

Regression tests: heartbeat-external-observer-integration.test.ts covers rejected and hung setup followed by observe-only recovery. heartbeat-external-liveness-db.test.ts covers a hung lookup, a subsequent unrelated deadline, and injected failure in the real finalization outbox transaction.

Release remains gated on exact-revision full validation, independent re-review, and the parent staging/mixed-version drain checks.
