#!/usr/bin/env bash
# Prompt cache efficiency test for pi-claude-bridge.
# Runs a multi-turn conversation and verifies Anthropic prompt caching is working.
# Expects: every primary request after the warm-up turn has a high cache-hit
# rate and nondecreasing cache reads as conversation history grows. Tool-result
# continuation turns are reported separately because the SDK can use a distinct
# cache shape for the first MCP continuation.
#
# Also checks session sync correctness: consecutive same-provider turns must
# resume the session (Case 3), not rebuild it (Case 4). A rebuild would reset
# prompt caching. This catches the off-by-one cursor bug where pi's post-return
# assistant message append caused syncSharedSession to see 1 "missed" message.

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== cache-test.sh ==="

setup_test_env "cache-test" ".ndjson"
require_claude_auth

LOGFILE="$LOGDIR/cache-test.ndjson"

trap kill_descendants EXIT

TMPFILE="$LOGDIR/cache-test-scratch.txt"
rm -f "$TMPFILE" "$CLAUDE_BRIDGE_DEBUG_PATH"

echo "Running 5-turn conversation (text + tool use)..."
timeout 180 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret number is 42. Acknowledge briefly." \
     "Write the secret number to $TMPFILE. Just the number, nothing else." \
     "What is 42 * 2? Just the number." \
     "Read $TMPFILE and tell me what's in it." \
     "What was the secret number, what did you write, what did you read, and what was 42*2? One per line." \
  > "$LOGFILE" 2>"$LOGFILE.err" || PI_EXIT=$?
PI_EXIT=${PI_EXIT:-0}

rm -f "$TMPFILE"

if [ -s "$LOGFILE.err" ]; then
  echo ""
  echo "pi stderr:"
  cat "$LOGFILE.err"
  echo ""
fi

if [ "$PI_EXIT" -ne 0 ]; then
  echo "FAIL: pi exited with code $PI_EXIT"
  exit 1
fi

echo ""
echo "Turn-by-turn cache metrics:"
echo "---"
printf "%-6s  %-12s  %8s  %8s  %8s  %8s  %s\n" "Turn" "Kind" "Input" "CacheRd" "CacheWr" "Output" "CacheHit%"

# Thresholds
MIN_CACHE_HIT_PCT=90
MIN_EXPECTED_TURNS=7    # 5 prompts + 2 tool sub-turns (write + read)
MIN_EXPECTED_PRIMARY_TURNS=5
MIN_CASE3_RESUMES=2
EXPECTED_CASE1=1

TURN=0
PRIMARY_TURNS=0
FAIL=0
PREV_PRIMARY_CACHE_READ=0

while IFS= read -r line; do
  TURN=$((TURN + 1))
  AGENT=$(echo "$line" | jq -r '.agent')
  TURN_IN_AGENT=$(echo "$line" | jq -r '.turnInAgent')
  INPUT=$(echo "$line" | jq -r '.input')
  CACHE_READ=$(echo "$line" | jq -r '.cacheRead')
  CACHE_WRITE=$(echo "$line" | jq -r '.cacheWrite')
  OUTPUT=$(echo "$line" | jq -r '.output')
  TOTAL_INPUT=$((INPUT + CACHE_READ + CACHE_WRITE))

  if [ "$TOTAL_INPUT" -gt 0 ]; then
    HIT_PCT=$((CACHE_READ * 100 / TOTAL_INPUT))
  else
    HIT_PCT=0
  fi

  if [ "$TURN_IN_AGENT" -eq 1 ]; then
    KIND="prompt-$AGENT"
    PRIMARY_TURNS=$((PRIMARY_TURNS + 1))
  else
    KIND="tool-result"
  fi

  printf "%-6s  %-12s  %8s  %8s  %8s  %8s  %s%%\n" "$TURN" "$KIND" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$HIT_PCT"

  # Only compare primary prompt turns. MCP tool-result continuations can use a
  # different cache shape, so comparing them with adjacent prompt turns produces
  # false regressions even when the shared session is reused correctly.
  if [ "$TURN_IN_AGENT" -eq 1 ]; then
    if [ "$AGENT" -ge 2 ]; then
      if [ "$CACHE_READ" -lt "$PREV_PRIMARY_CACHE_READ" ]; then
        echo "  FAIL: Prompt $AGENT cacheRead ($CACHE_READ) decreased from the prior prompt ($PREV_PRIMARY_CACHE_READ)"
        FAIL=$((FAIL + 1))
      fi
      if [ "$HIT_PCT" -lt $MIN_CACHE_HIT_PCT ]; then
        echo "  FAIL: Prompt $AGENT cache hit rate ${HIT_PCT}% < ${MIN_CACHE_HIT_PCT}%"
        FAIL=$((FAIL + 1))
      fi
    fi
    PREV_PRIMARY_CACHE_READ=$CACHE_READ
  fi
