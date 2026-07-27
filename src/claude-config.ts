import { homedir } from "node:os";
import { join } from "node:path";

export function defaultClaudeConfigDir(home = homedir()): string {
	return join(home, ".pi", "agent", "claude");
}

export function claudeChildEnv(
	claudeConfigDir: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
	extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
	return {
		...baseEnv,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		...extra,
		CLAUDE_CONFIG_DIR: claudeConfigDir,
	};
}
