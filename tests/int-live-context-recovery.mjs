import { it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { openSession } from 'cc-session-io';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The fixture keeps tool effects and bridge diagnostics in a disposable directory.
it('recovers real SDK queries after active history and tool changes without replaying completed effects', {
  skip: process.env.CLAUDE_BRIDGE_LIVE !== '1', timeout: 360000,
}, async () => {
  const cases = (process.env.CLAUDE_BRIDGE_LIVE_CASES ?? 'replace,omit,remove,add,schema,skill-followup,skill-steer,instructions,custom-instructions,rules-instructions,addendum-instructions,forced-instructions,checkpoint-chain,fault-startup,fault-cancel,fault-timeout').split(',');
  if (cases.length > 1) {
    // Separate processes isolate skill instructions, registries, and Claude session ownership.
    for (const kind of cases) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', fileURLToPath(import.meta.url)], {
        env: { ...process.env, CLAUDE_BRIDGE_LIVE_CASES: kind }, encoding: 'utf8', timeout: 90000,
      });
      console.log(`Recovery case ${kind}:\n${child.stdout ?? ''}`);
      assert.equal(child.status, 0, `${kind}: ${child.stderr ?? ''}`);
    }
    return;
  }
  const { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, createSyntheticSourceInfo } = await import('@earendil-works/pi-coding-agent');
  const { getCurrentTools } = await import('@earendil-works/pi-ai');
  mkdirSync(resolve('.test-output'), { recursive: true });
  const root = mkdtempSync(resolve('.test-output/live-recovery-'));
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  const authProfile = process.env.CLAUDE_BRIDGE_LIVE_AUTH_PROFILE;
  // Only checkpoint-chain may use an existing profile; fault-startup replaces its profile path.
  if (authProfile && cases[0] !== 'checkpoint-chain') throw new Error('An existing Claude profile is only supported for checkpoint-chain');
  const claudeDir = authProfile ?? join(root, 'claude');
  const debugPath = join(root, 'bridge.log');
  process.env.CLAUDE_BRIDGE_DEBUG = '1';
  process.env.CLAUDE_BRIDGE_DEBUG_PATH = debugPath;
  process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, 'diagnostics.jsonl');
  writeFileSync(join(agentDir, 'claude-bridge.json'), JSON.stringify({ startupNoticeShown: 'test', askClaude: { enabled: false }, provider: { usageEvents: false, plan: 'max', claudeConfigDir: claudeDir } }));
  const effects = join(root, 'effects.jsonl');
  const manager = SessionManager.inMemory(root);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const errors = [];
  let current;
  let faultTimer;
  let api;
  let schemaChanged = false;
  const requests = [];
  const skillPath = join(root, 'SKILL.md');
  writeFileSync(skillPath, '---\nname: live-restriction\ndescription: Restrict the live fixture\ndisallowed-tools: [optional_probe]\n---\nDo not call tools. Reply with SKILL_RESTRICTION_OK.\n');
  const instructionMarker = `SKU_${Math.random().toString(36).slice(2)}`;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve('src/index.ts')],
    skillsOverride: () => ({ skills: [{ name: 'live-restriction', description: 'Restrict the live fixture', filePath: skillPath, baseDir: root, disableModelInvocation: false, sourceInfo: createSyntheticSourceInfo(skillPath, { source: 'test' }), frontmatter: { 'disallowed-tools': ['optional_probe'] } }], diagnostics: [] }),
    extensionFactories: [pi => {
      api = pi;
      pi.registerTool({ name: 'checkpoint_effect', label: 'Checkpoint effect', description: 'Append one disposable checkpoint and return its receipt. Call exactly once per requested checkpoint.', parameters: Type.Object({ marker: Type.String() }),
        execute: async (_id, params) => {
          current.executions++;
          if (current.executions > (current.kind === 'checkpoint-chain' ? 4 : 1)) { void session.abort(); throw new Error('A completed effect executed again'); }
          if (current.kind === 'checkpoint-chain') assert.equal(params.marker, current.nextMarker);
          appendFileSync(effects, JSON.stringify(params) + '\n');
          if (current.kind.startsWith('fault-') || current.kind === 'checkpoint-chain') manager.appendContextEdit(current.target, { content: `FAULT_REVISION_${current.executions}` });
          if (current.kind === 'fault-startup') {
            renameSync(join(root, 'claude'), join(root, 'saved-claude'));
            writeFileSync(join(root, 'claude'), 'The replacement profile path is deliberately a file.');
          }
          if (current.kind === 'checkpoint-chain') {
            if (current.executions === 4) return { content: [{ type: 'text', text: `COMPLETED ${params.marker}. All four checkpoints are complete. Do not call tools again. Reply exactly DONE_checkpoint-chain.` }], details: {} };
            current.nextMarker = `next_${Math.random().toString(36).slice(2)}`;
            return { content: [{ type: 'text', text: `COMPLETED ${params.marker}. Call checkpoint_effect exactly once with marker="${current.nextMarker}" next. Continue following this checkpoint sequence.` }], details: {} };
          }
          if (current.kind === 'replace') manager.appendContextEdit(current.target, { content: 'The current verification label is REPLACED_LABEL.' });
          if (current.kind === 'omit') manager.appendContextEdit(current.target, null);
          if (current.kind === 'remove') api.setActiveTools(['checkpoint_effect']);
          if (current.kind === 'add') api.setActiveTools(['checkpoint_effect', 'optional_probe']);
          if (current.kind === 'schema') schemaChanged = true;
          if (current.kind.startsWith('skill-')) await session.prompt('/skill:live-restriction apply now', { streamingBehavior: current.kind === 'skill-steer' ? 'steer' : 'followUp' });
          if (current.kind.endsWith('instructions')) return { content: [{ type: 'text', text: `COMPLETED ${params.marker}. Answer the inventory question using the current catalog. Do not repeat this completed checkpoint.` }], details: {} };
          if (current.kind === 'fault-cancel') return { content: [{ type: 'text', text: `COMPLETED ${params.marker}. Now count from 1 to 1000, one number per line.` }], details: {} };
          return { content: [{ type: 'text', text: `COMPLETED ${params.marker}. This effect is already recorded. Do not repeat it. Reply with DONE_${params.marker}.` }], details: { marker: params.marker } };
        },
      });
      pi.registerTool({ name: 'optional_probe', label: 'Optional probe', description: 'Unused declaration for tool inventory verification.', parameters: Type.Object({ oldField: Type.String() }), execute: async () => { throw new Error('The optional tool must not execute'); } });
      pi.on('context_with_system', event => {
        if (current?.kind.endsWith('instructions')) {
          const rule = `You label inventory. In the current catalog, the SKU for verification-item is ${current.executions ? instructionMarker : 'OLD_SKU'}. After the requested checkpoint, answer inventory questions with the current SKU alone.`;
          if (current.kind === 'forced-instructions') {
            const toolsAdded = getCurrentTools(event.messages);
            const history = event.messages.filter(message => message.role !== 'system');
            event.messages.splice(0, event.messages.length, { role: 'system', content: rule, toolsAdded, timestamp: Date.now() }, ...history);
          } else {
            const name = current.kind === 'instructions' ? 'project_context' : current.kind.split('-')[0];
            event.messages.push({ role: 'system', content: '', sections: { [name]: `<${name}>\n${rule}\n</${name}>` }, timestamp: Date.now() });
          }
        }
        if (current?.kind === 'fault-timeout' && current.executions && !current.deadlineSet) {
          current.deadlineSet = true;
          faultTimer = setTimeout(() => { void session.abort(); }, 30);
        }
        if (schemaChanged) {
          event.messages.push({ role: 'system', content: '', timestamp: Date.now(), toolsAdded: [{ name: 'optional_probe', description: 'Updated declaration.', parameters: { type: 'object', properties: { newField: { type: 'integer' } }, required: ['newField'] } }] });
        }
        requests.push({ kind: current?.kind, messages: structuredClone(event.messages), tools: getCurrentTools(event.messages) });
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  for (const registration of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(registration.name, registration.config);
  const model = runtime.getModel('claude-bridge', 'claude-haiku-4-5');
  assert.ok(model);
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, sessionManager: manager, resourceLoader: loader, modelRuntime: runtime, model, tools: ['checkpoint_effect', 'optional_probe'] });
  await session.bindExtensions({ mode: 'json', onError: error => errors.push(error) });
  const unsubscribe = session.subscribe(event => {
    if (current?.kind === 'fault-cancel' && current.executions && !current.abortRequested && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      current.abortRequested = true;
      void session.abort();
    }
  });
  const evidence = [];
  try {
    for (const kind of cases) {
      schemaChanged = false;
      api.setActiveTools(kind === 'add' ? ['checkpoint_effect'] : ['checkpoint_effect', 'optional_probe']);
      const target = manager.appendMessage({ role: 'user', content: `The old verification label is OLD_${kind}.`, timestamp: Date.now() });
      current = { kind, target, executions: 0, nextMarker: kind };
      const before = readFileSync(debugPath, 'utf8').length;
      const requestStart = requests.length;
      const deadline = setTimeout(() => { void session.abort(); }, 60000);
      try {
        const after = kind.endsWith('instructions') ? 'After the checkpoint, what is the current SKU for verification-item? Reply with the SKU alone.' : kind === 'checkpoint-chain' ? 'Follow each next-marker instruction returned by checkpoint_effect. Never guess the next marker; wait for each receipt.' : kind === 'fault-cancel' ? 'After its receipt, count from 1 to 1000, one number per line.' : `After its completed receipt, reply exactly DONE_${kind}.`;
        await session.prompt(`Call checkpoint_effect exactly once with marker="${kind}". Do not call optional_probe. ${after}`);
      } finally { clearTimeout(deadline); clearTimeout(faultTimer); }
      const last = session.messages.findLast(message => message.role === 'assistant');
      const log = readFileSync(debugPath, 'utf8').slice(before);
      if (kind.startsWith('fault-')) {
        assert.equal(last?.stopReason, kind === 'fault-cancel' || kind === 'fault-timeout' ? 'aborted' : 'error', last?.errorMessage);
        assert.equal(current.executions, 1);
        assert.equal((log.match(/provider: restarting query #/g) ?? []).length, 1);
        assert.equal((log.match(/provider: fresh query model=/g) ?? []).length, kind === 'fault-startup' ? 1 : 2);
        if (kind === 'fault-startup') assert.match(last.errorMessage, /ENOTDIR|EEXIST|not a directory/);
        if (kind === 'fault-cancel') assert.equal(current.abortRequested, true);
        if (kind === 'fault-timeout') assert.equal(current.deadlineSet, true);
        evidence.push({ kind, executions: current.executions, stopReason: last.stopReason, error: last.errorMessage });
        writeFileSync(join(root, 'results.json'), JSON.stringify(evidence, null, 2));
        continue;
      }
      assert.equal(last?.stopReason, 'stop', last?.errorMessage);
      assert.ok(session.getLastAssistantText().trim(), 'the unattended continuation must return a nonempty answer');
      assert.equal(current.executions, kind === 'checkpoint-chain' ? 4 : 1);
      if (kind === 'checkpoint-chain') {
        assert.equal(session.getLastAssistantText().trim(), 'DONE_checkpoint-chain');
        assert.equal((log.match(/provider: restarting query #/g) ?? []).length, 4, log);
        assert.equal((log.match(/provider: fresh query model=/g) ?? []).length, 5, log);
      }
      if (kind.endsWith('instructions')) {
        assert.match(log, /historyChanged=false toolsChanged=false instructionsChanged=true/);
        assert.equal(session.getLastAssistantText().trim(), instructionMarker);
      }
      assert.equal((log.match(/provider: restarting query #1,/g) ?? []).length, kind === 'skill-followup' ? 0 : 1, log);
      if (kind !== 'checkpoint-chain') assert.doesNotMatch(log, /provider: restarting query #2,/);
      const continuation = requests.slice(requestStart).at(-1);
      assert.ok(continuation.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes(`COMPLETED ${kind}`)));
      const projectedUsers = JSON.stringify(continuation.messages.filter(message => message.role === 'user'));
      if (kind === 'replace') { assert.match(projectedUsers, /REPLACED_LABEL/); assert.doesNotMatch(projectedUsers, /OLD_replace/); }
      if (kind === 'omit') assert.doesNotMatch(projectedUsers, /OLD_omit/);
      if (kind !== 'skill-followup') {
        const resumed = [...log.matchAll(/syncResult: path=rebuild sessionId=([a-f0-9-]+)/g)].at(-1)?.[1];
        assert.ok(resumed, 'recovery must rotate and import a session');
        const imported = openSession({ sessionId: resumed, projectPath: root, claudeDir }).messages;
        assert.match(JSON.stringify(imported), new RegExp(`COMPLETED ${kind}`), 'the backend transcript must retain the completed receipt');
        const importedUsers = JSON.stringify(imported.filter(record => record.message?.role === 'user'));
        if (kind === 'replace') { assert.match(importedUsers, /REPLACED_LABEL/); assert.doesNotMatch(importedUsers, /OLD_replace/); }
        if (kind === 'omit') assert.doesNotMatch(importedUsers, /OLD_omit/);
      }
      if (kind === 'remove') assert.ok(!continuation.tools.some(tool => tool.name === 'optional_probe'));
      if (kind === 'add') assert.ok(continuation.tools.some(tool => tool.name === 'optional_probe'));
      if (kind === 'schema') assert.ok(continuation.tools.find(tool => tool.name === 'optional_probe').parameters.properties.newField);
      if (kind.startsWith('skill-')) {
        assert.ok(!continuation.tools.some(tool => tool.name === 'optional_probe'));
        assert.match(projectedUsers, /SKILL_RESTRICTION_OK/);
      }
      evidence.push({ kind, executions: current.executions, stopReason: last.stopReason, text: session.getLastAssistantText(), usage: last.usage });
      writeFileSync(join(root, 'results.json'), JSON.stringify(evidence, null, 2));
    }
    assert.deepEqual(errors, []);
    const receipts = readFileSync(effects, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(receipts.length, current.executions);
    assert.equal(new Set(receipts.map(receipt => receipt.marker)).size, current.executions);
  } finally {
    clearTimeout(faultTimer);
    unsubscribe();
    await session.abort();
    session.dispose();
    console.log(`Live recovery evidence: ${root}`);
  }
});
