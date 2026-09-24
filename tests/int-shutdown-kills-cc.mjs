#!/usr/bin/env node
// The observer reads process identities outside the fence. Every inference process remains fenced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const file = fileURLToPath(import.meta.url);
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function worker(scenario) {
  assert.equal(process.env.PI_FENCE, '1', 'the inference worker must inherit a real fence');
  const root = mkdtempSync(join(tmpdir(), 'bridge-shutdown-'));
  const bin = join(root, 'bin');
  const agentDir = join(root, 'agent');
  mkdirSync(bin); mkdirSync(agentDir);
  const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));
  writeFileSync(join(bin, 'pi'), `#!/bin/sh\n[ "$PI_FENCE" = 1 ] || exit 2\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(agentDir, 'claude-bridge.json'), JSON.stringify({ startupNoticeShown: 'test', provider: { usageEvents: false, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR } }));
  const { createRpcHarness } = await import('./lib/rpc-harness.mjs');
  const harness = createRpcHarness({ name: `observer-${scenario}-${process.pid}`, args: ['-e', './tests/fixtures/slow-tool-extension.ts', '--model', 'claude-bridge/claude-haiku-4-5'], env: { PI_CODING_AGENT_DIR: agentDir }, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, defaultTimeout: 30000 });
  const lines = createInterface({ input: process.stdin });
  const input = lines[Symbol.asyncIterator]();
  const command = async expected => {
    const next = await input.next();
    assert.equal(next.value, expected);
  };
  try {
    await harness.startAndWait();
    const parked = harness.waitForEvent('tool_execution_start');
    await harness.send({ type: 'prompt', message: 'Call SlowTool exactly once with seconds=60.' });
    await parked;
    process.stdout.write(JSON.stringify({ stage: 'parked', piPid: harness.pi().pid }) + '\n');
    await command('terminate');
    if (scenario === 'abort') {
      const idle = harness.waitForEvent('agent_end');
      await harness.send({ type: 'abort' });
      await idle;
    } else {
      await harness.stop();
    }
    process.stdout.write(JSON.stringify({ stage: 'stopped' }) + '\n');
    await command('finish');
  } finally {
    await harness.stop();
    lines.close();
    process.stdin.pause();
  }
}

function processRows() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
}
function identity(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; }
  catch { return undefined; }
}
function claudeChildren(root) {
  const rows = processRows();
  const descendants = new Set([root]);
  for (let previous = -1; previous !== descendants.size;) {
    previous = descendants.size;
    for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
  }
  return rows.filter(row => descendants.has(row.pid) && basename(row.command) === 'claude').map(row => ({ pid: row.pid, identity: identity(row.pid) }));
}
const stillSameProcess = process => process.identity !== undefined && identity(process.pid) === process.identity;

async function observe(scenario) {
  processRows(); // Fail before spending quota if this observer cannot inspect processes.
  const child = spawn('pi', ['run', '--profile', 'general', '--with-credentials', '--', process.execPath, '--import', 'tsx', file, '--fenced-worker', scenario], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => { child.once('close', code => resolve(code)); child.once('error', () => resolve(-1)); });
  const stages = new Map();
  const waiters = new Map();
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const output = createInterface({ input: child.stdout });
  output.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.stage) { stages.set(message.stage, message); waiters.get(message.stage)?.(message); }
    } catch { /* The protocol ignores unrelated launcher notices. */ }
  });
  const stage = async name => {
    if (stages.has(name)) return stages.get(name);
    let timer;
    try {
      return await Promise.race([
        new Promise(resolve => waiters.set(name, resolve)),
        closed.then(code => { throw new Error(`worker exited ${code} before ${name}: ${stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}: ${stderr}`)), 45000); }),
      ]);
    } finally { clearTimeout(timer); waiters.delete(name); }
  };
  let tracked = [];
  try {
    const parked = await stage('parked');
    tracked = claudeChildren(parked.piPid);
    assert.ok(tracked.length, 'the real Claude process must exist while its MCP tool is parked');
    child.stdin.write('terminate\n');
    await stage('stopped');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && tracked.some(stillSameProcess)) await sleep(100);
    assert.ok(tracked.every(process => !stillSameProcess(process)), 'a tracked Claude process survived termination');
    if (scenario === 'abort') assert.ok(identity(parked.piPid), 'abort must leave Pi alive');
    child.stdin.end('finish\n');
    const shutdownTimer = setTimeout(() => child.kill('SIGTERM'), 10000);
    try { assert.equal(await closed, 0); } finally { clearTimeout(shutdownTimer); }
  } finally {
    for (const process of [...tracked, ...claudeChildren(child.pid ?? -1)]) {
      if (stillSameProcess(process)) { try { globalThis.process.kill(process.pid, 'SIGKILL'); } catch {} }
    }
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    output.close();
  }
}

if (process.argv.includes('--fenced-worker')) {
  await worker(process.argv.at(-1));
} else {
  for (const scenario of ['abort', 'shutdown']) {
    test(`${scenario} with a parked tool kills the real Claude child inside its inherited fence`, {
      skip: process.platform !== 'darwin' || process.env.PI_FENCE === '1' ? 'Run the observer outside the macOS fence; its inference worker remains fenced.' : false,
      timeout: 90000,
    }, () => observe(scenario));
  }
}
