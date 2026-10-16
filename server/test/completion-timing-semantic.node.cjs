const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('both heartbeat finalization callbacks preserve the narrowed log handle', () => {
  const source = readFileSync(join(__dirname, '../src/services/heartbeat.ts'), 'utf8');
  const ast = ts.createSourceFile('heartbeat.ts', source, ts.ScriptTarget.Latest, true);
  const blocks = [];
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'handle' &&
        node.thenStatement.getText(ast).includes('completionTiming.measure("log_finalize"')) {
      blocks.push(node.thenStatement.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(blocks.length, 2, 'cover success and failure finalization');
  const storeSource = readFileSync(join(__dirname, '../src/services/run-log-store.ts'), 'utf8');
  const storeAst = ts.createSourceFile('store.ts', storeSource, ts.ScriptTarget.Latest, true);
  const handleType = storeAst.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'RunLogHandle').getText(storeAst).replace('export ', '');
  const dir = mkdtempSync(join(tmpdir(), 'completion-semantic-'));
  try {
    const file = join(dir, 'fixture.ts');
    writeFileSync(file, `type RunLogStoreType = "local_file";` + handleType + `
      declare const completionTiming: { measure<T>(stage: "log_finalize", op: () => Promise<T>): Promise<T> };
      declare const runLogStore: { finalize(handle: RunLogHandle): Promise<unknown> };
      declare const logger: { warn(...args: unknown[]): void };
      declare const runId: string;
      ${blocks.map((block, i) => `async function boundary${i}() {
        let handle: RunLogHandle | null = null;
        handle = await Promise.resolve({ store: "local_file", logRef: "fixture" } as RunLogHandle);
        let logSummary: unknown;
        if (handle) ${block}
        handle = null;
      }`).join(' ')}
    `);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, types: [], skipLibCheck: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
