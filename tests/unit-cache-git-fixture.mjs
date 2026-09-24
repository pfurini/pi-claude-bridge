import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('a failed fixture git init stops even when bash errexit is suppressed by a conditional caller', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-git-init-failure-'));
  try {
    const source = readFileSync(new URL('./int-cache-git.sh', import.meta.url), 'utf8');
    const setup = source.match(/^setup_repo\(\) \{\n[\s\S]*?^\}/m)?.[0];
    assert.ok(setup);
    const result = spawnSync('bash', ['-c', `
      set -e
      git() { printf '%s\\n' "$*" >> "$REPO/calls"; return 1; }
      ${setup}
      if setup_repo; then exit 9; fi
    `], { env: { ...process.env, REPO: root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 1, 'no Git mutation may follow a failed init');
    assert.match(calls[0], /init -q$/);
    assert.equal(existsSync(join(root, 'seed.txt')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
