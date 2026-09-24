import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

it('charges each real resumed Claude query once rather than recharging saved session totals', {
  skip: process.env.CLAUDE_BRIDGE_LIVE !== '1', timeout: 120000,
}, async () => {
  assert.equal(process.env.PI_FENCE, '1');
  mkdirSync(resolve('.test-output'), { recursive: true });
  const root = mkdtempSync(resolve('.test-output/live-accounting-'));
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  const framesPath = join(root, 'sdk.jsonl');
  process.env.CLAUDE_BRIDGE_RECORD_STREAM = framesPath;
  process.env.CLAUDE_BRIDGE_DEBUG = '1';
  process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(root, 'bridge.log');
  process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, 'diagnostics.jsonl');
  writeFileSync(join(agentDir, 'claude-bridge.json'), JSON.stringify({ startupNoticeShown: 'test', provider: { usageEvents: false, claudeConfigDir: join(root, 'claude') } }));
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { loadExtensions } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const loaded = await loadExtensions([resolve('src/index.ts')], root, agentDir);
  assert.deepEqual(loaded.errors, []);
  const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  for (const registration of loaded.runtime.pendingProviderRegistrations) runtime.registerProvider(registration.name, registration.config);
  const model = runtime.getModel('claude-bridge', 'claude-haiku-4-5');
  const history = [];
  const charges = [];
  for (let turn = 1; turn <= 3; turn++) {
    history.push({ role: 'user', content: `Reply with exactly ACCOUNTING_${turn}.`, timestamp: Date.now() });
    const response = await runtime.completeSimple(model, { messages: history }, { sessionId: 'accounting-fixture', cwd: root, signal: AbortSignal.timeout(30000) });
    assert.equal(response.stopReason, 'stop', response.errorMessage);
    history.push(response);
    charges.push(response.usage.cost.total);
  }
  const results = readFileSync(framesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(frame => frame.type === 'result');
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map(frame => frame.session_id)).size, 1);
  let previous = 0;
  for (let index = 0; index < results.length; index++) {
    const cumulative = results[index].total_cost_usd;
    assert.ok(Math.abs(charges[index] - (cumulative - previous)) < 1e-10);
    previous = cumulative;
  }
  const charged = charges.reduce((sum, charge) => sum + charge, 0);
  assert.ok(Math.abs(charged - previous) < 1e-10);
  assert.doesNotMatch(readFileSync(join(root, 'bridge.log'), 'utf8'), /WARNING modelUsage != result\.usage/);
  writeFileSync(join(root, 'result.json'), JSON.stringify({ charges, charged, sdkCumulative: previous }, null, 2));
  console.log(`Resumed accounting evidence: ${root}`);
});
