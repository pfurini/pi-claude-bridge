#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ASSISTANT_ID = "msg_000000000000000000000001";
const ASSISTANT_UUID = "00000000-0000-4000-8000-000000000002";
const RESULT_UUID = "00000000-0000-4000-8000-000000000003";
const fakeVersion = process.env.FAKE_CLAUDE_VERSION ?? "0.0.0-fake";
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "success";

const DEFAULT_NATIVE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Workflow",
  "TaskCreate",
  "AskUserQuestion",
  "ToolSearch",
];

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseCsv(value) {
  return value?.split(",").filter(Boolean) ?? [];
}

const disallowedTools = new Set(parseCsv(argumentValue("--disallowedTools")));
const requestedTools = argumentValue("--tools");
const nativeTools = (requestedTools === ""
  ? []
  : requestedTools
    ? parseCsv(requestedTools)
    : DEFAULT_NATIVE_TOOLS
 ).filter((toolName) => !disallowedTools.has(toolName));

if (process.argv.includes("--version")) {
  process.stdout.write(`${fakeVersion} (Claude Code)\n`);
  process.exit(0);
}

function log(value) {
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(value)}\n`);
  }
}

function emit(value) {
  log({ direction: "out", value });
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respondToControlRequest(message) {
  emit({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: message.request_id,
      response: {
        commands: [],
        models: [],
        agents: [],
        account: null,
      },
    },
  });
}

let userReceived = false;
let conversationEmitted = false;
let sdkMcpServerName;
let mcpComplete = scenario !== "mcp";
let mcpTools = [];
let mcpToolResult;

function sendMcpMessage(requestId, message) {
  emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "mcp_message",
      server_name: sdkMcpServerName,
      message,
    },
  });
}

function startMcpHandshake() {
  sendMcpMessage("fake-mcp-initialize", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-claude-cli", version: fakeVersion },
    },
  });
}

function mcpResponse(message) {
  return message.response?.response?.mcp_response;
}

function handleMcpControlResponse(message) {
  const response = mcpResponse(message);
  switch (message.response?.request_id) {
    case "fake-mcp-initialize":
      sendMcpMessage("fake-mcp-initialized", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      break;
    case "fake-mcp-initialized":
      sendMcpMessage("fake-mcp-list", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      break;
    case "fake-mcp-list": {
      mcpTools = response?.result?.tools ?? [];
      const tool = mcpTools[0];
      if (!tool) {
        process.stderr.write("fake-claude: SDK MCP server advertised no tools\n");
        process.exitCode = 1;
        return;
      }
      const toolInput = JSON.parse(
        process.env.FAKE_CLAUDE_MCP_INPUT ??
          '{"message":"phase two","count":2,"enabled":true}',
      );
      sendMcpMessage("fake-mcp-call", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: tool.name, arguments: toolInput },
      });
      break;
    }
    case "fake-mcp-call":
      mcpToolResult = response?.result;
      mcpComplete = true;
      maybeEmitConversation();
      break;
  }
}

function emitSystemInit() {
  const customTools = mcpTools.map(
    (tool) => `mcp__${sdkMcpServerName}__${tool.name}`,
  );
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: SESSION_ID,
    tools: [...nativeTools, ...customTools],
    mcp_servers: sdkMcpServerName
      ? [{ name: sdkMcpServerName, status: mcpComplete ? "connected" : "pending" }]
      : [],
    model: "fake-claude",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: fakeVersion,
    output_style: "default",
    uuid: "00000000-0000-4000-8000-000000000000",
  });
}

function emitAssistantConversation(responseText) {
  emit({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id: ASSISTANT_ID,
        type: "message",
        role: "assistant",
        content: [],
        model: "fake-claude",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: responseText },
    },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
  emit({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
  emit({
    type: "stream_event",
    event: { type: "message_stop" },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
  emit({
    type: "assistant",
    message: {
      id: ASSISTANT_ID,
      type: "message",
      role: "assistant",
      model: "fake-claude",
      content: [{ type: "text", text: responseText }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 3 },
    },
    parent_tool_use_id: null,
    uuid: ASSISTANT_UUID,
    session_id: SESSION_ID,
  });
}

function emitSuccessResult(responseText) {
  emit({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: responseText,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 3 },
    modelUsage: {},
    permission_denials: [],
    uuid: RESULT_UUID,
  });
}

function emitTerminalError() {
  emit({
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    errors: ["offline terminal failure"],
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: RESULT_UUID,
  });
}

function maybeEmitConversation() {
  if (!userReceived || !mcpComplete || conversationEmitted) return;
  conversationEmitted = true;
  emitSystemInit();

  if (scenario === "abort") return;
  if (scenario === "unknown" || process.env.FAKE_CLAUDE_EMIT_UNKNOWN === "1") {
    emit({ type: "future_message", value: "ignored by current consumers" });
  }
  if (scenario === "terminal-error") {
    emitTerminalError();
    return;
  }

  const responseText =
    mcpToolResult?.content?.find((content) => content.type === "text")?.text ??
    process.env.FAKE_CLAUDE_RESPONSE ??
    "Fake Claude response";
  emitAssistantConversation(responseText);
  emitSuccessResult(responseText);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`fake-claude: invalid JSON input: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  log({ direction: "in", value: message });
  if (message.type === "control_response" && scenario === "mcp") {
    handleMcpControlResponse(message);
    return;
  }
  if (message.type === "control_request") {
    const isInitialize = message.request?.subtype === "initialize";
    if (isInitialize) {
      [sdkMcpServerName] = message.request.sdkMcpServers ?? [];
    }
    respondToControlRequest(message);
    if (isInitialize && scenario === "mcp") {
      if (!sdkMcpServerName) {
        process.stderr.write("fake-claude: MCP scenario requires an SDK MCP server\n");
        process.exitCode = 1;
      } else {
        startMcpHandshake();
      }
    }
    return;
  }
  if (message.type === "user") {
    userReceived = true;
    maybeEmitConversation();
  }
});
