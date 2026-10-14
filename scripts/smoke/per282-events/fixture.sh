#!/usr/bin/env bash
# Run on an approved cluster controller with kubectl/pnpm fixture prerequisites.
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
ns="per282-events-$(date +%s)-$$"
run="$ns"
uid=""
cleanup() {
  if [[ -n "$uid" ]] && [[ "$(kubectl get ns "$ns" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)" == "$uid" ]]; then
    kubectl delete namespace "$ns" --wait=true --timeout=120s
    if kubectl get ns "$ns"; then return 1; fi
    printf 'CLEANUP VERIFIED namespace=%s uid=%s absent\n' "$ns" "$uid"
  fi
}
trap cleanup EXIT INT TERM
kubectl create namespace "$ns"
uid=$(kubectl get ns "$ns" -o jsonpath='{.metadata.uid}')
kubectl label ns "$ns" luma.dev/ci-run="$run" luma.dev/ci-namespace-uid="$uid"
kubectl apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: pg
  namespace: $ns
  labels: {luma.dev/ci-run: "$run", luma.dev/ci-namespace-uid: "$uid"}
spec:
  restartPolicy: Never
  containers:
    - name: pg
      image: docker.io/library/postgres@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609
      env: [{name: POSTGRES_PASSWORD, value: synthetic-per282}]
      resources: {requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: "1", memory: 1Gi}}
      volumeMounts: [{name: data, mountPath: /var/lib/postgresql/data}]
  volumes: [{name: data, emptyDir: {}}]
---
apiVersion: v1
kind: Pod
metadata:
  name: runner
  namespace: $ns
  labels: {luma.dev/ci-run: "$run", luma.dev/ci-namespace-uid: "$uid"}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  containers:
    - name: runner
      image: ghcr.io/paperclipai/paperclip:2026.1005.0@sha256:de762433b50d56ed9180fef96a13fa236b37856c5c7a7718e8f19afe3d1e8670
      command: [sh, -c, sleep 3600]
      resources: {requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: "2", memory: 10Gi}}
YAML
kubectl wait -n "$ns" pod/pg pod/runner --for=condition=Ready --timeout=180s
ip=$(kubectl get pod -n "$ns" pg -o jsonpath='{.status.podIP}')
cd "$repo"
files=(server/src/services/live-events{,-transport}.ts server/src/realtime/live-events-ws.ts
  server/src/__tests__/live-events-{process-fixture.ts,transport.integration.test.ts,faults.integration.test.ts,transport.test.ts}
  packages/db/src/index.ts ui/src/context/LiveUpdatesProvider{.tsx,.test.ts})
# Include parent integration sources only when present in this checkout.
for file in server/src/index.ts server/src/routes/health.ts server/src/controller-drain.ts server/src/shutdown.ts server/src/services/run-history-query.ts server/src/routes/agents.ts server/src/services/heartbeat.ts server/src/services/run-admission.ts server/src/services/native-runtime/native-review-dispatch.ts; do
  [[ ! -f "$file" ]] || files+=("$file")
done
tar czf - "${files[@]}" | kubectl exec -i -n "$ns" runner -- sh -c 'cd /app && tar xzf -'
kubectl exec -n "$ns" runner -- sh -c "cd /app && LIVE_EVENTS_TEST_INTEGRATED_HEALTH=${LIVE_EVENTS_TEST_INTEGRATED_HEALTH:-0} LIVE_EVENTS_TEST_DATABASE_URL=postgres://postgres:synthetic-per282@$ip:5432/postgres pnpm --filter @paperclipai/server exec vitest run src/__tests__/live-events-transport.integration.test.ts src/__tests__/live-events-faults.integration.test.ts src/__tests__/live-events-transport.test.ts src/__tests__/live-events-ws.test.ts src/services/chat-publication-reconciliation.test.ts --maxWorkers=1"
kubectl exec -n "$ns" runner -- sh -c 'cd /app/server && pnpm exec tsc --noEmit'
kubectl exec -n "$ns" runner -- sh -c 'cd /app && pnpm --filter @paperclipai/ui exec vitest run src/context/LiveUpdatesProvider.test.ts && pnpm check:token-gates'
