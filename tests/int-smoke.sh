#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).
# Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER / CLAUDE_BRIDGE_TESTING_ALT_MODEL

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"
require_command jq
require_claude_auth

ALT_PROVIDER=$(require_env CLAUDE_BRIDGE_TESTING_ALT_PROVIDER)
ALT_MODEL=$(require_env CLAUDE_BRIDGE_TESTING_ALT_MODEL)

TIMEOUT=60
PASS=0
FAIL=0

TEST_CWD_PREFIX="$LOGDIR/smoke-cwd."
TEST_CWD=$(mktemp -d "$TEST_CWD_PREFIX"XXXXXX)
mkdir -p "$TEST_CWD/.pi"
printf '{"askClaude":{"enabled":true}}\n' > "$TEST_CWD/.pi/claude-bridge.json"
cd "$TEST_CWD"
cleanup() {
  if [[ "${TEST_CWD:-}" == "$TEST_CWD_PREFIX"* && ${#TEST_CWD} -gt ${#TEST_CWD_PREFIX} && -d "$TEST_CWD" ]]; then
    rm -rf -- "$TEST_CWD"
  fi
  kill_descendants
}
trap cleanup EXIT

run() {
  local name="$1"; shift
  local expected="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    echo "$output" > "$logfile"
    if grep -Eqi 'Not logged in|Could not resolve authentication|Please run /login' <<<"$output"; then
      echo "FAIL (Claude authentication error)"
      echo "  Log: $logfile"
      ((++FAIL))
    elif [ -n "$output" ] && [[ "$output" =~ $expected ]]; then
      echo "PASS"
      ((++PASS))
    elif [ -z "$output" ]; then
      echo "FAIL (empty output)"
      echo "  Log: $logfile"
      ((++FAIL))
    else
      echo "FAIL (expected /$expected/)"
      echo "  Log: $logfile"
      ((++FAIL))
    fi
  else
    local rc=$?
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit $rc)"
    echo "  Log: $logfile"
    ((++FAIL))
  fi
  kill_descendants
}

# --- Tests ---

run "provider: print mode responds" '[Yy][Ee][Ss]' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

run "provider: --provider flag works" '[Yy][Ee][Ss]' \
  pi --no-session -ne -e "$DIR" \
  --provider claude-bridge \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" 'claude-bridge' \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-bridge"

# AskClaude e2e: force a non-Claude model to call the tool and check for a tool result
run "tool: AskClaude responds" '^ok$' \
  bash -c "pi --no-session -ne -e '$DIR' --provider '$ALT_PROVIDER' --model '$ALT_MODEL' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>/dev/null \
    | jq -s -e '[.[] | select(.type == \"agent_end\") | .messages[]? | select(.role == \"toolResult\" and .toolName == \"AskClaude\" and .details.error != true and (([.content[]?.text // \"\"] | join(\" \")) | test(\"4\")))] | length > 0' >/dev/null && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
