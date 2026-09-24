/**
 * Resolve the `pi` executable the integration suites spawn.
 *
 * `pi` on PATH may be the pi-fence launcher, which hands its child a constructed
 * environment and drops CLAUDE_BRIDGE_DEBUG and CLAUDE_BRIDGE_DEBUG_PATH. The
 * bridge then writes no debug log, and every assertion that greps the log fails
 * as if the query never ran. So the suites spawn the fork's CLI directly.
 *
 * Order: PI_BIN when set, else the sibling fork build at
 * ../pi/packages/coding-agent/dist/cli.js, else `pi` from PATH.
 * tests/lib/bash-setup.sh applies the same order for the shell suites.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FORK_CLI = resolve(DIR, "../pi/packages/coding-agent/dist/cli.js");

// A function, not a constant: rpc-harness.mjs loads .env.test after its imports run,
// and a PI_BIN set there must still win.
export function piBin() {
	return process.env.PI_BIN || (existsSync(FORK_CLI) ? FORK_CLI : "pi");
}
