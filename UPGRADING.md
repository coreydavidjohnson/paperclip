# Upgrade the Luma fork

1. Fetch `upstream` (paperclipai) and `origin` (our fork). Start a worktree on
   the new upstream commit: `git worktree add -b task/<ticket>-rebase <dir> upstream/master`.
   Keep the previous carry branch as the reference; never rewrite it.
2. Audit before applying: for each PATCHES.md entry, check upstream history
   for the same files and symptom (`git log <old-base>..upstream/master -- <files>`)
   and read the current upstream code. Record drop (upstream covers it, name the
   upstream commit) or carry (why it is still needed) in the ticket.
3. Cherry-pick carried commits in order with `-x`. Leave PATCHES.md,
   UPGRADING.md and Dockerfile out of each pick; rewrite them once at the end.
   When upstream reshaped the code, re-implement the patch on upstream's new
   structure rather than restoring the old code. Keep every new upstream
   authorization or visibility predicate (for example Attention `readCondition`
   and live-event `visibleEvent`).
4. Re-check projection allowlists against new upstream readers (PER-826 lean
   recovery: every `contextSnapshot`/`resultJson` key read in
   `recovery/service.ts`).
5. Run the image gate on the cluster builder:
   `docker buildx build --builder k3s-buildkit-dell --target luma-patch-tests -f Dockerfile .`
   It runs `pnpm -r typecheck`, token gates and every carried suite. Do not
   hide or skip failing tests.
6. Update PATCHES.md (base SHA, entries, removal conditions) and this file,
   push the branch to our fork only, and post the audit table on the ticket.
7. In a fresh homelab worktree from `origin/main`, update
   `services/paperclip/fork.lock.json` (repository, branch, commit,
   upstream_release, upstream_commit). The old `Fork.Dockerfile` overlay is
   pinned to the 2026.1005.0 dependency image and cannot compile a newer base;
   build from the fork's own `production` target instead.
8. Pin the image digest in production and staging manifests, run exact CI on
   the homelab candidate, stage it (`scripts/stage up paperclip --sha <sha>`),
   then promote with the scoped promoter. Verify Argo Synced/Healthy and the
   deployed digest. Never force-push homelab `main`.
9. Browser acceptance: on a Tests-project task with an OmniGenT agent, select a
   model and effort in the composer, run it, and confirm the OmniGenT session
   used them.

## Homelab coupling

- The preStop drain (PATCHES 5) is called from `k8s/paperclip/20-paperclip.yaml`;
  keep `terminationGracePeriodSeconds` above 130 s.
- Live events (PATCHES 6) need direct PostgreSQL or session-mode pooling;
  transaction-mode poolers cannot LISTEN.
- The OmniGenT adapter must build against this fork's adapter-utils
  (PATCHES 9).
- Homelab indexes and `jit: off` are deployment settings, not fork patches;
  compare them with upstream migrations on every upgrade.
