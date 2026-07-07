#!/usr/bin/env bash
# Run capture-handshake + re-signed Serato + Frida hook script in one shot.
#
# Usage: scripts/run-with-frida.sh <hook_script> [strategy] [budget_ms]
#   hook_script  – path under scripts/ (e.g. frida-hook-handler.js)
#   strategy     – capture-handshake STRATEGY env (default: mirror_then_pair)
#   budget_ms    – RUN_BUDGET_MS for capture (default: 60000)
#
# Logs go to captures/<NN>-frida-<hook_name>-<strategy>.{stdout,log,frida}.
# Always exits 0; the caller inspects logs.
set -uo pipefail

HOOK="${1:?hook script required (e.g. frida-hook-handler.js)}"
STRATEGY="${2:-mirror_then_pair}"
BUDGET="${3:-60000}"

PEER_UUID="${PEER_UUID:-np-mac-1}"
SERATO_APP="${SERATO_APP:-$HOME/tmp/SeratoDJPro.app}"
SERATO_BIN="$SERATO_APP/Contents/MacOS/Serato DJ Pro"
FRIDA="${FRIDA:-$HOME/Library/Python/3.14/bin/frida}"
FRIDA_PS="${FRIDA_PS:-$HOME/Library/Python/3.14/bin/frida-ps}"
PEER_NAME="np-${STRATEGY//_/-}"

LOG_DIR="$(cd "$(dirname "$0")/../captures" && pwd)"
mkdir -p "$LOG_DIR"
HOOK_NAME=$(basename "$HOOK" .js)
INDEX=$(printf '%02d' "$(ls "$LOG_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ')")
LOG_FILE="$LOG_DIR/$INDEX-frida-$HOOK_NAME-$STRATEGY.log"
STDOUT_FILE="$LOG_DIR/$INDEX-frida-$HOOK_NAME-$STRATEGY.stdout"
FRIDA_FILE="$LOG_DIR/$INDEX-frida-$HOOK_NAME-$STRATEGY.frida"

echo "==[ $INDEX  hook=$HOOK_NAME  strategy=$STRATEGY  budget=${BUDGET}ms ]=="

# 0. sanity
[[ -x "$SERATO_BIN" ]] || { echo "ERR: $SERATO_BIN not found/executable"; exit 1; }
[[ -f "$(dirname "$0")/$HOOK" ]] || { echo "ERR: hook $HOOK not found"; exit 1; }
[[ -x "$FRIDA" ]] || { echo "ERR: frida missing at $FRIDA"; exit 1; }

# 1. clean slate
pkill -9 -f "Serato DJ Pro" 2>/dev/null || true
pkill -9 -f "crashpad_handler" 2>/dev/null || true
pkill -9 -f "QtWebEngineProcess" 2>/dev/null || true
pkill -9 -f "frida-helper" 2>/dev/null || true
sleep 1

# 2. start capture (publishes mDNS, listens on 53999, waits for Serato)
#    FRIDA_DELAY_MS=15000: capture waits 15s after receiving Authorize/Request
#    before replying. This gives Frida time to attach and install hooks before
#    Serato sees our reply.
LOG_PATH="$LOG_FILE" \
STRATEGY="$STRATEGY" \
PEER_NAME="$PEER_NAME" \
PEER_UUID="$PEER_UUID" \
SERATO_REMOTE_PORT=53999 \
RUN_BUDGET_MS="$BUDGET" \
FRIDA_DELAY_MS="${FRIDA_DELAY_MS:-15000}" \
node "$(dirname "$0")/capture-handshake.js" >"$STDOUT_FILE" 2>&1 &
CAP_PID=$!
echo "capture pid=$CAP_PID  log=$LOG_FILE"
sleep 3

# 3. launch re-signed Serato
echo "launching Serato ($SERATO_APP)..."
open -g "$SERATO_APP"

# 4. wait for Serato to load, then attach Frida
echo "waiting for Serato process..."
PID=""
for i in $(seq 1 30); do
  PID=$("$FRIDA_PS" 2>/dev/null | awk '/Serato DJ Pro/ && !/Helpers|crashpad|QtWeb/ {print $1; exit}')
  if [[ -n "$PID" ]]; then break; fi
  sleep 1
done
if [[ -z "$PID" ]]; then
  echo "ERR: Serato PID not found after 30s"
  kill "$CAP_PID" 2>/dev/null || true
  exit 1
fi
echo "Serato pid=$PID found at i=$i — attaching Frida..."
sleep 8  # let Serato finish dynamic loads before attach

DURATION_SEC=$(( BUDGET / 1000 + 5 ))
PYTHON3="${PYTHON3:-python3}"
"$PYTHON3" "$(dirname "$0")/frida-runner.py" "$PID" "$(dirname "$0")/$HOOK" "$DURATION_SEC" >"$FRIDA_FILE" 2>&1 &
FR_PID=$!
echo "frida-runner pid=$FR_PID  log=$FRIDA_FILE"

# 5. wait for capture budget
wait "$CAP_PID" 2>/dev/null
echo "capture exited"

# 6. cleanup
kill "$FR_PID" 2>/dev/null || true
pkill -9 -f "Serato DJ Pro" 2>/dev/null || true
pkill -9 -f "crashpad_handler" 2>/dev/null || true
pkill -9 -f "QtWebEngineProcess" 2>/dev/null || true
sleep 1

echo "--- handshake summary ---"
grep -E "CONN#|STRATEGY|<-|->|RUN_BUDGET|SHUTDOWN" "$LOG_FILE" | tail -25
echo ""
echo "--- frida summary ---"
{ tail -200 "$FRIDA_FILE" 2>/dev/null || echo "(no frida log)"; }
echo "==[ done — files: $LOG_FILE  $STDOUT_FILE  $FRIDA_FILE ]=="
exit 0
