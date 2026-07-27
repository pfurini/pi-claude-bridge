/**
 * Shared RPC harness for pi integration tests.
 * Provides spawn, send, event waiting, and text collection utilities.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { assertClaudeAuthenticated } from "./claude-auth.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Auto-load .env.test so int tests work when invoked directly
// (`node --import tsx --test tests/int-foo.mjs`) and not just via `npm test`.
const ENV_FILE = resolve(DIR, ".env.test");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_SHUTDOWN_KILL_MS = 2_000;

async function closesWithin(closePromise, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			closePromise.then(() => true),
			new Promise((resolveTimeout) => {
				timer = setTimeout(() => resolveTimeout(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function terminateChild(child, closePromise, options = {}) {
	if (!child || !closePromise) return;
	const {
		shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
		shutdownKillMs = DEFAULT_SHUTDOWN_KILL_MS,
		rpcLogPath = "unknown",
		debugLogPath = "unknown",
		onDiagnostic,
	} = options;
	if (child.exitCode !== null || child.signalCode !== null) {
		await closePromise;
		return;
	}

	const pid = child.pid ?? "unknown";
	child.kill("SIGTERM");
	if (await closesWithin(closePromise, shutdownGraceMs)) return;

	const diagnostic =
		`RPC child pid=${pid} did not exit within ${shutdownGraceMs}ms after SIGTERM; ` +
		`escalating to SIGKILL (rpcLog=${rpcLogPath}, debugLog=${debugLogPath})`;
	onDiagnostic?.(diagnostic);
	child.kill("SIGKILL");
	if (await closesWithin(closePromise, shutdownKillMs)) return;

	throw new Error(
		`RPC child pid=${pid} did not exit within ${shutdownKillMs}ms after SIGKILL ` +
		`(rpcLog=${rpcLogPath}, debugLog=${debugLogPath})`,
	);
}

/**
 * Create an RPC harness for pi integration tests.
 *
 * @param {Object} opts
 * @param {string} opts.name - Test name (used for log files)
 * @param {string[]} opts.args - Additional pi CLI args (after --mode rpc)
 * @param {Object} opts.env - Extra env vars to set on the pi process
 * @param {string} opts.cwd - Working directory for the pi process (default: project root)
 * @param {number} opts.defaultTimeout - Default timeout for send/wait operations (default: 30000)
 * @param {string} opts.claudeConfigDir - Claude profile this harness's bridge will use.
 *   The auth preflight checks this profile, so a test that points the bridge at a
 *   non-default profile fails fast on startup instead of on every turn with an
 *   in-band auth error (default: the bridge's own default profile).
 * @param {number} opts.shutdownGraceMs - Time to wait after SIGTERM (default: 2000)
 * @param {number} opts.shutdownKillMs - Time to wait after SIGKILL (default: 2000)
 */
