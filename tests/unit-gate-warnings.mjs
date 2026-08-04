/**
 * diag/gate-warnings.mjs: fails an integration run on un-allowlisted bridge
 * WARNING:/BUG: lines, and passes when every warning is either absent or
 * explicitly allowlisted (scoped to the test's log name).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../diag/gate-warnings.mjs", import.meta.url));

function makeRun() {
	const dir = mkdtempSync(join(tmpdir(), "gate-warnings-test-"));
	const logDir = join(dir, ".test-output");
	execFileSync("mkdir", ["-p", logDir]);
	return { dir, logDir };
}
const line = (msg) => `[2026-08-04T00:00:00.000Z] [mod0] ${msg}`;
function runGate(logDir, allowlist) {
	const args = [SCRIPT, logDir];
	if (allowlist !== undefined) {
		const p = join(logDir, "..", "allow.txt");
		writeFileSync(p, allowlist);
		args.push("--allowlist", p);
	} else {
		args.push("--allowlist", join(logDir, "..", "missing.txt"));
	}
	try { return { code: 0, stdout: execFileSync("node", args, { encoding: "utf8" }) }; }
	catch (err) { return { code: err.status ?? 1, stdout: `${err.stdout ?? ""}` }; }
}

describe("gate-warnings", () => {
	it("passes when no bridge WARNING/BUG lines are present", () => {
		const { logDir } = makeRun();
		writeFileSync(join(logDir, "clean-debug.log"), [line("provider: fresh query"), line("usage: in=1 out=2")].join("\n"));
		const { code, stdout } = runGate(logDir);
		assert.equal(code, 0);
		assert.match(stdout, /OK: no un-allowlisted/);
	});

	it("fails and names the offending file, line, and message", () => {
		const { logDir } = makeRun();
		writeFileSync(join(logDir, "recon-debug.log"), [
			line("provider: fresh query"),
			line("WARNING: reconcile mismatch model=claude-haiku-4-5 ours(...) cc(...)"),
		].join("\n"));
		const { code, stdout } = runGate(logDir);
		assert.equal(code, 1);
		assert.match(stdout, /recon-debug\.log:2/);
		assert.match(stdout, /WARNING: reconcile mismatch/);
	});

	it("ignores non-anchored WARNING text echoed from tool output", () => {
		const { logDir } = makeRun();
		// No bridge prefix → not the bridge's own line → must not count.
		writeFileSync(join(logDir, "echo-debug.log"), "WARNING: this is tool output, not a bridge line\nsome compiler WARNING: x");
		const { code } = runGate(logDir);
		assert.equal(code, 0);
	});

	it("passes when the warning is allowlisted for that test's log", () => {
		const { logDir } = makeRun();
		writeFileSync(join(logDir, "induced-debug.log"), line("WARNING: deliberately induced by this test"));
		const { code } = runGate(logDir, "induced :: deliberately induced");
		assert.equal(code, 0);
	});

	it("does not let an allowlist entry scoped to another test leak", () => {
		const { logDir } = makeRun();
		writeFileSync(join(logDir, "induced-debug.log"), line("WARNING: deliberately induced by this test"));
		// Scoped to a different log name → must not apply here.
		const { code } = runGate(logDir, "other-test :: deliberately induced");
		assert.equal(code, 1);
	});
});