done < <(jq -s -c '
  reduce .[] as $event (
    {agent: 0, turnInAgent: 0, rows: []};
    if $event.type == "agent_start" then
      .agent += 1 | .turnInAgent = 0
    elif $event.type == "turn_end" then
      .turnInAgent += 1 | .rows += [{
        agent: .agent,
        turnInAgent: .turnInAgent,
        input: ($event.message.usage.input // 0),
        cacheRead: ($event.message.usage.cacheRead // 0),
        cacheWrite: ($event.message.usage.cacheWrite // 0),
        output: ($event.message.usage.output // 0)
      }]
    else . end
  ) | .rows[]
' "$LOGFILE")

echo "---"

if [ "$TURN" -lt $MIN_EXPECTED_TURNS ]; then
  echo "FAIL: Only $TURN turns detected (expected >= $MIN_EXPECTED_TURNS with tool use sub-turns)"
  FAIL=$((FAIL + 1))
fi
if [ "$PRIMARY_TURNS" -lt $MIN_EXPECTED_PRIMARY_TURNS ]; then
  echo "FAIL: Only $PRIMARY_TURNS primary prompt turns detected (expected >= $MIN_EXPECTED_PRIMARY_TURNS)"
  FAIL=$((FAIL + 1))
fi

# --- Assert session resume (no spurious rebuilds) ---
# With the off-by-one cursor bug, every follow-up turn triggered a rebuild
# instead of a resume, because pi appends the final assistant message after
# streamSimple returns, making the cursor lag by 1.
#
# Parses the "syncResult: path=<reuse|rebuild|clean-start> sessionId=<uuid>"
# marker emitted by syncSharedSession at the end of each call. Gives us both
# the distribution and sessionId stability in one pass.

echo ""
echo "Session sync:"

CLEAN_START_COUNT=0
REUSE_COUNT=0
REBUILD_COUNT=0
declare -a SESSION_IDS=()

while IFS= read -r line; do
  path=$(echo "$line" | sed -nE 's/.*syncResult: path=([a-z-]+).*/\1/p')
  sid=$(echo "$line" | sed -nE 's/.*sessionId=([a-f0-9-]+).*/\1/p')
  case "$path" in
    clean-start) CLEAN_START_COUNT=$((CLEAN_START_COUNT + 1));;
    reuse)       REUSE_COUNT=$((REUSE_COUNT + 1));;
    rebuild)     REBUILD_COUNT=$((REBUILD_COUNT + 1));;
  esac
  if [ -n "$sid" ]; then
    SESSION_IDS+=("$sid")
  fi
done < <(grep "syncResult:" "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null || true)

UNIQUE_SIDS=$(printf "%s\n" "${SESSION_IDS[@]}" | sort -u | grep -c . || true)
UNIQUE_SIDS=${UNIQUE_SIDS:-0}

echo "  clean-start: $CLEAN_START_COUNT"
echo "  reuse:       $REUSE_COUNT"
echo "  rebuild:     $REBUILD_COUNT"
echo "  unique session ids: $UNIQUE_SIDS"

if [ "$CLEAN_START_COUNT" -ne $EXPECTED_CASE1 ]; then
  echo "  FAIL: Expected exactly $EXPECTED_CASE1 clean-start, got $CLEAN_START_COUNT"
  FAIL=$((FAIL + 1))
fi

if [ "$REBUILD_COUNT" -gt 0 ]; then
  echo "  FAIL: $REBUILD_COUNT spurious rebuilds (expected 0 for consecutive same-provider turns)"
  echo "    Likely cause: off-by-one cursor — trailing assistant message misidentified as missed"
  FAIL=$((FAIL + 1))
fi

if [ "$REUSE_COUNT" -lt $MIN_CASE3_RESUMES ]; then
  echo "  FAIL: Expected at least $MIN_CASE3_RESUMES reuses for turns 2+, got $REUSE_COUNT"
  FAIL=$((FAIL + 1))
fi

# Same-provider flow should never produce more than 1 distinct sessionId:
# one created on first turn (or none for clean-start), reused thereafter.
# A regression that churns UUIDs per turn would surface here even if the
# distribution checks above still passed.
if [ "$UNIQUE_SIDS" -gt 1 ]; then
  echo "  FAIL: expected at most 1 distinct sessionId in same-provider flow, got $UNIQUE_SIDS"
  FAIL=$((FAIL + 1))
fi

# --- Summary ---

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: Prompt caching and session resume working correctly"
else
  echo "FAIL: $FAIL assertions failed"
  echo "  Log: $LOGFILE"
  echo "  Debug: $CLAUDE_BRIDGE_DEBUG_PATH"
  exit 1
fi
