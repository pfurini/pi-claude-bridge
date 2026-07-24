import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { terminateChild } from "./lib/rpc-harness.mjs";

function spawnFixture(source) {
	const child = spawn(process.execPath, ["-e", source], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const closePromise = new Promise((resolve) => child.once("close", resolve));
	const readyPromise = new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error("fixture readiness timeout")), 2_000);
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (!output.includes("ready")) return;
			clearTimeout(timer);
			resolve();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (output.includes("ready")) return;
			clearTimeout(timer);
			reject(new Error(`fixture exited before readiness (code=${code}, signal=${signal})`));
		});
	});
	return { child, closePromise, readyPromise };
}

async function forceCleanup(child, closePromise) {
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await closePromise;
}

const gracefulSource = `
process.on("SIGTERM", () => process.exit(0));
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`;

const stubbornSource = `
process.on("SIGTERM", () => {});
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`;

describe("RPC child shutdown", () => {
	it("allows a normal child to exit after SIGTERM", async () => {
		const { child, closePromise, readyPromise } = spawnFixture(gracefulSource);
		try {
			await readyPromise;
			await terminateChild(child, closePromise, {
				shutdownGraceMs: 500,
				shutdownKillMs: 500,
			});
			assert.equal(child.signalCode, null);
			assert.equal(child.exitCode, 0);
		} finally {
			await forceCleanup(child, closePromise);
		}
	});

	it("escalates a SIGTERM-resistant child to SIGKILL within the bound", async () => {
		const { child, closePromise, readyPromise } = spawnFixture(stubbornSource);
		const diagnostics = [];
		try {
			await readyPromise;
			const startedAt = Date.now();
			await terminateChild(child, closePromise, {
				shutdownGraceMs: 50,
				shutdownKillMs: 500,
				rpcLogPath: "/tmp/rpc.log",
				debugLogPath: "/tmp/debug.log",
				onDiagnostic: (message) => diagnostics.push(message),
			});
			assert.ok(Date.now() - startedAt < 1_000);
			assert.equal(child.signalCode, "SIGKILL");
			assert.equal(diagnostics.length, 1);
			assert.match(diagnostics[0], new RegExp(`pid=${child.pid}`));
			assert.match(diagnostics[0], /rpcLog=\/tmp\/rpc\.log/);
			assert.match(diagnostics[0], /debugLog=\/tmp\/debug\.log/);
		} finally {
			await forceCleanup(child, closePromise);
		}
	});

	it("does not signal a child that has already exited", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
			stdio: "ignore",
		});
		const closePromise = new Promise((resolve) => child.once("close", resolve));
		await closePromise;
		let killCalls = 0;
		child.kill = () => {
			killCalls++;
			return false;
		};

		await terminateChild(child, closePromise);
		assert.equal(killCalls, 0);
	});

	it("reports the PID and log paths if closure is never observed", async () => {
		const { child, closePromise, readyPromise } = spawnFixture(stubbornSource);
		try {
			await readyPromise;
			await assert.rejects(
				terminateChild(child, new Promise(() => {}), {
					shutdownGraceMs: 30,
					shutdownKillMs: 30,
					rpcLogPath: "/tmp/failure-rpc.log",
					debugLogPath: "/tmp/failure-debug.log",
				}),
				(error) => {
					assert.match(error.message, new RegExp(`pid=${child.pid}`));
					assert.match(error.message, /rpcLog=\/tmp\/failure-rpc\.log/);
					assert.match(error.message, /debugLog=\/tmp\/failure-debug\.log/);
					return true;
				},
			);
		} finally {
			await forceCleanup(child, closePromise);
		}
	});
});
