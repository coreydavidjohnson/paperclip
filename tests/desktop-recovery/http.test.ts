import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
const token = 'isolated-test-only-token-not-a-production-secret';
const target = { companyId: '11111111-1111-4111-8111-111111111111', agentId: '22222222-2222-4222-8222-222222222222', desktop: 'desktop-home-lab', namespace: 'opensandbox', incidentIssueId: '33333333-3333-4333-8333-333333333333' };
const body = { version: 1, agent: 'home_lab', desktop: target.desktop, incidents: [] };
async function fixture(options = {}) {
  const module = await import('../../server/src/routes/desktop-recovery.js').catch(() => null);
  assert.ok(module?.desktopRecoveryRoutes, 'the dedicated desktop-recovery HTTP boundary must exist');
  const calls: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(module.desktopRecoveryRoutes({ token, targets: { home_lab: target }, resumeEnabled: false,
    handle: async (request: unknown, binding: unknown, enabled: boolean) => {
      calls.push({ request, binding, enabled });
      return { version: 1, agent: 'home_lab', desktop: target.desktop, recoveryId: null, notifications: [], resumes: [], resumeEnabled: enabled };
    }, ...options }));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  return { calls, close: () => new Promise<void>(resolve => server.close(() => resolve())),
    post: (value: unknown = body, headers: Record<string,string> = { 'X-Desktop-Recovery-Token': token }) => fetch(`http://127.0.0.1:${address.port}/api/internal/desktop-recovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) }) };
}
test('dedicated token accepts the bound request with resumes disabled', async () => {
  const f = await fixture();
  try { const response = await f.post(); assert.equal(response.status, 200);
    assert.equal((await response.json()).resumeEnabled, false);
    assert.deepEqual(f.calls, [{ request: body, binding: target, enabled: false }]);
  } finally { await f.close(); }
});
test('agent, board, run credentials and missing or wrong token fail closed', async () => {
  const f = await fixture();
  try {
    for (const headers of [{}, { Authorization: 'Bearer isolated-agent-key' }, { 'X-Desktop-Recovery-Token': 'wrong' },
      { 'X-Desktop-Recovery-Token': token, Authorization: 'Bearer isolated-agent-key' },
      { 'X-Desktop-Recovery-Token': token, 'X-Paperclip-Run-Id': target.agentId },
      { 'X-Desktop-Recovery-Token': token, Cookie: 'session=isolated-board-cookie' }]) {
      assert.equal((await f.post(body, headers)).status, 401);
    } assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('unconfigured or short dedicated token disables the endpoint', async () => {
  for (const configured of [undefined, '', 'short']) {
    const f = await fixture({ token: configured });
    try { assert.equal((await f.post()).status, 503); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});
test('wrong target, unknown fields, malformed incidents and stale Ready fail before service calls', async () => {
  const f = await fixture();
  try {
    const ready = { recoveryId: 'startup-pod-uid', batch: { namespace: 'opensandbox', name: target.desktop, uid: target.agentId, generation: 2, observedGeneration: 2 }, podUid: target.companyId };
    for (const value of [{ ...body, agent: 'other' }, { ...body, desktop: 'other' }, { ...body, companyId: target.companyId },
      { ...body, version: 2 }, { ...body, incidents: [{ id: 'x', reason: 'x', time: 'bad', involvedObject: {} }] },
      { ...body, ready: { ...ready, batch: { ...ready.batch, observedGeneration: 1 } } },
      { ...body, ready: { ...ready, batch: { ...ready.batch, namespace: 'other' } } }]) {
      assert.ok([400, 403].includes((await f.post(value)).status));
    } assert.equal(f.calls.length, 0);
    assert.equal((await f.post({ ...body, ready })).status, 200);
  } finally { await f.close(); }
});
test('Kubernetes apiVersion accepts a group/version and incidents return parent-compatible receipts', async () => {
  const f = await fixture();
  try {
    const payload = { ...body, incidents: [{ id: 'event-1', reason: 'Evicted', time: Date.now() / 1000,
      involvedObject: { apiVersion: 'sandbox.opensandbox.io/v1alpha1', kind: 'BatchSandbox', namespace: target.namespace, name: target.desktop, uid: target.agentId } }] };
    assert.equal((await f.post(payload)).status, 200);
  } finally { await f.close(); }
});
test('accepts the exact parent controller wire format, including null Ready', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post({ ...body, ready: null })).status, 200);
    assert.equal((await f.post({ ...body, incidents: [{ id: 'wire-event', reason: 'DesktopRecoveryStarted', time: Date.now() / 1000,
      involvedObject: { apiVersion: 'sandbox.opensandbox.io/v1alpha1', kind: 'BatchSandbox', namespace: target.namespace, name: target.desktop, uid: target.agentId } }],
      ready: { recoveryId: 'startup:owned-pod', batch: { namespace: target.namespace, name: target.desktop, uid: target.agentId, generation: 1, observedGeneration: 1 }, podUid: 'owned-pod' } })).status, 200);
  } finally { await f.close(); }
});
test('service authentication cannot fall through to the general local-trusted API', async () => {
  const module = await import('../../server/src/routes/desktop-recovery.js');
  assert.equal(typeof module.desktopRecoveryCredentialBoundary, 'function');
  const app = express();
  app.use(module.desktopRecoveryCredentialBoundary);
  app.use((_req, res) => res.json({ board: true }));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    for (const method of ['GET','PATCH']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/issues/isolated`, { method, headers: { 'X-Desktop-Recovery-Token': token } });
      assert.equal(response.status, 401);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('dedicated credential has a shared structured-log redaction rule', async () => {
  const { HTTP_LOG_REDACT_PATHS } = await import('../../server/src/middleware/http-log-redaction.js');
  assert.ok(HTTP_LOG_REDACT_PATHS.includes('req.headers["x-desktop-recovery-token"]'));
});
test('resume requires fresh explicit Ready observation time; incident-only mode keeps the old wire format', async () => {
  const f=await fixture({resumeEnabled:true});
  try {
    const ready={recoveryId:'freshness',batch:{namespace:target.namespace,name:target.desktop,uid:target.agentId,generation:1,observedGeneration:1},podUid:'owned-pod'};
    for (const observedAt of [undefined,Date.now()/1000-120,Date.now()/1000+120]) {
      assert.equal((await f.post({...body,ready:{...ready,...(observedAt===undefined?{}:{observedAt})}})).status,400);
    }
    assert.equal((await f.post({...body,ready:{...ready,observedAt:Date.now()/1000}})).status,200);
  } finally { await f.close(); }
});
