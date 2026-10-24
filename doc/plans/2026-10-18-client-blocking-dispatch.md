# Client-blocking dispatch implementation plan

Goal: At the next free Home Lab slot, admit ready high/critical issues on an open client issue's dependency path before internal work; never preempt live work.

Architecture: Reuse native issue priorities, company agents, native blocks relations and existing claim gates. A recursive company-scoped query follows unresolved blockers from open issues owned by Co-Intelligence, Huron, AC Foods, AffirmedRx, Paragon or North Labs. UNION deduplicates cycles. A ready qualifying queued issue gains one ordering tier before the existing status/priority/FIFO order. No new scheduler, state, configuration, migration, cap or provider changes.

Alternatives: Raising the cap does not guarantee ordering; manual requeue is a temporary board-only workaround. Native priority alone cannot distinguish same-priority client paths.

1. Add a real-PostgreSQL heartbeat regression: one occupied slot, older critical in-progress internal ticket, newer high/critical transitive client blocker. Assert the active turn is unchanged and client blocker starts next. Run RED against exact production fork.
2. Add the smallest scoped query and ordering tier. Cover direct/transitive edges, cycles, closed/foreign/unassigned/nonclient paths and priority/readiness exclusion. Run GREEN plus dependency/claim tests in disposable cluster isolation.
3. Record upstream check and retirement criterion in PATCHES.md; independent review; exact fork semantic check and cluster image build using existing recipes.
4. Update homelab pin and immutable image on an exact-base worktree; incident, CI, isolated packaged staging with cleanup; push main, full Argo snapshot/deploy/resume and live verification. Never bypass hooks or replay unknown actions.
5. Link PER-685 (delivered admission/cap work) and PER-686 (original receipt fix), verify cap 20/resource decision, record durable lesson and final Paperclip disposition.

Base: fork 5e83e54912d227e126382b2008756312a42d1511, homelab dacb4c89274b8dcc10e6d2e929ec4bae24bf7280. Upstream master cfa9dce29 inspected before changes; no client dependency dispatch equivalent found. User explicitly authorizes this small ledgered fork patch in PER-689.
