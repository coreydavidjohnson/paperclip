import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

async function fixture(intent) {
  const context = vm.createContext({ setTimeout, clearTimeout, setInterval, clearInterval, Date, AbortController });
  const noop = () => null;
  const exports = {
    'node:crypto': { randomUUID },
    'drizzle-orm': { and: noop, eq: noop, gt: noop, lte: noop, sql: noop },
    '@paperclipai/db': { heartbeatRuns: {} },
  };
  const source = await readFile(new URL('../server/src/services/legacy-controller-lease.ts', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), { context });
  await module.link(async name => {
    assert.ok(exports[name], `unexpected dependency ${name}`);
    const values = exports[name];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const db = {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'run' }] }) }) }),
    select: () => ({ from: () => ({ where: async () => [{ resultJson: intent }] }) }),
  };
  const run = { id: 'run', companyId: 'company', runtimeMode: 'legacy', status: 'running',
    controllerBootId: module.namespace.legacyControllerBootId,
    controllerLeaseExpiresAt: new Date(Date.now() + 60_000) };
  return { db, run, watch: module.namespace.watchLegacyControllerLease };
}

test('the lease owner sees saved Stop intent and coalesces concurrent renewal checks', async () => {
  const { db, run, watch } = await fixture({ executionCancellation: { state: 'requested' } });
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const lease = watch(db, run, controller, async () => { calls++; await pending; });
  try {
    await Promise.all([lease.assertOwned(), lease.assertOwned()]);
    assert.equal(calls, 1);
    assert.equal(controller.signal.aborted, false, 'intent must reach real Stop, not impersonate a lost lease');
  } finally { release(); lease.stop(); }
});

test('ordinary ownership renewal does not call Stop', async () => {
  const { db, run, watch } = await fixture({});
  let calls = 0;
  const lease = watch(db, run, new AbortController(), async () => { calls++; });
  try { await lease.assertOwned(); assert.equal(calls, 0); }
  finally { lease.stop(); }
});
