import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClaudeConfigDir } from "../../src/claude-config.js";

const require = createRequire(import.meta.url);

export function resolveBundledClaudeExecutable() {
	const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
	const scopeDir = dirname(sdkDir);
	const platform = process.platform;
	const arch = process.arch;
	const binary = platform === "win32" ? "claude.exe" : "claude";
	const packageNames = [
		`claude-agent-sdk-${platform}-${arch}`,
		`claude-agent-sdk-${platform}-${arch}-musl`,
	];

	for (const packageName of packageNames) {
		const executable = join(scopeDir, packageName, binary);
		if (existsSync(executable)) return executable;
	}
	throw new Error(
		`Could not find the bundled Claude Code executable for ${platform}-${arch}`,
	);
}

export function claudeAuthStatus(configDir = defaultClaudeConfigDir()) {
	const executable = resolveBundledClaudeExecutable();
	const result = spawnSync(executable, ["auth", "status"], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
		timeout: 15_000,
	});
	if (result.error) throw result.error;
	const output = result.stdout.trim();
	if (!output && result.status !== 0) {
		return { executable, status: { loggedIn: false, authMethod: "none" } };
	}
	try {
		return { executable, status: JSON.parse(output) };
	} catch {
		throw new Error(
			`Claude auth status failed with exit ${result.status}: ` +
				`${result.stderr.trim() || output}`,
		);
	}
}

export function assertClaudeAuthenticated(configDir = defaultClaudeConfigDir()) {
	const { executable, status } = claudeAuthStatus(configDir);
	if (status.loggedIn === true) return status;
	throw new Error(
		`Claude Code profile ${configDir} is not authenticated. Run:\n` +
			`env CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} ${JSON.stringify(executable)} auth login`,
	);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const status = assertClaudeAuthenticated(process.argv[2] || defaultClaudeConfigDir());
		console.log(`Claude authentication ready (${status.authMethod ?? "unknown"})`);
	} catch (error) {
		console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
