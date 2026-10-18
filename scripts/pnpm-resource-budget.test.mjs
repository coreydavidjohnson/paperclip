import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { pnpmBudget, cgroupCpuLimit } from './pnpm-resource-budget.mjs';
const script = new URL('./pnpm-resource-budget.mjs', import.meta.url);
function budget(cpus, memoryBytes, visibleCpus = 24) { return pnpmBudget(cpus, memoryBytes, visibleCpus); }

test('pnpm uses the allotted CPU and memory, not the host CPU count', () => {
  assert.equal(budget(6, 6 * 1024 ** 3).workers, 6);
  assert.equal(budget(6, 6 * 1024 ** 3).pnpmWorkers, 17);
  assert.equal(budget(24, 6 * 1024 ** 3).workers, 6);
  assert.equal(budget(24, 24 * 1024 ** 3).workers, 23);
  assert.equal(budget(0.5, 512 * 1024 ** 2).workers, 1);
  for (const value of ['NaN', '-1', '0', '6Gi']) {
    const result = spawnSync(process.execPath, [script.pathname, '--print'], {
      encoding: 'utf8', env: { ...process.env, PAPERCLIP_BUILD_CPUS: value,
        PAPERCLIP_BUILD_MEMORY_BYTES: String(6 * 1024 ** 3) },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /positive number/);
  }
});

test('both dependency installs use the budget without changing install semantics', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY scripts\/pnpm-resource-budget.mjs scripts\//);
  assert.match(dockerfile, /node scripts\/pnpm-resource-budget.mjs install --resolution-only --ignore-scripts --no-frozen-lockfile && node scripts\/pnpm-resource-budget.mjs install --frozen-lockfile/);
});

test('CPU detection takes the smallest visible ancestor quota', () => {
  const files = { '/proc/self/cgroup': '0::/pod/build',
    '/sys/fs/cgroup/pod/build/cpu.max': 'max 100000',
    '/sys/fs/cgroup/pod/cpu.max': '600000 100000',
    '/sys/fs/cgroup/cpu.max': '2400000 100000' };
  const read = (file) => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; };
  assert.equal(cgroupCpuLimit(read), 6);
  assert.equal(cgroupCpuLimit(() => { throw new Error('ENOENT'); }), undefined);
  files['/sys/fs/cgroup/pod/cpu.max'] = '50000 100000';
  assert.equal(cgroupCpuLimit(read), 0.5);
});

test('wrapper preserves arguments and pnpm failure status', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pnpm-budget-'));
  try {
    writeFileSync(path.join(dir, 'pnpm'), '#!/bin/sh' + String.fromCharCode(10) + 'printf "%s %s" "$PNPM_WORKERS" "$*"; exit 37', { mode: 0o755 });
    const result = spawnSync(process.execPath, [script.pathname, 'install', '--frozen-lockfile'], {
      encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH,
        PAPERCLIP_BUILD_CPUS: '6', PAPERCLIP_BUILD_MEMORY_BYTES: String(6 * 1024 ** 3) },
    });
    assert.equal(result.status, 37, result.stderr);
    const expected = pnpmBudget(Math.min(6, cgroupCpuLimit() || Infinity), Math.min(6 * 1024 ** 3, process.constrainedMemory?.() || Infinity));
    assert.equal(result.stdout, `${expected.pnpmWorkers} install --frozen-lockfile`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
