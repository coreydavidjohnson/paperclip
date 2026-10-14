#!/usr/bin/env bash
# Run on the authorized persistent desktop. All Kubernetes access stays on agents.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
NS=per282-attach-$(date +%s)-$$
TMP=$(mktemp -d)
ADAPTER_SOURCE=${ADAPTER_SOURCE:?point to home-owned services/paperclip/adapter}
k() { ssh -o ConnectTimeout=10 agents "GOMAXPROCS=1 kubectl -n $NS $*"; }
cleanup() {
  rc=$?
  if [ "$rc" != 0 ]; then for p in controller-a controller-b; do k "exec $p -- tail -80 /tmp/controller.log" || true; done; fi
  k 'delete namespace' "$NS" --wait=true --timeout=90s || true
  remaining=$(ssh agents "GOMAXPROCS=1 kubectl get namespace $NS --ignore-not-found -o name") || { echo "ERROR: cleanup verification failed" >&2; rc=1; remaining=unknown; }
  if [ -n "$remaining" ]; then
    echo "ERROR: fixture namespace remains/unverified: $NS" >&2; rc=1
  else echo "CLEANUP: namespace absent: $NS"; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
sed "s/per282-controller-78e0d9fb/$NS/g" "$ROOT/scripts/smoke/per282-controller/fixture.yaml" > "$TMP/fixture.yaml"
echo "---" >> "$TMP/fixture.yaml"
sed "s/per282-controller-78e0d9fb/$NS/g" "$ROOT/scripts/smoke/per282-controller/postgres.yaml" >> "$TMP/fixture.yaml"
k 'apply --validate=false -f -' < "$TMP/fixture.yaml"
k 'wait --for=condition=Ready pod --all --timeout=180s'
DB=$(k 'get pod database -o jsonpath={.status.podIP}')
A=$(k 'get pod controller-a -o jsonpath={.status.podIP}')
B=$(k 'get pod controller-b -o jsonpath={.status.podIP}')
tar -czf "$TMP/overlay.tgz" -C "$ROOT"  server/src/services/legacy-controller-lease.ts server/src/services/omnigent-attachment.ts server/src/services/omnigent-attachment.test.ts server/src/controller-drain.ts server/src/controller-drain.test.ts  server/src/services/run-admission.ts server/src/services/heartbeat.ts  server/src/services/run-history-query.ts server/src/index.ts server/src/shutdown.ts  server/src/routes/health.ts server/src/services/native-runtime/native-review-dispatch.ts  server/src/__tests__/fixtures/omnigent-controller-worker.ts server/src/__tests__/fixtures/omnigent-stub.ts server/src/__tests__/fixtures/omnigent-attach-exercise.ts  server/src/__tests__/fixtures/controller-exercise.ts  server/src/__tests__/fixtures/controller-faults.ts
tar -czf "$TMP/adapter.tgz" -C "$ADAPTER_SOURCE" src test package.json tsconfig.json
for pod in controller-a controller-b; do
  k "exec -i $pod -- tar -xzf - -C /app" < "$TMP/overlay.tgz"
  k "exec $pod -- mkdir -p /tmp/omnigent"
  k "exec -i $pod -- tar -xzf - -C /tmp/omnigent" < "$TMP/adapter.tgz"
  k "exec $pod -- ln -s /opt/paperclip-adapter-omnigent/node_modules /tmp/omnigent/node_modules"
done
k "exec -i controller-b -- sh" <<EOF2
cd /app
nohup node --import ./server/node_modules/tsx/dist/loader.mjs server/src/__tests__/fixtures/omnigent-stub.ts > /tmp/stub.log 2>&1 &
EOF2
k 'exec -i controller-a -- sh' <<EOF2
cd /app/server
node --import ./node_modules/tsx/dist/loader.mjs --input-type=module <<'JS'
import {applyPendingMigrations} from '@paperclipai/db';
await applyPendingMigrations('postgres://paperclip@$DB:5432/paperclip');
console.log('fixture migrations applied');
JS
EOF2
start() {
  pod=$1
  k "exec -i $pod -- sh" <<EOF2
node --input-type=module <<'JS'
import {readdirSync,readFileSync} from 'node:fs';
for (const pid of readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p))) {
 try {const c=readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0));
 if(c[0]==='node' && c[1]==='--import' && c[3]?.endsWith('omnigent-controller-worker.ts')) process.kill(Number(pid),'SIGTERM');}catch{}
}
JS
sleep 1
mkdir -p /tmp/home; chown node:node /tmp/home
cd /app
nohup gosu node env HOME=/tmp/home PAPERCLIP_AGENT_JWT_SECRET=per282-disposable-only PAPERCLIP_INSTANCE_ID=per282-canary OMNI_URL=http://$B:6767 NODE_ENV=development DATABASE_URL=postgres://paperclip@$DB:5432/paperclip node --import ./server/node_modules/tsx/dist/loader.mjs server/src/__tests__/fixtures/omnigent-controller-worker.ts > /tmp/controller.log 2>&1 &
EOF2
}
start controller-a; start controller-b
sleep 20
k "exec controller-a -- env DRAIN_GRACE_MS=${DRAIN_GRACE_MS:-250} CONTROLLER_A=$A CONTROLLER_B=$B node --import /app/server/node_modules/tsx/dist/loader.mjs /app/server/src/__tests__/fixtures/omnigent-attach-exercise.ts"
k "exec controller-a -- sh -c 'cd /tmp/omnigent && node --test --experimental-strip-types test/*.test.ts'"
k "exec controller-a -- sh -c 'cd /app/server && ../node_modules/.bin/vitest run src/services/omnigent-attachment.test.ts src/controller-drain.test.ts src/shutdown.test.ts --maxWorkers=1'"
k "exec controller-a -- sh -c 'cd /app/server && ../node_modules/.bin/esbuild src/services/heartbeat.ts src/services/omnigent-attachment.ts src/shutdown.ts --outdir=/tmp/transpile --platform=node --format=esm'"
