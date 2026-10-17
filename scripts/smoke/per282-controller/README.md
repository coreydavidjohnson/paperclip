# PER-282 controller exercise

Run `scripts/smoke/per282-controller/exercise.sh` from this fork on the
Home Lab authorized persistent desktop. Kubernetes commands run only via
`ssh agents`. The script creates a unique disposable namespace, uses pinned
Paperclip/PostgreSQL digests, applies migrations to a NEW ephemeral database,
overlays this worktree's sources, exercises two independent controller
processes, and traps namespace deletion. No production Services, PVCs,
Secrets, provider sessions, credentials, or canary agents are used.

The fixture calls the real heartbeat service, adapter process implementation,
PostgreSQL lease and admission SQL, reaper, and health routes. Assertions cover
simultaneous admission/timer claims, a foreign live owner during startup,
12-second process completion, finalizer successor suppression, one-way drain,
loopback-only preStop, deadline retention, a locked renewal and unreachable DB.
The expired OmniGenT test is seeded durable state, NOT an actual OmniGenT turn.
`/runs` is a fixture shared-DB read, NOT proof of production run-token routes.

## Operator integration contract (not deployed by this branch)

- readiness GET `/api/health/ready`: auth initialized, startup recovery ready,
  DB reachable within 2 seconds, and not draining. DB probe is single-flight.
- preStop exec sends POST to `http://127.0.0.1:3100/api/health/drain` (substitute
  configured HTTP port). The actual socket peer must be loopback. Do not route
  this endpoint through a same-pod loopback reverse proxy exposed publicly.
- First preStop or signal starts a one-way 120-second turn-completion deadline.
  HTTP/DB stay up during completion. Scheduler callbacks/admission are fenced;
  durable wakes are not discarded. Set Kubernetes termination grace longer
  than 130 seconds; signal exit has a further 10-second teardown allowance.
- An expired dispatched legacy OmniGenT run remains running at
  `awaiting_external_evidence`, retaining its agent slot and issue binding.
  Lease-loss detachment must not terminalize, clean up, or replay it.
- Ordinary and comment claims share a PostgreSQL transaction-scoped nonblocking
  advisory agent lock and authoritative running-count check. Existing timer
  CAS/routine claims and per-run boot leases remain the fences; there is no
  second global leader lease. Hash collisions defer unrelated admission safely.
- Native runner-owned work is not requeued by the legacy suppression-release
  path. Same-host hot restart is not cross-pod transfer; signal shutdown no
  longer invokes the interrupting hot-restart preparation/drain helper.

## Not yet accepted

This is a tested controller patch, not complete PER-282 acceptance. The isolated
provider-backed OmniGenT long-turn checkpoint/reattachment exercise and actual
production-router run-scoped token requests across both API pods have not been
performed. Retention is fail-closed, not automatic checkpoint recovery. A durable
same-run reconciler plus session/response/turn checkpoint proof is still needed
for a turn outliving grace, and retained runs require explicit reconciliation.
The 12-second process proves in-grace completion, not provider reattachment.

The full server `tsc --noEmit` attempt in a 4Gi disposable pod was killed with
exit 137, not a pass. Changed production modules transpiled with esbuild in the
cluster; full exact-SHA CI and immutable-image rebuild remain with integration.
The two fixtures are source overlays on a digest-pinned dependency image, not
new immutable application images. Event transport is intentionally untouched.
