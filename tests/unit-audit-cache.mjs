/**
 * diag/audit-cache.mjs --since window behaviour.
 *
 * Two defects were fixed: (1) the rebuild-boundary predicate compared
 * Date.parse(b.at) on an already-numeric epoch → NaN → --since could never flag a
 * break; (2) the ceiling check used the full-log boundary rate instead of the
 * windowed one. These spawn the real script on crafted logs and assert exit codes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../diag/audit-cache.mjs", import.meta.url));
const MODEL = "claude-haiku-4-5";
const dir = mkdtempSync(join(tmpdir(), "audit-cache-test-"));

// ts at `base + i*30s`, so a window boundary can sit before or after the breaks.
function ts(i, base = Date.parse("2026-07-01T00:00:00.000Z")) {
	return new Date(base + i * 30_000).toISOString();
}
const usage = (t, cacheRead, cacheWrite) =>
	`[${t}] [mod0] usage: in=10 out=100 cacheRead=${cacheRead} cacheWrite=${cacheWrite} total=${110 + cacheRead + cacheWrite} cachePct=0% model=${MODEL}`;
const fresh = (t, path) => [
	`[${t}] [mod0] provider: fresh query model=${MODEL} msgs=5 tools=3 resume=sess0001 effort=high`,
	`[${t}] [mod0] syncResult: path=${path} sessionId=sess`,
];

/** N boundary breaks: each request writes a big cache and the next reads none, so
 *  every consecutive pair short-falls. cacheWrite varies per request to defeat the
 *  same-request dedup. `path` picks rebuild (→ onRebuild list) or reuse (rate only). */
function breakLog(n, path) {
	const lines = [usage(ts(0), 0, 50_000)];
	for (let i = 1; i <= n; i++) {
		lines.push(...fresh(ts(i), path), usage(ts(i), 0, 50_000 + i));
	}
	return lines.join("\n") + "\n";
}

function runScript(logText, extraArgs = []) {
	const logPath = join(dir, `log-${Math.abs(hash(logText + extraArgs.join()))}.log`);
	writeFileSync(logPath, logText);
	try {
		const stdout = execFileSync("node", [SCRIPT, logPath, ...extraArgs], { encoding: "utf8" });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: `${err.stdout ?? ""}` };
	}
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

describe("audit-cache --since window", () => {
	it("flags an in-window rebuild-boundary break (numeric comparison, not NaN)", () => {
		const { code, stdout } = runScript(breakLog(1, "rebuild"), ["--since", "2026-06-01"]);
		assert.equal(code, 1, "an in-window rebuild break must fail");
		assert.match(stdout, /rebuild boundary in window/);
	});

	it("ignores an out-of-window rebuild-boundary break", () => {
		const { code, stdout } = runScript(breakLog(1, "rebuild"), ["--since", "2026-08-01"]);
		assert.equal(code, 0, "a break before the window must pass");
		assert.match(stdout, /OK:/);
	});

	it("fails on a windowed boundary rate over the ceiling", () => {
		// 10 boundary breaks (path=reuse so onRebuild stays empty) → rate 100% > 10%.
		const { code, stdout } = runScript(breakLog(10, "reuse"), ["--since", "2026-06-01"]);
		assert.equal(code, 1, "over-ceiling in window must fail");
		assert.match(stdout, /exceeds ceiling .* in window/);
	});

	it("passes when the over-ceiling breaks are all out of window", () => {
		const { code } = runScript(breakLog(10, "reuse"), ["--since", "2026-08-01"]);
		assert.equal(code, 0, "windowing the denominator+numerator drops out-of-window breaks");
	});
});
