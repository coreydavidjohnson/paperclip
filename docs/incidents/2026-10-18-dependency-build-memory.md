# Dependency installation exceeded the builder memory boundary

## Scope and failure

PER-1033 is the dependency-recipe child of PER-1010. No production outage or
release acceptance is claimed. Base is exact fork candidate
`3e8c15877b12e9f56d891d589847487d25671687` on `task/per1009-run-liveness`.
Its original Dockerfile runs resolution-only installation followed by frozen
installation. The parent recorded pnpm exit 137 before release tests on this
revision and `323d9ecf`; a separate sequential deps-only attempt also failed.
The retained parent log is `~/tasks/per980/per1010-gate-3e8c158.log` on the
Home Lab desktop. At failure, reported container memory usage reached
6,442,450,944 bytes, working set 5,359,542,272 and RSS 4,810,960,896.

The selected Buildx handle was `k3s-buildkit-ubuntu`, pointing at
`buildkitd-86c9b8c74c-wdm44` in namespace `buildkit`, UID
`f3be70e4-fcd8-4574-a9c1-c7c9bddf72f5`. Live container limits were CPU `6`
and memory `6Gi`. The full BuildKit preflight passed. This is recorded
observation, not a permanent placement or resource contract.

## Discriminating diagnostic

A labeled, separate Docker context kept the candidate deps inputs but replaced
the install with a runtime probe. Node v24.22.0 reported 24 CPUs,
availableParallelism 24, total memory 75,977,781,248 bytes and
constrainedMemory 0. `/proc/self/cgroup` was `0::/`; `/sys/fs/cgroup/cpu.max`,
`memory.max` and `memory.events` were absent. Host discovery cannot establish
the allocation inside this OCI RUN.

Pinned pnpm 9.15.4 uses
`max(2, availableParallelism() - abs(PNPM_WORKERS || 0)) - 1` for workers.
A second labeled diagnostic changed only `PNPM_WORKERS=17` for the two
original install commands: six workers instead of 23. It completed the real
resolution plus frozen install, exit 0, RUN duration 114.9 seconds. This is
not a full gate pass. The worker allocation change is the discriminating
variable; OOM-kill counters for the failed RUN were not available, so exit
137 plus memory saturation is strong memory-boundary evidence, not direct
proof of a kernel OOM event. A builder-container cgroup read exposed a
different boundary and cannot qualify the failed executor's OOM count.

## Correction and verified result

The source-owned wrapper sizes workers to the smaller of whole allocated CPUs,
one worker per GiB, and pnpm's visible-CPU maximum (minimum one worker).
The memory ratio is a measured heuristic, not a memory reservation or a kernel
limit. It scales with the allocation; there is no global fan-out cap or new
serialization of independent work. Visible cgroup-v2 ancestor CPU quotas and
Node constrained memory clamp explicit inputs. Hidden limits require explicit
allocation inputs; there is no silent host-resource fallback.

The unmodified candidate Dockerfile deps target at implementation commit
`bd4db0734ec149cecbe58c7982793feafbe9d448` completed with exit 0 and RUN duration
111.2 seconds using both original install commands through the wrapper.
The two printed budgets were CPU 6, memory 6,442,450,944, visible CPUs 24,
workers 6 and PNPM_WORKERS 17. Kubelet stats were sampled throughout the run;
these are sampled aggregate builder-container values, not per-process peaks:

- container usage maximum: 6,434,500,608 bytes;
- container working-set maximum: 4,501,479,424 bytes;
- container RSS maximum: 3,331,981,312 bytes;
- 20 pod/container samples; memory accounting timestamps differ by scope.

Pod usage peaked at 6,512,926,720 bytes; the pod aggregate is not the container
limit measurement. Usage includes reclaimable cache. No claim is made that
six workers guarantee success with unrelated simultaneous builder load.

Commands (run from the assigned desktop through `ssh agents`, with the exact
committed source archived into `source.tar`):

```sh
export DOCKER_CONFIG=$HOME/.config/luma-buildx
python3 ~/tasks/per1010/ops-validation/scripts/buildkit-preflight.py k3s-buildkit-ubuntu --profile full --connection
docker buildx build --builder k3s-buildkit-ubuntu --platform linux/amd64 --progress plain --target deps --build-arg PAPERCLIP_BUILD_CPUS=6 --build-arg PAPERCLIP_BUILD_MEMORY_BYTES=6442450944 --output type=cacheonly - < source.tar
node --test scripts/pnpm-resource-budget.test.mjs
node scripts/check-docker-deps-stage.mjs
git diff --check
```

Tests were written and observed failing before implementation. Four focused
checks cover sizing, fractional/small/large allocations, malformed input,
ancestor quota selection, argument/exit propagation and Docker integration.
An independent GPT-6.1 Sol review found a quota-dependent test expectation;
the test now clamps its expected budget to detected limits. An intermediate
file-writing escape error produced a syntax failure and was corrected before
acceptance; it was not a passing run. Optional ssh2 crypto compilation reports
missing `make` but is explicitly optional and completes successfully; existing
unbuilt-workspace-bin warnings remain. No lifecycle script was disabled.

## Integration and remaining acceptance

Parent must integrate the local commits/bundle and propagate the actual selected
builder allocation as both build arguments wherever OCI RUN hides it. Read the
Buildx endpoint pod's live container limits; never use client-host resources.
For concurrent builds on a shared worker, assign each a share instead of
promising the whole worker repeatedly. Missing capacity enforcement or
allocation information is not permission to guess. `doc/DOCKER.md` documents
the contract. No infrastructure configuration, pod, host, grants or registry
publication was changed here. No branch was pushed.

Full workspace typecheck, test/build release gate, re-review, staging and
mixed-version rollout remain PER-1010 acceptance. A deps-stage success does not
approve release. BuildKit snapshots remain under its existing GC; no namespace,
service, runtime server or retained-volume workload was created.

Rule: detect or supply actual job allocations before sizing package-manager
workers. Revalidate the pnpm subtraction formula on a version upgrade. Keep
failed acceptance evidence when a later bounded run passes.

Final verification follow-up: the exact `ad026c0bcd53a4cc857324b56c88855ceb472fca`
archive passed the real deps target with the successful install layer cached
(the recipe and all deps-stage inputs were unchanged). A separate Node24
regression context initially omitted `/app/Dockerfile` and failed its structural
assertion with ENOENT; adding the committed Dockerfile as a read-only test input
corrected that diagnostic context. All four checks then passed on Node24.22.0,
and a direct read of installed pnpm9.15.4 confirmed the subtraction formula.
Neither diagnostic context is a release gate pass. The final documentation-only
follow-up leaves the dependency recipe unchanged.
