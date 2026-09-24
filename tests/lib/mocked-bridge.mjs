import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
export const stateKey = Symbol.for("claude-bridge:built-contract-probe");

// The factory and session importer stay real; only SDK transport and the MCP protocol envelope are replaced.
export function prepareBridge(root) {
	const bridge = join(root, "bridge");
	cpSync(join(repo, "src"), join(bridge, "src"), { recursive: true });
	writeFileSync(join(bridge, "package.json"), JSON.stringify({ type: "module" }));
	const stub = (name, files, exports) => {
		const dir = join(bridge, "node_modules", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports }));
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), content);
		}
	};
	stub("@anthropic-ai/claude-agent-sdk", { "index.js": readFileSync(join(repo, "tests/fixtures/mocked-bridge-sdk.mjs"), "utf8") }, "./index.js");
	stub("@modelcontextprotocol/sdk", {
		"server/mcp.js": "export class McpServer { constructor() { this.handlers = new Map(); this.server = { setRequestHandler: (schema, handler) => this.handlers.set(schema, handler) }; } }",
		"types.js": "export const ListToolsRequestSchema = 'tools/list'; export const CallToolRequestSchema = 'tools/call';",
	}, { "./server/mcp.js": "./server/mcp.js", "./types.js": "./types.js" });
	const sessionModule = JSON.stringify(import.meta.resolve("cc-session-io"));
	stub("cc-session-io", { "index.js": `export * from ${sessionModule}; import { createSession as create } from ${sessionModule}; export function createSession(options) { globalThis[Symbol.for('claude-bridge:built-contract-probe')].seeds++; return create(options); }` }, "./index.js");
	for (const name of ["change-case", "typebox", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		const target = join(bridge, "node_modules", name);
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(join(repo, "node_modules", name), target, "dir");
	}
	return join(bridge, "src/index.ts");
}
