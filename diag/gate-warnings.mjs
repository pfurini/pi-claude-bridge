#!/usr/bin/env node
// Integration-run WARNING/BUG gate.
//
// After an integration battery, every bridge-prefixed `WARNING:`/`BUG:` line the
// run emitted should be either a real defect (fail the run) or a warning a test
// induces on purpose (allowlisted). This scans every per-test debug log the run
// produced and fails on the first un-allowlisted one, naming file, line, and
// message so the offender is actionable. It is what makes the usage reconciler
// (which emits `WARNING: reconcile mismatch`) self-enforcing in CI-like runs.
//
//   node diag/gate-warnings.mjs [logDir] [--allowlist diag/warning-allowlist.txt]
//
// logDir defaults to .test-output (where both the shell tests via setup_test_env
// and the RPC harness write `<name>-debug.log`). Wipe it before the battery so the
// gate sees only this run's logs — the npm `test` script does.
//
// Allowlist format (see diag/warning-allowlist.txt): one entry per line,
//   <log-name-substring> :: <message-substring>
// A warning is allowed when some entry's name-substring is contained in the log's
// basename AND its message-substring is contained in the raw message. Omit the
// `<name> ::` prefix to allow a message in any log. `#` starts a comment.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
// Shared with audit-warnings.mjs so the two cannot drift. LINE captures
// [1] date, [2] time, [3] module id, [4] message.
import { LINE, NOTABLE } from "./warning-lines.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const logDir = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))[0] ?? ".test-output";
const allowlistPath = flag("--allowlist", join("diag", "warning-allowlist.txt"));

function loadAllowlist(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n")
		.map((l) => l.replace(/#.*$/, "").trim())
		.filter(Boolean)
		.map((l) => {
			const idx = l.indexOf("::");
			return idx === -1
				? { scope: "", pattern: l }
				: { scope: l.slice(0, idx).trim(), pattern: l.slice(idx + 2).trim() };
		});
}

function run() {
	if (!existsSync(logDir)) {
		console.error(`gate-warnings: log dir ${logDir} does not exist — nothing to check`);
		process.exit(0);
	}
	const allowlist = loadAllowlist(allowlistPath);
	const files = readdirSync(logDir).filter((f) => f.endsWith("-debug.log"));
	const offenders = [];
	let scanned = 0, warnings = 0, allowed = 0;

	for (const file of files) {
		const name = basename(file);
		const text = readFileSync(join(logDir, file), "utf8");
		const lines = text.split("\n");
		scanned++;
		for (let i = 0; i < lines.length; i++) {
			const m = LINE.exec(lines[i]);
			if (!m || !NOTABLE.test(m[4])) continue;
			warnings++;
			const msg = m[4];
			const isAllowed = allowlist.some((e) => (e.scope === "" || name.includes(e.scope)) && msg.includes(e.pattern));
			if (isAllowed) { allowed++; continue; }
			offenders.push({ file: name, line: i + 1, msg });
		}
	}

	console.log(`gate-warnings: scanned ${scanned} debug log(s) in ${logDir}`);
	console.log(`gate-warnings: ${warnings} WARNING/BUG line(s), ${allowed} allowlisted, ${offenders.length} unexpected\n`);

	if (!offenders.length) {
		console.log("OK: no un-allowlisted WARNING/BUG lines");
		process.exit(0);
	}
	console.log("FAIL: un-allowlisted WARNING/BUG lines (add to the allowlist only if a test induces them on purpose):");
	for (const o of offenders) {
		console.log(`  ${o.file}:${o.line}  ${o.msg.slice(0, 200)}`);
		// Suggest the raw message, not a normalized one: allowlist matching is a
		// substring test against the raw line, so the old digit→N / bracket→[…]
		// "generalized" suggestion could never match anything. Generalizing volatile
		// numbers is the curator's call, not the printer's.
		console.log(`    allowlist entry to silence: ${o.file.replace(/-debug\.log$/, "")} :: ${o.msg.slice(0, 80)}`);
	}
	process.exit(1);
}

run();
