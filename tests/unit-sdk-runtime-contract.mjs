import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import {
  buildAskClaudeQueryOptions,
  getAskClaudeToolPolicy,
} from "../src/sdk-options.js";
import {
  createSdkMessageState,
  reduceSdkMessage,
} from "../src/sdk-messages.js";
import { MCP_SERVER_NAME } from "../src/skills.js";
import { typeBoxToolToSdkMcpTool } from "../src/typebox-to-zod.js";

const require = createRequire(import.meta.url);
const fakeClaude = fileURLToPath(
  new URL("./fixtures/fake-claude-cli.mjs", import.meta.url),
);
const runtimeConfigDir = join(tmpdir(), "claude-sdk-runtime-isolated");

function credentialFreeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    delete env[name];
  }
  return env;
}

async function runFakeQuery({
  scenario = "success",
  prompt = "offline contract prompt",
  options = {},
  useNativeToolInventory = false,
} = {}) {
  const queryOptions = {
    cwd: process.cwd(),
    settingSources: [],
    persistSession: false,
    maxTurns: 1,
    pathToClaudeCodeExecutable: fakeClaude,
    ...options,
    env: credentialFreeEnv({
      ...options.env,
      FAKE_CLAUDE_SCENARIO: scenario,
    }),
  };
  if (!useNativeToolInventory && !("tools" in options)) queryOptions.tools = [];

  const sdkQuery = query({ prompt, options: queryOptions });
  const messages = [];
  try {
    for await (const message of sdkQuery) messages.push(message);
  } finally {
    sdkQuery.close();
  }
  return messages;
}

function systemInit(messages) {
  return messages.find(
    (message) => message.type === "system" && message.subtype === "init",
  );
}

function terminalResult(messages) {
  return messages.find((message) => message.type === "result");
}

