#!/usr/bin/env bash
# bench.sh — run the reproducible benchmark against a throwaway headless Chrome.
#
# 🔴 Uses its own profile and ports (isolated from the master's Chrome — never touches it),
#    exactly like scripts/e2e.sh. Serves the fixed local fixtures and drives each task through
#    the engine, then prints a score anyone can reproduce by rerunning this.
#
# Exit: 0 all tasks passed, 1 a task failed, 2 could not set up.
set -euo pipefail

PORT_CDP="${WBROWSER_CDP_PORT:-9445}"
PORT_ENGINE="${WBROWSER_PORT:-7985}"
BENCH_PORT="${BENCH_PORT:-38210}"
PROFILE="${WBROWSER_PROFILE_DIR:-$(mktemp -d)}"
AGENT="bench"

die() { printf '\n✖ %s\n' "$*" >&2; exit 2; }

cleanup() {
  # 🔴 By port, never by name (see e2e.sh — pkill -f engine.js once killed the shell itself).
  local pid
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT_ENGINE " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  # The headless Chrome is on its own profile/port; leave it or the caller can close it.
}
trap cleanup EXIT

cd "$(dirname "$0")/.." || die "cannot find the repo root"

printf '· Starting headless Chrome (cdp %s)\n' "$PORT_CDP"
WBROWSER_PROFILE_DIR="$PROFILE" WBROWSER_CDP_PORT="$PORT_CDP" WBROWSER_HEADLESS=1 \
  node launch.js >/dev/null 2>&1 \
  || die "Chrome did not start (try it by hand: WBROWSER_HEADLESS=1 node launch.js)"

printf '· Starting the engine on port %s\n' "$PORT_ENGINE"
WBROWSER_CDP_PORT="$PORT_CDP" WBROWSER_PORT="$PORT_ENGINE" WIN_AGENT="$AGENT" \
  node engine.js >/dev/null 2>&1 &

for _ in $(seq 1 25); do
  curl -s --max-time 2 "http://127.0.0.1:$PORT_ENGINE/health" 2>/dev/null | grep -q '"ok"' && break
  sleep 2
done
curl -s --max-time 3 "http://127.0.0.1:$PORT_ENGINE/health" 2>/dev/null | grep -q '"ok"' \
  || die "the engine never became healthy on port $PORT_ENGINE"

printf '\ntasks\n'
WBROWSER_PORT="$PORT_ENGINE" BENCH_PORT="$BENCH_PORT" WB_BENCH_AGENT="$AGENT" \
  node bench/run.js
