import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const sink of ['diagnostic', 'debug']) {
  it(`${sink} write failure preserves the original usage diagnostic and completed response`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'bridge-denied-log-'));
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', './tests/lib/setup.mjs', '--input-type=module', '-e', `
        process.env.CLAUDE_BRIDGE_DEBUG = ${JSON.stringify(sink === 'debug' ? '1' : '0')};
        process.env.CLAUDE_BRIDGE_DIAG_PATH = ${JSON.stringify(directory)};
        ${sink === 'debug' ? `process.env.CLAUDE_BRIDGE_DEBUG_PATH = ${JSON.stringify(directory)};` : ''}
        const { __test } = await import('./src/index.ts');
        const { QueryContext } = await import('./src/query-state.ts');
        const { driveConsumeQuery, loadFixture } = await import('./tests/lib/replay.mjs');
        const messages = loadFixture('text');
        const terminal = messages.find(message => message.type === 'result');
        terminal.usage.output_tokens += 17;
        const result = await driveConsumeQuery(__test.consumeQuery, QueryContext, messages);
        if (result.ctx.turnOutput.stopReason !== 'stop') throw new Error('logging replaced the successful response');
        console.log('RESPONSE_PRESERVED');
      `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15000 });
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /RESPONSE_PRESERVED/);
      assert.match(child.stderr, /reconcile_mismatch/);
      assert.match(child.stderr, /"delta"/);
      assert.match(child.stderr, /EISDIR/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