export function createRpcHarness(opts) {
	const {
		name,
		args = [],
		env = {},
		cwd = DIR,
		claudeConfigDir,
		defaultTimeout = 30_000,
		shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
		shutdownKillMs = DEFAULT_SHUTDOWN_KILL_MS,
	} = opts;

	const LOGDIR = `${DIR}/.test-output`;
	mkdirSync(LOGDIR, { recursive: true });

	const RPC_LOG = `${LOGDIR}/${name}.log`;
	const DEBUG_LOG = `${LOGDIR}/${name}-debug.log`;

	// Strip any local node_modules from PATH so we use the globally-installed `pi`.
	const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");

	let pi, piClosePromise, rpcLog;
	let stopped = false;
	let buffer = "";
	let listeners = [];
	let reqId = 0;

	function start() {
		assertClaudeAuthenticated(claudeConfigDir);
		buffer = "";
		// Truncate the debug log on each run so test assertions that grep the
		// log see only this run's output, not accumulated history from prior
		// failing runs. RPC log is still append so cross-run comparisons work.
		writeFileSync(DEBUG_LOG, "");
		stopped = false;
		rpcLog = createWriteStream(RPC_LOG, { flags: "a" });
		const currentLog = rpcLog;
		const spawnArgs = ["--no-session", "-ne", "-e", DIR, "--mode", "rpc", ...args];
		pi = spawn("pi", spawnArgs, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PATH: cleanPath, CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: DEBUG_LOG, ...env },
		});
		piClosePromise = new Promise((resolveClose) => pi.once("close", resolveClose));

		// Two separate hazards, so both guards are needed. currentLog pins the stream
		// this run opened, so a later start() swapping rpcLog cannot redirect these
		// writes; the stopped check covers the killed subprocess flushing buffered
		// output after stop() has already ended the stream (write-after-end).
		pi.stderr.on("data", (d) => { if (!stopped) currentLog.write(d); });

		const decoder = new StringDecoder("utf8");
		pi.stdout.on("data", (chunk) => {
			if (stopped) return;
			buffer += decoder.write(chunk);
			while (true) {
				const i = buffer.indexOf("\n");
				if (i === -1) break;
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				try {
					const msg = JSON.parse(line);
					currentLog.write(`< ${line}\n`);
					for (const fn of [...listeners]) fn(msg);
				} catch {}
			}
		});
	}

	async function startAndWait(ms = 2000) {
		if (pi) await stop();
		start();
		await new Promise((r) => setTimeout(r, ms));
	}

	async function stop() {
		// Set before terminating so the stdout/stderr handlers stop writing: the
		// killed child can still flush buffered output after the stream is ended.
		stopped = true;
		const child = pi;
		const closed = piClosePromise;
		const log = rpcLog;

		try {
			await terminateChild(child, closed, {
				shutdownGraceMs,
				shutdownKillMs,
				rpcLogPath: RPC_LOG,
				debugLogPath: DEBUG_LOG,
				onDiagnostic: (diagnostic) => {
					if (log && !log.writableEnded) log.write(`[shutdown] ${diagnostic}\n`);
				},
			});
		} finally {
			if (log && !log.writableEnded) {
				await new Promise((resolveEnd) => log.end(resolveEnd));
			}

			if (pi === child) {
				pi = undefined;
				piClosePromise = undefined;
				rpcLog = undefined;
			}
		}
	}

	function addListener(fn) {
		listeners.push(fn);
		return () => {
			const i = listeners.indexOf(fn);
			if (i !== -1) listeners.splice(i, 1);
		};
	}

	function send(cmd, timeout = defaultTimeout) {
		const id = `req_${++reqId}`;
		const full = { ...cmd, id };
		rpcLog.write(`> ${JSON.stringify(full)}\n`);
		pi.stdin.write(JSON.stringify(full) + "\n");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout: ${cmd.type}`)), timeout);
			const remove = addListener((msg) => {
				if (msg.type !== "response" || msg.id !== id) return;
				clearTimeout(timer);
				remove();
				msg.success ? resolve(msg.data) : reject(new Error(`${cmd.type}: ${msg.error}`));
			});
		});
	}

	function waitForEvent(type, timeout = defaultTimeout) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
			const remove = addListener((msg) => {
				if (msg.type === type) {
					clearTimeout(timer);
					remove();
					resolve(msg);
				}
			});
		});
	}

	function waitForMatch(predicate, description, timeout = defaultTimeout) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${description}`)), timeout);
			const remove = addListener((msg) => {
				if (predicate(msg)) {
					clearTimeout(timer);
					remove();
					resolve(msg);
				}
			});
		});
	}

	function collectText() {
		let text = "";
		const handler = (msg) => {
			if (msg.type === "message_update") {
				const ae = msg.assistantMessageEvent;
				if (ae?.type === "text_delta") text += ae.delta;
			}
		};
		addListener(handler);
		return { stop() { const i = listeners.indexOf(handler); if (i !== -1) listeners.splice(i, 1); return text; } };
	}

	async function promptAndWait(message, timeout = defaultTimeout) {
		const collector = collectText();
		await send({ type: "prompt", message }, timeout);
		await waitForEvent("agent_end", timeout);
		return collector.stop();
	}

	function clearListeners() {
		listeners = [];
	}

	return {
		DIR,
		LOGDIR,
		RPC_LOG,
		DEBUG_LOG,
		pi: () => pi,
		start,
		startAndWait,
		stop,
		addListener,
		clearListeners,
		send,
		waitForEvent,
		waitForMatch,
		collectText,
		promptAndWait,
	};
}

/**
 * Require environment variable or exit with error.
 * @param {string} name - Environment variable name
 * @returns {string} The env var value
 */
export function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`ERROR: ${name} not set (see .env.test)`);
		process.exit(1);
	}
	return value;
}
