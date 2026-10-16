#!/usr/bin/env bash
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
NS=per475-recovery-$(date +%s)-$$
TMP=$(mktemp -d)
k() { ssh -o ConnectTimeout=10 agents "kubectl -n $NS $*"; }
cleanup() {
  rc=$?
  k "delete namespace $NS --wait=true --timeout=90s" || rc=1
  remaining=$(ssh agents "kubectl get namespace $NS --ignore-not-found -o name") || { rc=1; remaining=unknown; }
  test -z "$remaining" || rc=1
  echo "CLEANUP namespace=$NS remaining=${remaining:-absent}"
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
sed "s/per475-recovery-fixture/$NS/g" "$ROOT/scripts/smoke/per475-recovery/fixture.yaml" > "$TMP/fixture.yaml"
if [[ ${PER475_TYPECHECK:-0} == 1 ]]; then
  sed -i 's/memory: "512Mi"/memory: "8Gi"/; s/memory: "4Gi"/memory: "12Gi"/' "$TMP/fixture.yaml"
fi
k "apply --validate=false -f -" < "$TMP/fixture.yaml"
k "wait --for=condition=Ready pod/tests --timeout=180s"
tar -czf "$TMP/source.tgz" -C "$ROOT" server/src server/vitest.config.ts server/tsconfig.json tsconfig.base.json packages/shared/src packages/shared/tsconfig.json packages/db/src packages/db/tsconfig.json packages/adapter-utils/src packages/adapter-utils/tsconfig.json
k "exec -i tests -- tar -xzf - -C /app" < "$TMP/source.tgz"
k "exec tests -- sh -c 'mkdir -p /tmp/test-home; chown node:node /tmp/test-home'"
if [[ ${PER475_TYPECHECK:-0} == 1 ]]; then
  k "exec tests -- gosu node env HOME=/tmp/test-home NODE_OPTIONS=--max-old-space-size=10240 sh -c 'cd /app && pnpm --filter @paperclipai/server exec tsc --noEmit'"
  exit
fi
k "exec tests -- gosu node env HOME=/tmp/test-home NODE_ENV=development sh -c 'cd /app/server && ../node_modules/.bin/vitest run src/__tests__/issue-recovery-actions.test.ts src/__tests__/disposition-repair.test.ts src/__tests__/legacy-continuation-authority.test.ts src/services/recovery/legacy-continuation.test.ts src/modules/wake-queue/adapters/postgres.test.ts src/modules/wake-queue/application/use-cases.test.ts --maxWorkers=1'"
