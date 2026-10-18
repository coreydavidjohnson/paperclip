#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

export function pnpmBudget(cpus, memoryBytes, visibleCpus = availableParallelism()) {
  cpus = positive(cpus, 'PAPERCLIP_BUILD_CPUS');
  memoryBytes = positive(memoryBytes, 'PAPERCLIP_BUILD_MEMORY_BYTES');
  // pnpm 9.15.4: max(2, availableParallelism() - abs(PNPM_WORKERS)) - 1.
  // One GiB per worker is a sizing heuristic, not an enforced memory limit.
  const workers = Math.max(1, Math.min(visibleCpus - 1, Math.floor(cpus), Math.floor(memoryBytes / 1024 ** 3)));
  return { cpus, memoryBytes, visibleCpus, workers, pnpmWorkers: Math.max(0, visibleCpus - workers - 1) };
}

export function cgroupCpuLimit(read = (file) => readFileSync(file, 'utf8')) {
  let group;
  try { group = read('/proc/self/cgroup').split(String.fromCharCode(10)).find((line) => line.startsWith('0::'))?.slice(3); }
  catch { return undefined; }
  if (!group) return undefined;
  const root = '/sys/fs/cgroup';
  let dir = path.resolve(root, '.' + group);
  const limits = [];
  while (dir === root || dir.startsWith(root + '/')) {
    let text;
    try { text = read(path.join(dir, 'cpu.max')); } catch { /* A namespace can hide ancestors. */ }
    if (text) {
      const [quota, period] = text.trim().split(/\s+/);
      if (quota !== 'max') limits.push(positive(quota, 'cpu.max quota') / positive(period, 'cpu.max period'));
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return limits.length ? Math.min(...limits) : undefined;
}

function main() {
  const detectedCpus = cgroupCpuLimit();
  const detectedMemory = process.constrainedMemory?.();
  const requestedCpus = process.env.PAPERCLIP_BUILD_CPUS;
  const requestedMemory = process.env.PAPERCLIP_BUILD_MEMORY_BYTES;
  // BuildKit OCI RUN can expose host CPUs/memory and hide ALL cgroup files.
  // Never silently treat that host capacity as the build's allocation.
  if ((!requestedCpus && !detectedCpus) || (!requestedMemory && !detectedMemory)) {
    throw new Error('Build allocation is not visible; pass PAPERCLIP_BUILD_CPUS and PAPERCLIP_BUILD_MEMORY_BYTES from the builder allocation');
  }
  const cpus = Math.min(positive(requestedCpus || detectedCpus, 'PAPERCLIP_BUILD_CPUS'), detectedCpus || Infinity);
  const memoryBytes = Math.min(positive(requestedMemory || detectedMemory, 'PAPERCLIP_BUILD_MEMORY_BYTES'), detectedMemory || Infinity);
  const budget = pnpmBudget(cpus, memoryBytes);
  if (process.argv[2] === '--print') { console.log(JSON.stringify(budget)); return; }
  console.error('pnpm resource budget: ' + JSON.stringify(budget));
  const result = spawnSync('pnpm', process.argv.slice(2), {
    stdio: 'inherit', env: { ...process.env, PNPM_WORKERS: String(budget.pnpmWorkers) },
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
