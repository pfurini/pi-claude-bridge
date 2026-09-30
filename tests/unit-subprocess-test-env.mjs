import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessTestEnv } from "./lib/subprocess-test-env.mjs";

it("starts nested test bodies instead of inheriting the parent worker protocol", () => {
	const root = mkdtempSync(join(tmpdir(), "nested-test-runner-"));
	try {
		const path = join(root, "control.test.mjs");
		writeFileSync(path, 'import { it } from "node:test"; it("control", () => console.log("CHILD_BODY_EXECUTED"));\n');
		const env = subprocessTestEnv({ NODE_TEST_CONTEXT: "child-v8", CASE_NAME: "control" });
		assert.equal(env.NODE_TEST_CONTEXT, undefined);
		assert.equal(env.CASE_NAME, "control");
		const child = spawnSync(process.execPath, ["--test", "--test-reporter=spec", path], { env, encoding: "utf8", timeout: 10000 });
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, /CHILD_BODY_EXECUTED/);
		assert.match(child.stdout, /pass 1/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
