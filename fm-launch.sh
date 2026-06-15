#!/usr/bin/env bash
# fm-launch.sh — one command to bring up the whole stack:
#
#   Apple `fm serve` (the entitled engine)  +  fm-proxy.js (OpenAI-compat shim)
#
# fm serve runs in the FOREGROUND (this script blocks on it). That is load-bearing:
# macOS PCC attribution only sticks to a foreground, TTY-attached `fm serve`.
# Backgrounding it (the old node launcher, or a shell `&`) makes every `pcc` request
# fail with ModelManagerError 1013 / "not available in this context" (HTTP 503) even
# though `system` works. Foreground `fm serve` keeps PCC (verified). The exact macOS
# mechanism is unknown, but the foreground/background distinction is empirically
# decisive. See docs + memory `launcher-breaks-pcc-attribution`.
#
# The proxy is a backgrounded child — it only forwards, it doesn't need PCC. Traps on
# INT/TERM/HUP/EXIT tear it down so it can't orphan (Ctrl-C, closed terminal, or fm
# serve dying all clean up the proxy).
#
#   ./fm-launch.sh             # quiet: startup + proxy errors/warnings only
#   ./fm-launch.sh --verbose   # also shows the proxy's per-request [assembled] telemetry
#
# Note: fm serve's own output is NOT tagged (tagging requires piping it, which is
# untested for attribution safety); only the proxy's output is tagged. Hit Ctrl-C to
# stop (NOT Ctrl-Z — a suspended fm serve won't be reaped cleanly).
#
# Options / env:
#   -v, --verbose            show the proxy's per-request [assembled] telemetry
#   --fm-port <n>            fm serve port      (default 1976, env FM_PORT)
#   --proxy-port <n>         proxy port         (default 1977, env PROXY_PORT)
#   --fm-bin <path>          fm binary          (default /usr/bin/fm, env FM_BIN)
#   --health-timeout <ms>    wait for fm serve  (default 20000)
#   -h, --help

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── args ─────────────────────────────────────────────────────────────────────
VERBOSE=false
FM_PORT="${FM_PORT:-1976}"
PROXY_PORT="${PROXY_PORT:-1977}"
FM_BIN="${FM_BIN:-/usr/bin/fm}"
HEALTH_TIMEOUT_MS="${HEALTH_TIMEOUT_MS:-20000}"

usage() {
  cat <<EOF
fm-launch — start Apple fm serve + the OpenAI-compat proxy together

Usage: ./fm-launch.sh [options]

  -v, --verbose          show the proxy's per-request [assembled] telemetry
                         (errors/warnings are always shown, even without this)
  --fm-port <n>          fm serve port          (default 1976)
  --proxy-port <n>       proxy port clients use (default 1977)
  --fm-bin <path>        fm binary              (default /usr/bin/fm)
  --health-timeout <ms>  how long to wait for fm serve (default 20000)
  -h, --help

fm serve runs in the foreground (required for PCC attribution). Ctrl-C to stop.

OpenAI base URL once up: http://127.0.0.1:<proxy-port>/v1  (any dummy API key)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--verbose) VERBOSE=true; shift ;;
    --fm-port) FM_PORT="${2:-}"; shift 2 ;;
    --proxy-port) PROXY_PORT="${2:-}"; shift 2 ;;
    --fm-bin) FM_BIN="${2:-}"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT_MS="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ── logging ──────────────────────────────────────────────────────────────────
ts() { date '+%H:%M:%S'; }
say()    { printf '%s [launch] %s\n' "$(ts)" "$*"; }
sayerr() { printf '%s [launch] %s\n' "$(ts)" "$*" >&2; }

