// Read-only access to Claude Code's own OAuth credential (D7).
//
// The bridge holds no Pi-resolvable credential by design: it registers with a
// static placeholder, and Claude Code owns its own OAuth session. To report
// subscription usage we need that token, so this module reads it and nothing
// else. It never refreshes it, never writes it back, and never logs it: a
// refresh race here could clobber Claude Code's own credential state, and the
// token is treated as opaque throughout (its usability is decided by what the
// API answers, never by parsing an expiry field — see D11).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Claude Code scopes its Keychain entry per profile: the service name carries
// the first eight hex characters of sha256(CLAUDE_CONFIG_DIR). Verified live on
// this machine against two independent profiles (`~/.pi/agent/claude` and
// `~/.claude`), and pinned by a test so a change upstream fails there rather
// than as a permanently unavailable usage bar.
//
// The unsuffixed service predates that scheme and is still present on machines
// that have been through the transition, but as an empty husk: its accessToken
// and refreshToken are zero-length strings. It is tried last, and only a
// non-empty token is ever accepted, so the husk falls through rather than
// masking the real entry.
export const LEGACY_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function keychainServiceForProfile(claudeConfigDir: string): string {
	const fingerprint = createHash("sha256").update(claudeConfigDir).digest("hex").slice(0, 8);
	return `${LEGACY_KEYCHAIN_SERVICE}-${fingerprint}`;
}
export interface CredentialLookup {
	/**
	 * ok: a token was found. missing: this platform stores Claude Code
	 * credentials somewhere we can read, and there was nothing there.
	 * unsupported: there is no such place here at all, which is not a failure
	 * worth reporting to anyone.
	 */
	status: "ok" | "missing" | "unsupported";
	token?: string;
}

export interface CredentialReaderDeps {
	platform?: NodeJS.Platform;
	/** Reads a file as text, throwing when it is absent or unreadable. */
	readFileText?: (path: string) => string;
	/** Returns the raw secret stored under a Keychain service, throwing when absent. */
	readKeychainSecret?: (service: string) => string;
}

// The profile file is tried on every platform, not just Linux: it is what Claude
// Code writes when no OS keyring is available, and unlike the macOS Keychain
// entry (which is keyed by the OS account) it is per-profile, so honouring it
// first is what makes two Claude profiles resolve two different accounts.
export function claudeCredentialsFilePath(claudeConfigDir: string): string {
	return join(claudeConfigDir, ".credentials.json");
}

// Exported so a test can assert the real command rather than a copy of it: the
// guarantees here (no shell, no secret in argv, a read-only verb) are properties
// of this exact invocation, and a test that rebuilt the array would pass whether
// or not the reader still used it.
export function keychainReadCommand(service: string): { file: string; args: string[] } {
	return { file: "security", args: ["find-generic-password", "-s", service, "-w"] };
}

function defaultReadKeychainSecret(service: string): string {
	// execFile with an argument array: no shell, so nothing here is interpolated
	// into a command string. The secret comes back on stdout rather than through
	// argv, which is world-readable on a multi-user machine.
	const command = keychainReadCommand(service);
	return execFileSync(command.file, command.args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function tokenFromCredentialJson(raw: string): string | undefined {
	try {
		const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken;
		return typeof token === "string" && token.length > 0 ? token : undefined;
	} catch {
		// A truncated or re-shaped credential store reads as "no credential",
		// which is the same actionable state as an absent one.
		return undefined;
	}
}

/**
 * Resolves Claude Code's access token for one profile.
 *
 * Never throws, never writes, and never logs: every failure below is reported
 * as a status, because the one thing that must not happen on this path is a
 * token reaching a log line or an exception message that somebody else prints.
 */
export function readClaudeCredentials(
	claudeConfigDir: string,
	deps: CredentialReaderDeps = {},
): CredentialLookup {
	const platform = deps.platform ?? process.platform;
	const readFileText = deps.readFileText ?? ((path: string) => readFileSync(path, "utf-8"));
	const readKeychainSecret = deps.readKeychainSecret ?? defaultReadKeychainSecret;

	try {
		const token = tokenFromCredentialJson(readFileText(claudeCredentialsFilePath(claudeConfigDir)));
		if (token) return { status: "ok", token };
	} catch {
		// No profile-local credential file; fall through to the platform store.
	}

	if (platform === "darwin") {
		// Profile-scoped first, then the pre-scoping service. Order matters: the
		// legacy entry survives as an empty husk on a migrated machine, and reading
		// it first would find a shape that parses and a token that is useless.
		for (const service of [keychainServiceForProfile(claudeConfigDir), LEGACY_KEYCHAIN_SERVICE]) {
			try {
				const token = tokenFromCredentialJson(readKeychainSecret(service));
				if (token) return { status: "ok", token };
			} catch {
				// Locked, denied, or absent. Indistinguishable from here, and all
				// three are "we have no token" as far as anything downstream can act
				// on. Never logged: the exception may quote the store's contents.
			}
		}
		return { status: "missing" };
	}

	// Linux keeps the credential in the profile directory we already tried.
	if (platform === "linux") return { status: "missing" };

	// Anywhere else there is no store to read, so there is nothing to report:
	// usage was never going to work here, and saying so every session is noise.
	return { status: "unsupported" };
}
