#!/usr/bin/env bash
# Run a single capture-handshake strategy against Serato DJ Pro.
# Usage:
#   scripts/run-strategy.sh <strategy> [budget_ms]
# Behaviour:
#   1. Force-kill any running Serato.
#   2. Start capture-handshake.js with the given STRATEGY, writing to
#      captures/<idx>-<strategy>.log and ...stdout.
#   3. After Bonjour publishes, launch Serato via `open -g`.
#   4. Wait for the capture to self-terminate via RUN_BUDGET_MS.
#   5. Force-kill Serato so the next run starts clean.
# Always exits 0 — caller checks the captures/ files for success.
set -uo pipefail

STRATEGY="${1:-mirror_only}"
BUDGET="${2:-45000}"
PEER_UUID="${PEER_UUID:-np-mac-1}"
SERATO_APP="/Applications/Serato 3/Serato DJ Pro.app"
PEER_NAME="np-${STRATEGY//_/-}"
LOG_DIR="$(cd "$(dirname "$0")/../captures" && pwd)"
mkdir -p "$LOG_DIR"
INDEX=$(printf '%02d' "$(ls "$LOG_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ')")
LOG_FILE="$LOG_DIR/$INDEX-$STRATEGY.log"
STDOUT_FILE="$LOG_DIR/$INDEX-$STRATEGY.stdout"

echo "==[ $INDEX-$STRATEGY ]=================================="

# 1. clean slate
pkill -9 -f "Serato DJ Pro" 2>/dev/null || true
pkill -9 -f "crashpad_handler" 2>/dev/null || true
pkill -9 -f "QtWebEngineProcess" 2>/dev/null || true
sleep 2

# 2. start capture
LOG_PATH="$LOG_FILE" \
STRATEGY="$STRATEGY" \
PEER_NAME="$PEER_NAME" \
PEER_UUID="$PEER_UUID" \
SERATO_REMOTE_PORT=53999 \
RUN_BUDGET_MS="$BUDGET" \
node "$(dirname "$0")/capture-handshake.js" >"$STDOUT_FILE" 2>&1 &
CAP_PID=$!
echo "capture pid=$CAP_PID  log=$LOG_FILE  budget=${BUDGET}ms  peer-uuid=$PEER_UUID"
sleep 3

# 3. launch Serato
echo "launching Serato..."
open -g -a "$SERATO_APP"

# 4. wait
wait "$CAP_PID" 2>/dev/null
CAP_RC=$?
echo "capture exited rc=$CAP_RC"

# 5. cleanup Serato
pkill -9 -f "Serato DJ Pro" 2>/dev/null || true
pkill -9 -f "crashpad_handler" 2>/dev/null || true
pkill -9 -f "QtWebEngineProcess" 2>/dev/null || true
sleep 2

# 6. quick-look summary
echo "--- summary ---"
grep -E "CONN#|STRATEGY|<-|->|RUN_BUDGET|SHUTDOWN" "$LOG_FILE" | tail -30
echo "==[ done ]====================================="
exit 0