# Prefix each stdin line with a timestamp + source tag. Used for the PROXY only
# (fm serve's output is left raw — see header). $1 = display tag, unused kind for proxy.
tag_stream() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$VERBOSE" == false ]]; then
      [[ "$line" =~ ^\[assembled\]\ req\ model= ]] && continue
      [[ "$line" =~ \*\*\*\ UPSTREAM\ RESPONSE\ HTTP\ [23][0-9][0-9]\ \*\*\* ]] && continue
    fi
    printf '%s [proxy] %s\n' "$(ts)" "$line"
  done
}

# ── health probe ─────────────────────────────────────────────────────────────
# fm serve's /health body says it's running — use for fm serve itself.
probe_health() {  # $1 = port
  local body
  body=$(curl -s -m 1 "http://127.0.0.1:$1/health" 2>/dev/null) || return 1
  [[ "$body" =~ (running|available|status) ]]
}
wait_health() {  # $1 = port, $2 = timeout_ms
  local deadline=$(( $(date +%s) * 1000 + ${2} ))
  while :; do
    probe_health "$1" && return 0
    [[ $(( $(date +%s) * 1000 )) -ge $deadline ]] && return 1
    sleep 0.3
  done
}

# The PROXY's /health forwards to fm serve — which isn't up yet when we check (we start
# the proxy first so fm serve can be foregrounded). So for the proxy, "ready" means
# "accepting TCP connections" (any HTTP response, incl. a 502), NOT a 200/health body.
probe_listening() {  # $1 = port — exit 0 if a connection was accepted
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$1/health" 2>/dev/null
}
wait_listening() {  # $1 = port, $2 = timeout_ms
  local deadline=$(( $(date +%s) * 1000 + ${2} ))
  while :; do
    probe_listening "$1" && return 0
    [[ $(( $(date +%s) * 1000 )) -ge $deadline ]] && return 1
    sleep 0.3
  done
}

# ── orchestration ────────────────────────────────────────────────────────────
PROXY_PID=""
cleaning=false
cleanup() {
  $cleaning && return
  cleaning=true
  # Kill the backgrounded proxy by PID; fm serve is foreground and dies with the signal
  # that ended the script (Ctrl-C → SIGINT to the foreground group). Best-effort pkill
  # mops up any fm serve that lingered (e.g. SIGTERM/SIGHUP to the script itself).
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  pkill -f "fm serve --port $FM_PORT" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup INT TERM HUP EXIT

# 1) the proxy — backgrounded. It doesn't need PCC; it only forwards to fm serve.
say "starting proxy on :$PROXY_PORT  → forwarding to :$FM_PORT"
node "$SCRIPT_DIR/fm-proxy.js" > >(tag_stream) 2>&1 &
PROXY_PID=$!
if ! wait_listening "$PROXY_PORT" 10000; then
  sayerr "proxy did not start listening on :$PROXY_PORT"
  exit 1
fi

# 2) fm serve — FOREGROUND (blocks here). Backgrounding it loses PCC attribution.
# Run it exactly like the working manual setup: raw to the terminal, no &, no pipe.
# A backgrounded health-checker prints "stack up" once fm serve answers, since the
# foreground command blocks this main flow.
say "starting fm serve on :$FM_PORT  (FOREGROUND — required for PCC attribution)"
(
  if wait_health "$FM_PORT" "$HEALTH_TIMEOUT_MS"; then
    say "fm serve is healthy ✓"
    say "stack up — OpenAI base URL: http://127.0.0.1:$PROXY_PORT/v1  (any dummy API key)"
    [[ "$VERBOSE" == false ]] && \
      say "running in quiet mode; pass --verbose for per-request telemetry. Errors are always shown."
  else
    sayerr "fm serve did not become healthy on :$FM_PORT. Are you signed into Apple Intelligence in this Terminal? (PCC needs the attribution.)"
  fi
) &

"$FM_BIN" serve --port "$FM_PORT"          # FOREGROUND — blocks; PCC attribution lives here
fm_rc=$?
# fm serve exited (Ctrl-C / crash). EXIT trap reaps the proxy.
exit "$fm_rc"
