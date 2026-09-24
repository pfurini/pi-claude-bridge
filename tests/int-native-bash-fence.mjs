import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildAskClaudeQueryOptions } from '../src/sdk-options.js';

it('native Bash uses the inherited temporary directory without gaining access to the fence secret', {
  skip: process.env.PI_FENCE !== '1', timeout: 60000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-native-fence-'));
  const command = 'printf NATIVE_BASH_OK; if [ -r "$HOME/.pi-fence/canary-secret" ]; then printf EXPOSED; else printf DENIED; fi';
  const options = buildAskClaudeQueryOptions({ cwd: root, baseEnv: process.env, claudeConfigDir: join(root, 'claude'), cliModel: 'claude-haiku-4-5', mode: 'full', isolated: true, settingSources: [] });
  assert.equal(options.env.CLAUDE_CODE_TMPDIR, process.env.CLAUDE_CODE_TMPDIR || process.env.TMPDIR);
  const q = query({ prompt: `Call Bash exactly once with this command, then report its output: ${command}`, options: { ...options, tools: ['Bash'], maxTurns: 2 } });
  const timer = setTimeout(() => q.close(), 45000);
  const calls = [];
  const results = [];
  try {
    for await (const message of q) {
      if (message.type === 'assistant') calls.push(...message.message.content.filter(block => block.type === 'tool_use'));
      if (message.type === 'user') results.push(...message.message.content.filter(block => block.type === 'tool_result'));
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'Bash');
    assert.equal(calls[0].input.command, command, 'the real shell must execute the access check, not merely echo a denial');
    assert.equal(results.length, 1);
    assert.ok(!results[0].is_error, JSON.stringify(results[0].content));
    assert.match(JSON.stringify(results[0].content), /NATIVE_BASH_OKDENIED/);
    assert.doesNotMatch(JSON.stringify(results[0].content), /EXPOSED/);
  } finally {
    clearTimeout(timer);
    q.close();
    rmSync(root, { recursive: true, force: true });
  }
});
