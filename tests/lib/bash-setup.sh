#!/usr/bin/env bash
# Shared setup functions for bash-based integration tests.
# Source this file at the start of test scripts.

set -euo pipefail

# Auto-load .env.test so these scripts work when invoked directly and not just via
# `npm test`, which sources it for the whole chain. Mirrors tests/lib/rpc-harness.mjs,
# which already does this for the .mjs tests.
__ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env.test"
if [[ -f "$__ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$__ENV_FILE"
	set +a
fi

# Strip node_modules/.bin from PATH so nothing resolves to a vendored pi.
__clean_path() {
	echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':'
}

# pi on PATH may be the pi-fence launcher, which drops CLAUDE_BRIDGE_* from its
# child's environment, so the bridge writes no debug log. Put a `pi` link to the
# fork's CLI first on PATH instead. A link, not a function, because the suites
# also run pi through `timeout` and `bash -c`. Same order as tests/lib/pi-bin.mjs:
# PI_BIN, else the sibling fork build, else pi from PATH unchanged.
__prepend_pi_bin() {
	local pi_bin="${PI_BIN:-}"
	local fork_cli="$DIR/../pi/packages/coding-agent/dist/cli.js"
	if [[ -z "$pi_bin" && -f "$fork_cli" ]]; then pi_bin="$fork_cli"; fi
	[[ -n "$pi_bin" ]] || return 0
	local shim
	shim="$(mktemp -d)"
	ln -s "$pi_bin" "$shim/pi"
	PATH="$shim:$PATH"
}

# Setup standard test environment.
# Usage: setup_test_env "test-name"
# Sets: DIR, LOGDIR, LOGFILE (if specified), DEBUG_LOG, and exports CLAUDE_BRIDGE_DEBUG
setup_test_env() {
	local name="$1"
	local log_suffix="${2:-.log}"  # optional: suffix for logfile, or "none" for no logfile

	DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
	LOGDIR="$DIR/.test-output"
	mkdir -p "$LOGDIR"

	export CLAUDE_BRIDGE_DEBUG=1
	DEBUG_LOG="$LOGDIR/${name}-debug.log"
	export CLAUDE_BRIDGE_DEBUG_PATH="$DEBUG_LOG"

	if [[ "$log_suffix" != "none" ]]; then
		LOGFILE="$LOGDIR/${name}${log_suffix}"
	else
		LOGFILE=""
	fi

	# Clean PATH and run pi from the project root so project-local config is visible.
	PATH=$(__clean_path)
	__prepend_pi_bin
	cd "$DIR"

	# Export for use in tests
	export DIR LOGDIR DEBUG_LOG LOGFILE PATH
}

# Kill all descendant processes (children, grandchildren, etc.).
# Use as: trap kill_descendants EXIT
kill_descendants() {
	pkill -P $$ 2>/dev/null || true
	sleep 1
}

# Require an environment variable or exit with error.
# Usage: require_env VARNAME
require_env() {
	local var="$1"
	local val="${!var:-}"
	if [[ -z "$val" ]]; then
		echo "ERROR: $var not set (see .env.test)"
		exit 1
	fi
	echo "$val"
}

# Fail clearly before authenticated integration tests if the isolated profile is not ready.
require_claude_auth() {
	node --import tsx "$DIR/tests/lib/claude-auth.mjs"
}

# Check for required commands or exit with error.
# Usage: require_command cmd1 cmd2 ...
require_command() {
	local cmd
	for cmd in "$@"; do
		if ! command -v "$cmd" >/dev/null 2>&1; then
			echo "ERROR: $cmd is required but not installed"
			exit 1
		fi
	done
}
