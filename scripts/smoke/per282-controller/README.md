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
- Ordinary and comment claims share a PostgreSQL transaction-scoped nonblocking
  advisory agent lock and authoritative running-count check. Existing timer
  CAS/routine claims and per-run boot leases remain the fences; there is no
  second global leader lease. Hash collisions defer unrelated admission safely.
- Native runner-owned work is not requeued by the legacy suppression-release
  path. Same-host hot restart is not cross-pod transfer; signal shutdown no
  longer invokes the interrupting hot-restart preparation/drain helper.

## Scope after PER-980

This drain bounds turn completion and fences admission only. Ending or
re-attaching external runs whose controller is gone belongs to the PER-966
run-liveness worker, not to this patch.
