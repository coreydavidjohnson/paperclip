#!/usr/bin/env bash
# Run on the authorized persistent desktop. All Kubernetes access stays on agents.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
NS=per282-controller-$(date +%s)-$$
TMP=$(mktemp -d)
k() { ssh -o ConnectTimeout=10 agents "GOMAXPROCS=1 kubectl -n $NS $*"; }
cleanup() {
  rc=$?
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
tar -czf "$TMP/overlay.tgz" -C "$ROOT"  server/src/controller-drain.ts server/src/controller-drain.test.ts  server/src/services/run-admission.ts server/src/services/heartbeat.ts  server/src/services/run-history-query.ts server/src/index.ts server/src/shutdown.ts  server/src/routes/health.ts server/src/services/native-runtime/native-review-dispatch.ts  server/src/__tests__/fixtures/controller-worker.ts  server/src/__tests__/fixtures/controller-exercise.ts  server/src/__tests__/fixtures/controller-faults.ts
for pod in controller-a controller-b; do k "exec -i $pod -- tar -xzf - -C /app" < "$TMP/overlay.tgz"; done
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
 if(c[0]==='node' && c[1]==='--import' && c[3]?.endsWith('controller-worker.ts')) process.kill(Number(pid),'SIGTERM');}catch{}
}
JS
sleep 1
mkdir -p /tmp/home; chown node:node /tmp/home
cd /app
nohup gosu node env HOME=/tmp/home NODE_ENV=development DATABASE_URL=postgres://paperclip@$DB:5432/paperclip node --import ./server/node_modules/tsx/dist/loader.mjs server/src/__tests__/fixtures/controller-worker.ts > /tmp/controller.log 2>&1 &
EOF2
}
start controller-a; start controller-b
sleep 20
k "exec controller-a -- env CONTROLLER_A=$A CONTROLLER_B=$B node --import /app/server/node_modules/tsx/dist/loader.mjs /app/server/src/__tests__/fixtures/controller-faults.ts"
start controller-a; start controller-b; sleep 20
k "exec controller-a -- env CONTROLLER_A=$A CONTROLLER_B=$B node --import /app/server/node_modules/tsx/dist/loader.mjs /app/server/src/__tests__/fixtures/controller-exercise.ts"
k "exec controller-a -- sh -c 'cd /app/server && ../node_modules/.bin/vitest run src/controller-drain.test.ts src/shutdown.test.ts src/__tests__/heartbeat-scheduling-suppression.test.ts --maxWorkers=1'"
