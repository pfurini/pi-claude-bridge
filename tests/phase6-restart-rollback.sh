#!/usr/bin/env bash
# Prove the supported rollback path: downgrade, restart Pi, and rebuild Claude
# session state from persisted Pi history instead of resuming target JSONL.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PHASE6_ROOT="${PHASE6_ROOT:-$DIR/.test-output/phase6}"
OLD_BRIDGE_DIR="${PHASE6_OLD_BRIDGE_DIR:?Set PHASE6_OLD_BRIDGE_DIR to a clean pre-upgrade bridge checkout}"
OLD_PROFILE="${PHASE6_OLD_PROFILE:-$PHASE6_ROOT/profiles/old}"
TARGET_PROFILE="${PHASE6_TARGET_PROFILE:-$PHASE6_ROOT/profiles/target}"
ROLLBACK_ROOT="$PHASE6_ROOT/rollback"
PI_AGENT_DIR="$ROLLBACK_ROOT/pi-agent"
PI_SESSION_DIR="$ROLLBACK_ROOT/pi-sessions"
TARGET_DEBUG="$ROLLBACK_ROOT/target-debug.log"
OLD_DEBUG="$ROLLBACK_ROOT/old-debug.log"
TARGET_OUTPUT="$ROLLBACK_ROOT/target.stdout.log"
OLD_OUTPUT="$ROLLBACK_ROOT/old.stdout.log"

mkdir -p "$ROLLBACK_ROOT" "$PI_AGENT_DIR" "$PI_SESSION_DIR"
WORKSPACE="$(mktemp -d "$ROLLBACK_ROOT/workspace.XXXXXX")"
printf '{}\n' > "$PI_AGENT_DIR/settings.json"
: > "$TARGET_DEBUG"
: > "$OLD_DEBUG"

NORMAL_PROFILE="$HOME/.claude"
if [[ "$OLD_PROFILE" == "$TARGET_PROFILE" || "$OLD_PROFILE" == "$NORMAL_PROFILE" || "$TARGET_PROFILE" == "$NORMAL_PROFILE" ]]; then
	echo "ERROR: old and target profiles must be distinct and must not use $NORMAL_PROFILE" >&2
	exit 1
fi
for path in "$OLD_BRIDGE_DIR" "$OLD_PROFILE" "$TARGET_PROFILE"; do
	if [[ ! -e "$path" ]]; then
		echo "ERROR: required isolated path is missing: $path" >&2
		exit 1
	fi
done

OLD_SDK=$(node -e 'console.log(require(process.argv[1]).version)' "$OLD_BRIDGE_DIR/node_modules/@anthropic-ai/claude-agent-sdk/package.json")
TARGET_SDK=$(node -e 'console.log(require(process.argv[1]).version)' "$DIR/node_modules/@anthropic-ai/claude-agent-sdk/package.json")
if [[ "$OLD_SDK" != "0.2.141" || "$TARGET_SDK" != "0.3.218" ]]; then
	echo "ERROR: expected installed old/target Agent SDK versions 0.2.141/0.3.218, got $OLD_SDK/$TARGET_SDK" >&2
	exit 1
fi

SESSION_ID=$(node -e 'console.log(crypto.randomUUID())')
PHRASE="ROLLBACK-$(node -e 'console.log(crypto.randomUUID().slice(0,8))')"
CLEAN_PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v node_modules | paste -sd: -)

(
	cd "$WORKSPACE"
	PATH="$CLEAN_PATH" \
	CLAUDE_CONFIG_DIR="$TARGET_PROFILE" \
	PI_CODING_AGENT_DIR="$PI_AGENT_DIR" \
	CLAUDE_BRIDGE_DEBUG=1 \
	CLAUDE_BRIDGE_DEBUG_PATH="$TARGET_DEBUG" \
	pi --no-extensions --extension "$DIR" --no-context-files \
		--session-dir "$PI_SESSION_DIR" --session-id "$SESSION_ID" \
		--model claude-bridge/claude-haiku-4-5 \
		-p "Remember the benign rollback phrase $PHRASE. Reply exactly RECORDED."
) > "$TARGET_OUTPUT" 2> "$TARGET_OUTPUT.err"

grep -qi "RECORDED" "$TARGET_OUTPUT"

# This is the restart boundary. A new Pi process loads the same Pi session while
# the bridge and Claude profile now come from the old installation.
(
	cd "$WORKSPACE"
	PATH="$CLEAN_PATH" \
	CLAUDE_CONFIG_DIR="$OLD_PROFILE" \
	PI_CODING_AGENT_DIR="$PI_AGENT_DIR" \
	CLAUDE_BRIDGE_DEBUG=1 \
	CLAUDE_BRIDGE_DEBUG_PATH="$OLD_DEBUG" \
	pi --no-extensions --extension "$OLD_BRIDGE_DIR" --no-context-files \
		--session-dir "$PI_SESSION_DIR" --session-id "$SESSION_ID" \
		--model claude-bridge/claude-haiku-4-5 \
		-p "Reply with exactly the rollback phrase I asked you to remember."
) > "$OLD_OUTPUT" 2> "$OLD_OUTPUT.err"

grep -qi "$PHRASE" "$OLD_OUTPUT"
grep -Eq "Case 2: first turn with [1-9][0-9]* prior messages" "$OLD_DEBUG"
grep -q "syncResult: path=rebuild" "$OLD_DEBUG"

printf 'PASS restart-and-rebuild rollback phrase=%s session=%s\n' "$PHRASE" "${SESSION_ID:0:8}"
printf 'PASS old bridge rebuilt from Pi history with Agent SDK %s after target SDK %s\n' "$OLD_SDK" "$TARGET_SDK"
printf 'Evidence workspace: %s\n' "$WORKSPACE"
printf 'Old debug log: %s\n' "$OLD_DEBUG"
