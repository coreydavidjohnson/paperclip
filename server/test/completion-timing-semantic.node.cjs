const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('both heartbeat finalization callbacks preserve the narrowed log handle', () => {
  const source = readFileSync(join(__dirname, '../src/services/heartbeat.ts'), 'utf8');
  // These complete blocks end immediately before the shared final-byte read.
  const blocks = [...source.matchAll(/if \(handle\) \{[\s\S]*?(?=\n\s*const finalLogBytes = logSummary\?\.bytes;)/g)]
    .map(match => match[0]).filter(block => block.includes('completionTiming.measure("log_finalize"'));
  assert.equal(blocks.length, 2, 'cover success and failure finalization');
  const storeSource = readFileSync(join(__dirname, '../src/services/run-log-store.ts'), 'utf8');
  const handleType = storeSource.match(/export interface RunLogHandle \{[^}]+\}/)?.[0].replace('export ', '');
  assert.ok(handleType, 'use the real log handle type');
  const dir = mkdtempSync(join(tmpdir(), 'completion-semantic-'));
  try {
    const file = join(dir, 'fixture.ts');
    const fixture = `type RunLogStoreType = "local_file";` + handleType + `
      declare const completionTiming: { measure<T>(stage: "log_finalize", op: () => Promise<T>): Promise<T> };
      declare const runLogStore: { finalize(handle: RunLogHandle): Promise<unknown> };
      declare const logger: { warn(...args: unknown[]): void };
      declare const runId: string;
      ${blocks.map((block, i) => `async function boundary${i}() {
        let handle: RunLogHandle | null = null;
        handle = await Promise.resolve({ store: "local_file", logRef: "fixture" } as RunLogHandle);
        let logSummary: unknown;
        ${block}
        handle = null;
      }`).join(' ')}
    `;
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      strict: true, noEmit: true, target: 'ES2022', types: [], skipLibCheck: true,
    }, files: [file] }));
    const compile = () => execFileSync('pnpm', ['exec', 'tsc', '--project', join(dir, 'tsconfig.json')], {
      cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000, stdio: 'pipe',
    });
    writeFileSync(file, fixture);
    assert.doesNotThrow(compile, 'the real callbacks must compile');
    // Prove the compiler still detects the original lost-narrowing regression.
    writeFileSync(file, fixture.replaceAll('finalize(logHandle)', 'finalize(handle)'));
    assert.throws(compile, error => error.status !== 0 && /TS2345/.test(String(error.stdout)), 'reject a mutable captured nullable handle');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
