/**
 * Read-only access to Claude Code's OAuth credential (B2).
 *
 * The token is the one value in this feature that must never escape: not into
 * the debug log, the diag dump, the cache, or an emitted payload. These drive
 * the reader with injected stores, and the leak cases assert against the real,
 * redirected sinks (tests/lib/setup.mjs points CLAUDE_BRIDGE_DEBUG_PATH and
 * CLAUDE_BRIDGE_DIAG_PATH at a throwaway directory) rather than against a spy,
 * so a leak through a path this test did not imagine still shows up.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEGACY_KEYCHAIN_SERVICE,
	keychainReadCommand,
	keychainServiceForProfile,
	claudeCredentialsFilePath,
	readClaudeCredentials,
} from "../src/claude-credentials.js";
import { defaultClaudeConfigDir } from "../src/claude-config.js";

const FIXTURE_TOKEN = "sk-ant-oat01-fixture-token-do-not-leak";

function credentialJson(token = FIXTURE_TOKEN) {
	// Shaped like the real store, including the fields D11 refuses to trust:
	// expiresAt is a single-digit sentinel on the reference machine, so nothing
	// here may be read as an expiry.
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: token,
			refreshToken: `${token}-refresh`,
			expiresAt: 0,
			subscriptionType: "max",
		},
	});
}

function withProfile(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-profile-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Every sink the bridge writes to, as redirected by the unit-suite preload.
function readSinks() {
	const paths = [process.env.CLAUDE_BRIDGE_DEBUG_PATH, process.env.CLAUDE_BRIDGE_DIAG_PATH];
	return paths.map((path) => (path && existsSync(path) ? readFileSync(path, "utf8") : "")).join("\n");
}

describe("reading Claude Code credentials", () => {
	it("reads the profile's own credentials file (B2.2)", () => {
		withProfile((dir) => {
			writeFileSync(claudeCredentialsFilePath(dir), credentialJson());
			const found = readClaudeCredentials(dir, { platform: "linux" });
			assert.deepEqual(found, { status: "ok", token: FIXTURE_TOKEN });
		});
	});

	it("honours the resolved profile rather than the process environment (B2.3)", () => {
		withProfile((first) => {
			withProfile((second) => {
				writeFileSync(claudeCredentialsFilePath(first), credentialJson("token-for-first"));
				writeFileSync(claudeCredentialsFilePath(second), credentialJson("token-for-second"));

				// The exact class of bug fixed in 64e42ea: reading the env var instead
				// of the resolved dir silently serves one profile's credential to the
				// other, and under config isolation those genuinely differ.
				const previous = process.env.CLAUDE_CONFIG_DIR;
				process.env.CLAUDE_CONFIG_DIR = first;
				try {
					assert.equal(readClaudeCredentials(second, { platform: "linux" }).token, "token-for-second");
				} finally {
					if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
					else process.env.CLAUDE_CONFIG_DIR = previous;
				}
			});
		});
	});

	it("reads the profile-scoped macOS Keychain entry when there is no file (B2.1, B2.3)", () => {
		withProfile((dir) => {
			const services = [];
			const found = readClaudeCredentials(dir, {
				platform: "darwin",
				readKeychainSecret: (service) => {
					services.push(service);
					return credentialJson();
				},
			});

			assert.deepEqual(found, { status: "ok", token: FIXTURE_TOKEN });
			// Claude Code scopes the entry by sha256(profile dir), so the service
			// name is where the profile is honoured on macOS.
			assert.deepEqual(services, [keychainServiceForProfile(dir)]);
			assert.notEqual(keychainServiceForProfile(dir), keychainServiceForProfile(`${dir}-other`));
		});
	});

	it("falls back to the pre-scoping Keychain service, but never to its empty husk", () => {
		withProfile((dir) => {
			const services = [];
			// A migrated machine keeps the unsuffixed entry with zero-length tokens.
			// Reading it first, or accepting it at all, would find a shape that
			// parses and a token that cannot authenticate anything.
			const husk = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } });
			const missing = readClaudeCredentials(dir, {
				platform: "darwin",
				readKeychainSecret: (service) => {
					services.push(service);
					return husk;
				},
			});
			assert.deepEqual(missing, { status: "missing" });
			assert.deepEqual(services, [keychainServiceForProfile(dir), LEGACY_KEYCHAIN_SERVICE]);

			const found = readClaudeCredentials(dir, {
				platform: "darwin",
				readKeychainSecret: (service) => {
					if (service !== LEGACY_KEYCHAIN_SERVICE) throw new Error("not found");
					return credentialJson();
				},
			});
			assert.deepEqual(found, { status: "ok", token: FIXTURE_TOKEN });
		});
	});

	it("asks the Keychain without a shell and without a secret in argv (B2.1)", () => {
		// The reader's own command, not a copy of it: these are properties of the
		// exact invocation, and rebuilding the array here would pass whether or not
		// the reader still used it.
		const command = keychainReadCommand(LEGACY_KEYCHAIN_SERVICE);
		assert.equal(command.file, "security");
		assert.deepEqual(command.args, ["find-generic-password", "-s", LEGACY_KEYCHAIN_SERVICE, "-w"]);
		// argv is world-readable on a multi-user machine, so the secret must come
		// back on stdout and never go out on the command line.
		assert.ok(!command.args.some((arg) => arg.includes("sk-ant")));
		assert.ok(!command.args.some((arg) => /[;&|$`\n]/.test(arg)), "no argument may be shell-metacharacter bait");
		assert.ok(command.args.every((arg) => !arg.includes("add-") && !arg.includes("delete-")),
			"the reader must never carry a verb that writes to the Keychain (B2.5)");

		const source = readFileSync(new URL("../src/claude-credentials.ts", import.meta.url), "utf8");
		assert.ok(source.length > 0, "the source must be readable, or this scan is vacuous");
		assert.ok(!source.includes("execSync("), "a shell would interpolate the service name into a command string");
		assert.ok(!source.includes("writeFileSync") && !source.includes("appendFileSync"),
			"the reader must not be able to write anything, anywhere (B2.5)");
	});

	it("reports a supported platform with no credential as missing (B2.7)", () => {
		withProfile((dir) => {
			const missing = readClaudeCredentials(dir, {
				platform: "darwin",
				readKeychainSecret: () => { throw new Error("The specified item could not be found"); },
			});
			assert.deepEqual(missing, { status: "missing" });
		});
	});

	it("reports an unreadable or re-shaped credential store as missing, never as a token", () => {
		withProfile((dir) => {
			for (const body of ["{not json", "{}", JSON.stringify({ claudeAiOauth: {} }), JSON.stringify({ claudeAiOauth: { accessToken: "" } })]) {
				writeFileSync(claudeCredentialsFilePath(dir), body);
				assert.deepEqual(readClaudeCredentials(dir, { platform: "linux" }), { status: "missing" }, body);
			}
		});
	});

	it("is a silent no-op on a platform with no credential store (B2.4)", () => {
		withProfile((dir) => {
			// Distinct from "missing": usage was never going to work here, and
			// reporting a failure every session would be noise, not news.
			assert.deepEqual(readClaudeCredentials(dir, { platform: "win32" }), { status: "unsupported" });
		});
	});

	it("never writes to the credential store, on any path (B2.5)", () => {
		withProfile((dir) => {
			writeFileSync(claudeCredentialsFilePath(dir), credentialJson());
			const before = readdirSync(dir).sort();
			const beforeBytes = readFileSync(claudeCredentialsFilePath(dir), "utf8");

			readClaudeCredentials(dir, { platform: "linux" });
			readClaudeCredentials(dir, { platform: "darwin", readKeychainSecret: () => { throw new Error("nope"); } });
			readClaudeCredentials(join(dir, "absent"), { platform: "linux" });

			// A refresh here would race Claude Code's own credential state, so the
			// store must come out byte-identical however the read went.
			assert.deepEqual(readdirSync(dir).sort(), before);
			assert.equal(readFileSync(claudeCredentialsFilePath(dir), "utf8"), beforeBytes);
		});
	});

	it("keeps the token out of every log sink, even when an error carries it (B2.8)", () => {
		withProfile((dir) => {
			const sinksBefore = readSinks();

			// A store whose failure message embeds the token: if the reader logged
			// the exception, or let it escape to a caller that does, the token would
			// land in a file an operator is asked to attach to a bug report.
			const leaky = readClaudeCredentials(dir, {
				platform: "darwin",
				readKeychainSecret: () => { throw new Error(`keychain denied for ${FIXTURE_TOKEN}`); },
			});
			assert.deepEqual(leaky, { status: "missing" });

			const sinksAfter = readSinks();
			assert.equal(sinksAfter, sinksBefore, "the reader wrote to a log sink");
			assert.ok(!sinksAfter.includes(FIXTURE_TOKEN));

			// The assertion above is only worth anything if a leak would show:
			// prove the sinks are real files this process can actually write.
			const probe = process.env.CLAUDE_BRIDGE_DIAG_PATH;
			assert.ok(probe, "the diag sink must be redirected, or this scan is vacuous");
			mkdirSync(join(probe, ".."), { recursive: true });
			writeFileSync(probe, `${sinksBefore}\nprobe ${FIXTURE_TOKEN}\n`);
			assert.ok(readSinks().includes(FIXTURE_TOKEN), "a real leak must be detectable by this scan");
			writeFileSync(probe, sinksBefore.split("\n").slice(1).join("\n"));
		});
	});

	it("finds the real Keychain entry on this machine", () => {
		if (process.platform !== "darwin") return;
		// A live probe rather than a claim about how Claude Code behaves: the
		// service naming scheme is undocumented, so if it changes this fails here
		// instead of surfacing as a permanently unavailable usage bar.
		const profile = defaultClaudeConfigDir();
		let raw;
		try {
			const command = keychainReadCommand(keychainServiceForProfile(profile));
			raw = execFileSync(command.file, command.args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return; // No Claude Code login under this profile; nothing to pin.
		}
		const oauth = JSON.parse(raw).claudeAiOauth;
		assert.equal(typeof oauth.accessToken, "string");
		assert.ok(oauth.accessToken.length > 0,
			`the profile-scoped entry for ${profile} holds no token; Claude Code may have moved it again`);

		// D11 said expiry must come from the API rather than from this field,
		// because the field was measured as a single-digit integer. That
		// measurement was taken on the unsuffixed entry, which is now an empty
		// husk; the profile-scoped entry carries a plausible epoch-ms value
		// (2026-09-23 on this machine as of 2026-08-27). The conclusion stands
		// anyway and the reason is now simply a different one: a pre-expiry check
		// would be an optimization that adds a clock-skew failure mode to a path
		// that already learns the truth from a 401. Nothing here reads the field.
		const source = readFileSync(new URL("../src/claude-credentials.ts", import.meta.url), "utf8");
		assert.ok(!source.includes("expiresAt"), "expiry must be decided by the API, never by parsing a field (D11)");

		// And the whole reader, end to end, against the real store.
		assert.equal(readClaudeCredentials(profile).status, "ok");
	});

	it("does not mistake the pre-scoping husk for a credential on this machine", () => {
		if (process.platform !== "darwin") return;
		// The unsuffixed entry still exists here and parses cleanly, with
		// zero-length tokens. Accepting it would produce a 401 on every request
		// and an unavailable bar that blames the wrong thing.
		let raw;
		try {
			const command = keychainReadCommand(LEGACY_KEYCHAIN_SERVICE);
			raw = execFileSync(command.file, command.args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return; // Already cleaned up on this machine.
		}
		const oauth = JSON.parse(raw).claudeAiOauth;
		if (oauth.accessToken.length > 0) return; // Not a husk here; nothing to guard against.
		assert.equal(readClaudeCredentials("/nonexistent-profile", {
			readKeychainSecret: (service) => {
				if (service === LEGACY_KEYCHAIN_SERVICE) return raw;
				throw new Error("not found");
			},
			platform: "darwin",
		}).status, "missing");
	});
});
