import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { buildProviderQueryOptions } from "../src/sdk-options.js";
import {
  createSdkMessageState,
  reduceSdkMessage,
} from "../src/sdk-messages.js";
import { MCP_SERVER_NAME } from "../src/skills.js";
import { createToolServer } from "../src/mcp-server.js";

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

async function captureBundledSystemInit(provider = false) {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-sdk-init-"));
  const configDir = join(tempRoot, "config");
  const workspace = join(tempRoot, "workspace");
  mkdirSync(configDir);
  mkdirSync(workspace);
  const baseEnv = credentialFreeEnv({
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  const options = provider
    ? {
        ...buildProviderQueryOptions({
          cwd: workspace,
          baseEnv,
          claudeConfigDir: configDir,
          cliModel: "fake-claude",
          settingSources: [],
          strictMcpConfigEnabled: true,
        }),
        persistSession: false,
      }
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

  it("delivers partial text events through provider-built options", {
    timeout: 10_000,
  }, async () => {
    const options = buildProviderQueryOptions({
      cwd: process.cwd(),
      baseEnv: credentialFreeEnv(),
      claudeConfigDir: runtimeConfigDir,
      cliModel: "fake-claude",
      settingSources: [],
      claudeExecutable: fakeClaude,
      strictMcpConfigEnabled: true,
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
    const options = buildProviderQueryOptions({
      cwd: process.cwd(),
      baseEnv: credentialFreeEnv(),
      claudeConfigDir: runtimeConfigDir,
      cliModel: "fake-claude",
      settingSources: [],
      claudeExecutable: fakeClaude,
      strictMcpConfigEnabled: true,
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
    // The production server pairs calls to results by the tool_use id Claude
    // stamps in _meta, and never reads the arguments (pi validates and runs the
    // tool itself). The handler therefore sees the id, not the args.
    const server = createToolServer(MCP_SERVER_NAME, [
      {
        name: "phase2_echo",
        description: "Echoes validated Phase 2 input",
        inputSchema: typeBoxSchema,
        handler: async (toolCallId) => {
          calls.push(toolCallId);
          return {
            content: [{ type: "text", text: "phase two:2:true" }],
          };
        },
      },
    ]);

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
      assert.deepEqual(calls, ["fake-tool-use-1"]);
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

// Exact SDK pins keep executable and offline contract assertions synchronized.
const TARGET_AGENT_SDK_VERSION = "0.3.284";
const TARGET_CLAUDE_CODE_VERSION = "2.1.284";

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

  it("reports the selected bundled Claude Code inventory without credentials", {
    timeout: 30_000,
  }, async () => {
    const init = await captureBundledSystemInit();
    assert.ok(init);

    assert.equal(init.claude_code_version, agentSdkMetadata().claudeCodeVersion);
    assert.equal(init.claude_code_version, TARGET_CLAUDE_CODE_VERSION);
    // Probe the inventories instead of inferring tool availability from SDK type declarations.
    for (const transitionalName of ["Agent", "RemoteTrigger"]) {
      assert.ok(
        !init.tools.includes(transitionalName),
        `target inventory should not expose legacy ${transitionalName}`,
      );
    }

    // The provider runs Claude Code with tools: [], so the model reaches pi's tools over MCP only.
    // Pin the whole native inventory empty rather than the names we thought to list.
    const providerInit = await captureBundledSystemInit(true);
    assert.ok(providerInit);
    const nativeTools = providerInit.tools.filter((tool) => !tool.startsWith("mcp__"));
    assert.deepEqual(nativeTools, [], `the provider path exposed native tools: ${nativeTools.join(", ")}`);
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