async function captureBundledSystemInit(mode) {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-sdk-init-"));
  const configDir = join(tempRoot, "config");
  const workspace = join(tempRoot, "workspace");
  mkdirSync(configDir);
  mkdirSync(workspace);
  const baseEnv = credentialFreeEnv({
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  const options = mode
    ? buildAskClaudeQueryOptions({
        cwd: workspace,
        baseEnv,
        claudeConfigDir: configDir,
        cliModel: "fake-claude",
        mode,
        settingSources: [],
        isolated: true,
      })
    : {
        cwd: workspace,
        env: baseEnv,
        settingSources: [],
        persistSession: false,
        strictMcpConfig: true,
        maxTurns: 1,
      };
  const sdkQuery = query({
    prompt: "offline initialization inventory",
    options,
  });
  try {
    for await (const message of sdkQuery) {
      if (message.type === "system" && message.subtype === "init") return message;
    }
    return undefined;
  } finally {
    sdkQuery.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("offline Agent SDK process contracts", () => {
  it("reports the Claude Code version and reduces a successful stream-json query", {
    timeout: 10_000,
  }, async () => {
    const messages = await runFakeQuery({
      options: {
        env: { FAKE_CLAUDE_RESPONSE: "offline contract response" },
      },
    });

    const init = systemInit(messages);
    assert.equal(init.claude_code_version, "0.0.0-fake");
    assert.equal(init.session_id, "00000000-0000-4000-8000-000000000001");

    const state = createSdkMessageState();
    for (const message of messages) reduceSdkMessage(state, message);
    assert.equal(state.systemInit.claudeCodeVersion, "0.0.0-fake");
    assert.deepEqual(state.systemInit.tools, []);
    assert.equal(state.streamedText, "offline contract response");
    assert.equal(state.assistantText, "offline contract response");
    assert.equal(state.result.subtype, "success");
    assert.equal(state.result.isError, false);
    assert.equal(state.result.text, "offline contract response");
  });

  it("delivers partial text events through AskClaude-built options", {
    timeout: 10_000,
  }, async () => {
    const options = buildAskClaudeQueryOptions({
      cwd: process.cwd(),
      baseEnv: credentialFreeEnv(),
      claudeConfigDir: runtimeConfigDir,
      cliModel: "fake-claude",
      mode: "read",
      settingSources: [],
      isolated: true,
      claudeExecutable: fakeClaude,
    });
    const messages = await runFakeQuery({
      options: { ...options, env: { ...options.env, FAKE_CLAUDE_RESPONSE: "partial response" } },
      useNativeToolInventory: true,
    });
    const state = createSdkMessageState();
    for (const message of messages) reduceSdkMessage(state, message);

    assert.ok(state.textDeltaCount > 0);
    assert.equal(state.streamedText, "partial response");
  });

  it("observes a partial tool start before its completed assistant block", {
    timeout: 10_000,
  }, async () => {
    const options = buildAskClaudeQueryOptions({
      cwd: process.cwd(),
      baseEnv: credentialFreeEnv(),
      claudeConfigDir: runtimeConfigDir,
      cliModel: "fake-claude",
      mode: "read",
      settingSources: [],
      isolated: true,
      claudeExecutable: fakeClaude,
    });
    const messages = await runFakeQuery({
      scenario: "tool-use",
      options,
      useNativeToolInventory: true,
    });
    const state = createSdkMessageState();
    let startedAt = -1;
    let completedAt = -1;
    let completedTool;
    for (const [index, message] of messages.entries()) {
      const reduced = reduceSdkMessage(state, message);
      if (reduced.toolUseStarted) startedAt = index;
      if (reduced.toolUsesCompleted?.length) {
        completedAt = index;
        [completedTool] = reduced.toolUsesCompleted;
      }
    }

    assert.ok(startedAt >= 0, "expected a streamed tool start");
    assert.ok(completedAt > startedAt, "tool start should precede the completed block");
    assert.deepEqual(completedTool, {
      id: "tool-fake-1",
      name: "Read",
      input: { file_path: "README.md" },
    });
  });

  it("connects an SDK MCP server, exposes its tool schema, and invokes it", {
    timeout: 10_000,
  }, async () => {
    const logDir = mkdtempSync(join(tmpdir(), "fake-claude-mcp-"));
    const logPath = join(logDir, "protocol.jsonl");
    const calls = [];
    const typeBoxSchema = Type.Object({
      message: Type.String({ description: "Message to echo" }),
      count: Type.Integer({ description: "Number of repetitions" }),
      enabled: Type.Optional(Type.Boolean({ description: "Enable the echo" })),
    });
    const server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: "1.0.0",
      alwaysLoad: true,
      tools: [
        typeBoxToolToSdkMcpTool(
          {
            name: "phase2_echo",
            description: "Echoes validated Phase 2 input",
            parameters: typeBoxSchema,
          },
          async (args) => {
            calls.push(args);
            return {
              content: [
                {
                  type: "text",
                  text: `${args.message}:${args.count}:${args.enabled}`,
                },
              ],
            };
          },
        ),
      ],
    });

    try {
      const messages = await runFakeQuery({
        scenario: "mcp",
        options: {
          env: { FAKE_CLAUDE_LOG: logPath },
          mcpServers: { [MCP_SERVER_NAME]: server },
        },
      });

      const init = systemInit(messages);
      assert.deepEqual(init.mcp_servers, [
        { name: MCP_SERVER_NAME, status: "connected" },
      ]);
      assert.ok(init.tools.includes(`mcp__${MCP_SERVER_NAME}__phase2_echo`));
      assert.deepEqual(calls, [
        { message: "phase two", count: 2, enabled: true },
      ]);
      assert.equal(terminalResult(messages).result, "phase two:2:true");

      const protocol = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const listResponse = protocol.find(
        ({ direction, value }) =>
          direction === "in" &&
          value.type === "control_response" &&
          value.response?.request_id === "fake-mcp-list",
      );
      const [advertisedTool] =
        listResponse.value.response.response.mcp_response.result.tools;
      assert.equal(advertisedTool.name, "phase2_echo");
      assert.equal(advertisedTool._meta["anthropic/alwaysLoad"], true);
      assert.equal(
        advertisedTool.inputSchema.properties.message.description,
        "Message to echo",
      );
      assert.deepEqual(
        new Set(advertisedTool.inputSchema.required),
        new Set(["message", "count"]),
      );
      assert.equal(
        advertisedTool.inputSchema.properties.enabled.type,
        "boolean",
      );
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("enforces the upgraded AskClaude read, full, and none tool policies", {
    timeout: 10_000,
  }, async (t) => {
    const inventories = {};
    for (const mode of ["read", "full", "none"]) {
      await t.test(mode, async () => {
        const options = buildAskClaudeQueryOptions({
          cwd: process.cwd(),
          baseEnv: credentialFreeEnv(),
          claudeConfigDir: runtimeConfigDir,
          cliModel: "fake-claude",
          mode,
          isolated: true,
          claudeExecutable: fakeClaude,
        });
        const messages = await runFakeQuery({
          options,
          useNativeToolInventory: true,
        });
        inventories[mode] = new Set(systemInit(messages).tools);
      });
    }

    for (const tool of ["Read", "Glob", "Grep"]) {
      assert.ok(inventories.read.has(tool), `read mode should expose ${tool}`);
    }
    for (const tool of ["Write", "Edit", "Bash"]) {
      assert.ok(!inventories.read.has(tool), `read mode should block ${tool}`);
    }

    for (const tool of [
      "Read",
      "Grep",
      "Glob",
      "Write",
      "Bash",
      "WebSearch",
      "Agent",
      "Task",
      "TaskCreate",
      "Workflow",
      "ReportFindings",
      "SendMessage",
    ]) {
      assert.ok(inventories.full.has(tool), `full mode should expose ${tool}`);
    }
    for (const tool of [
      "AskUserQuestion",
      "ToolSearch",
      "ScheduleWakeup",
      "RemoteTrigger",
    ]) {
      assert.ok(!inventories.full.has(tool), `all modes should block ${tool}`);
    }

    for (const tool of [
      "Skill",
      "Read",
      "Write",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "Agent",
      "Task",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
      "Workflow",
      "ReportFindings",
      "SendMessage",
    ]) {
      assert.ok(!inventories.none.has(tool), `none mode should block ${tool}`);
    }
    const nonePolicy = new Set(getAskClaudeToolPolicy("none").disallowedTools);
    for (const transitionalName of ["Agent", "RemoteTrigger"]) {
      assert.ok(
        nonePolicy.has(transitionalName),
        `none mode should retain transitional block for ${transitionalName}`,
      );
    }
  });

  it("surfaces a terminal error result without credentials", {
    timeout: 10_000,
  }, async () => {
    const messages = await runFakeQuery({ scenario: "terminal-error" });
    const state = createSdkMessageState();
    for (const message of messages) reduceSdkMessage(state, message);

    assert.equal(state.result.subtype, "error_during_execution");
    assert.equal(state.result.successful, false);
    assert.equal(state.result.isError, true);
    assert.equal(state.result.errorText, "offline terminal failure");
    assert.equal(
      state.result.sessionId,
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("rejects is_error even when the SDK result subtype is success", {
    timeout: 10_000,
  }, async () => {
    const messages = await runFakeQuery({ scenario: "success-is-error" });
    const state = createSdkMessageState();
    for (const message of messages) reduceSdkMessage(state, message);

    assert.equal(state.result.subtype, "success");
    assert.equal(state.result.successful, false);
    assert.equal(state.result.isError, true);
    assert.equal(state.result.terminalReason, "api_error");
    assert.equal(state.result.errorText, "offline success-subtype failure");
  });

  it("accepts an unknown future message without failing the query", {
    timeout: 10_000,
  }, async () => {
    const messages = await runFakeQuery({ scenario: "unknown" });
    const state = createSdkMessageState();
    for (const message of messages) reduceSdkMessage(state, message);

    assert.deepEqual(state.unknownMessageTypes, ["future_message"]);
    assert.equal(state.result.successful, true);
  });

  it("ignores additive init and result fields introduced by 2.1.220", {
    timeout: 10_000,
  }, async () => {
    // fast_mode_state / fast_mode_disabled_reason / capabilities are additive
    // members of already-known messages. The reducer must not parse or trip on
    // them while fast mode stays an unimplemented opt-in.
    const messages = await runFakeQuery({ scenario: "additive-fields" });
    const state = createSdkMessageState();
    for (const message of messages) reduceSdkMessage(state, message);

    const init = systemInit(messages);
    assert.equal(init.fast_mode_disabled_reason, "sdk_opt_in_required");
    assert.equal(terminalResult(messages).fast_mode_state, "off");

    assert.deepEqual(state.unknownMessageTypes, [], "additive fields must not register as unknown message types");
    assert.equal(state.result.successful, true);
    assert.equal(state.result.isError, false);
    assert.equal(state.systemInit.sessionId, init.session_id);
    assert.equal(state.systemInit.claudeCodeVersion, init.claude_code_version);
    // The parsed shape stays exactly the four documented fields.
    assert.deepEqual(
      Object.keys(state.systemInit).sort(),
      ["claudeCodeVersion", "mcpServers", "sessionId", "tools"],
    );
  });

  it("aborts an in-flight fake query", { timeout: 10_000 }, async () => {
    const abortController = new AbortController();
    const sdkQuery = query({
      prompt: "wait for abort",
      options: {
        abortController,
        cwd: process.cwd(),
        env: credentialFreeEnv({ FAKE_CLAUDE_SCENARIO: "abort" }),
        pathToClaudeCodeExecutable: fakeClaude,
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    });

    const messages = [];
    let thrown;
    try {
      for await (const message of sdkQuery) {
        messages.push(message);
        if (message.type === "system" && message.subtype === "init") {
          abortController.abort();
        }
      }
    } catch (error) {
      thrown = error;
    } finally {
      sdkQuery.close();
    }

    assert.ok(systemInit(messages), "the fake process should initialize before abort");
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /abort|terminated|signal/i);
    assert.equal(terminalResult(messages), undefined);
  });
});

async function captureExecutableSelection(pathToClaudeCodeExecutable) {
  const spawns = [];
  const sdkQuery = query({
    prompt: "executable selection",
    options: {
      cwd: process.cwd(),
      env: credentialFreeEnv(),
      tools: [],
      settingSources: [],
      persistSession: false,
      ...(pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable }
        : {}),
      spawnClaudeCodeProcess: (spawnOptions) => {
        spawns.push({
          command: spawnOptions.command,
          args: [...spawnOptions.args],
        });
        const isBundledSelection = pathToClaudeCodeExecutable === undefined;
        return spawn(
          isBundledSelection ? process.execPath : spawnOptions.command,
          isBundledSelection
            ? [fakeClaude, ...spawnOptions.args]
            : spawnOptions.args,
          {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      },
    },
  });

  const messages = [];
  try {
    for await (const message of sdkQuery) messages.push(message);
  } finally {
    sdkQuery.close();
  }
  return { messages, spawn: spawns[0] };
}

// Pinned target of the 2.1.220 / Opus 5 update. A dependency bump that moves
// either number must be a deliberate edit here, with the plan's verification
// re-run — not a silent drift.
const TARGET_AGENT_SDK_VERSION = "0.3.220";
const TARGET_CLAUDE_CODE_VERSION = "2.1.220";

function agentSdkMetadata() {
  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  return JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8"));
}

describe("Claude Code executable resolution", () => {
  it("bundles the pinned Agent SDK and Claude Code versions", () => {
    const metadata = agentSdkMetadata();
    assert.equal(metadata.version, TARGET_AGENT_SDK_VERSION);
    assert.equal(metadata.claudeCodeVersion, TARGET_CLAUDE_CODE_VERSION);
  });

  it("resolves the SDK's installed platform executable by default", {
    timeout: 15_000,
  }, async () => {
    const { messages, spawn: selected } = await captureExecutableSelection();
    assert.ok(systemInit(messages));
    assert.ok(existsSync(selected.command));
    assert.match(basename(selected.command), /^claude(?:\.exe)?$/);
    assert.match(
      selected.command,
      /@anthropic-ai[/\\]claude-agent-sdk-(?:darwin|linux|win32)-/,
    );

    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const metadata = JSON.parse(
      readFileSync(join(dirname(sdkEntry), "package.json"), "utf8"),
    );
    const version = spawnSync(selected.command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, new RegExp(metadata.claudeCodeVersion));
    assert.match(version.stdout, new RegExp(TARGET_CLAUDE_CODE_VERSION));
  });

  it("reports the selected bundled Claude Code inventory and policies without credentials", {
    timeout: 30_000,
  }, async () => {
    const init = await captureBundledSystemInit();
    assert.ok(init);

    assert.equal(init.claude_code_version, agentSdkMetadata().claudeCodeVersion);
    assert.equal(init.claude_code_version, TARGET_CLAUDE_CODE_VERSION);
    for (const tool of [
      "Task",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
      "Workflow",
      "ReportFindings",
      "SendMessage",
    ]) {
      assert.ok(init.tools.includes(tool), `target inventory should expose ${tool}`);
    }
    for (const transitionalName of ["Agent", "RemoteTrigger"]) {
      assert.ok(
        !init.tools.includes(transitionalName),
        `target inventory should not expose legacy ${transitionalName}`,
      );
    }

    const inventories = {};
    for (const mode of ["read", "full", "none"]) {
      const modeInit = await captureBundledSystemInit(mode);
      assert.ok(modeInit);
      inventories[mode] = new Set(modeInit.tools);
    }
    for (const tool of ["Read", "Grep", "Glob"]) {
      assert.ok(inventories.read.has(tool), `target read mode should expose ${tool}`);
    }
    for (const tool of ["Write", "Edit", "Bash"]) {
      assert.ok(!inventories.read.has(tool), `target read mode should block ${tool}`);
    }
    for (const tool of ["Read", "Grep", "Glob", "Write", "Bash", "Task", "Workflow"]) {
      assert.ok(inventories.full.has(tool), `target full mode should expose ${tool}`);
    }
    for (const tool of ["ToolSearch", "ScheduleWakeup"]) {
      assert.ok(!inventories.full.has(tool), `target full mode should block ${tool}`);
    }
    for (const tool of [
      "Skill",
      "Read",
      "Write",
      "Grep",
      "Glob",
      "Bash",
      "WebFetch",
      "WebSearch",
      "Task",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
      "Workflow",
      "ReportFindings",
      "SendMessage",
    ]) {
      assert.ok(!inventories.none.has(tool), `target none mode should block ${tool}`);
    }
  });

  it("honors pathToClaudeCodeExecutable for an external script", {
    timeout: 10_000,
  }, async () => {
    const { messages, spawn: selected } =
      await captureExecutableSelection(fakeClaude);
    assert.ok(systemInit(messages));
    assert.equal(selected.command, "node");
    assert.equal(selected.args[0], fakeClaude);
  });
});
