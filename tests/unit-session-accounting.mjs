import { it } from 'node:test';
import assert from 'node:assert/strict';
import { newAccountingEpoch, queryAccounting } from '../src/session-accounting.js';

const frame = (cost, modelUsage, extra = {}) => ({ type: 'result', subtype: 'success', total_cost_usd: cost, modelUsage, usage: { input_tokens: 2, output_tokens: 3 }, ...extra });
const counters = (inputTokens, costUSD) => ({ inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD, contextWindow: 200000, canonicalModel: 'model' });

it('projects the measured three-query cumulative sequence without charging history again', () => {
  const cumulative = [0.003723, 0.007452, 0.011263];
  const expected = [0.003723, 0.003729, 0.003811];
  let baseline = newAccountingEpoch().snapshot;
  let charged = 0;
  for (let i = 0; i < cumulative.length; i++) {
    const result = queryAccounting(frame(cumulative[i], { model: counters((i + 1) * 10, cumulative[i]) }), baseline);
    assert.ok(Math.abs(result.message.total_cost_usd - expected[i]) < 1e-12);
    assert.equal(result.message.modelUsage.model.inputTokens, 10);
    assert.equal(result.message.modelUsage.model.contextWindow, 200000);
    assert.deepEqual(result.message.usage, { input_tokens: 2, output_tokens: 3 });
    baseline = result.snapshot;
    charged += result.message.total_cost_usd;
  }
  assert.ok(Math.abs(charged - cumulative.at(-1)) < 1e-12);
});

it('retains new subagent models but subtracts historical models', () => {
  const baseline = { totalCostUsd: 1, modelUsage: { old: counters(100, 1) } };
  const result = queryAccounting(frame(1.7, { old: counters(120, 1.2), child: counters(40, 0.5) }), baseline);
  assert.equal(result.message.modelUsage.old.inputTokens, 20);
  assert.equal(result.message.modelUsage.child.inputTokens, 40);
  assert.ok(Math.abs(result.message.total_cost_usd - 0.7) < 1e-12);
  assert.equal(baseline.modelUsage.old.inputTokens, 100);
});

it('rebuilds have independent zero baselines regardless of the reused UUID', () => {
  const old = newAccountingEpoch();
  old.snapshot = { totalCostUsd: 100 };
  const replacement = newAccountingEpoch();
  assert.equal(queryAccounting(frame(0.01), replacement.snapshot).message.total_cost_usd, 0.01);
  assert.equal(old.snapshot.totalCostUsd, 100);
});

it('does not adopt a regressed counter or a zeroed startup error as negative query spending', () => {
  const baseline = { totalCostUsd: 1 };
  for (const message of [frame(0.5), frame(0, {}, { subtype: 'error_during_execution', is_error: true }), frame(Number.NaN)]) {
    const result = queryAccounting(message, baseline);
    assert.equal(result.message.total_cost_usd, undefined);
    assert.equal(result.snapshot, undefined);
  }
});

it('captures valid failed-query spending but not zeroed failure accounting', () => {
  const failure = queryAccounting(frame(1.1, {}, { subtype: 'error_max_turns', is_error: true }), { totalCostUsd: 1 });
  assert.ok(Math.abs(failure.message.total_cost_usd - 0.1) < 1e-12);
  assert.equal(failure.snapshot.totalCostUsd, 1.1);
  assert.equal(queryAccounting(frame(0, {}, { subtype: 'error_during_execution' })).snapshot, undefined);
});

it('unknown historical model totals do not turn current cumulative models into query usage', () => {
  const result = queryAccounting(frame(2, { model: counters(200, 2) }), { totalCostUsd: 1 });
  assert.equal(result.message.modelUsage, undefined);
  assert.equal(result.snapshot.modelUsage.model.inputTokens, 200);
  assert.equal(queryAccounting(frame(3, { model: counters(230, 3) }), result.snapshot).message.modelUsage.model.inputTokens, 30);
});

it('copies checkpoints so later SDK mutation cannot rewrite the next query baseline', () => {
  const message = frame(1, { model: counters(10, 1) });
  const result = queryAccounting(message);
  message.modelUsage.model.inputTokens = 999;
  assert.equal(result.snapshot.modelUsage.model.inputTokens, 10);
});
