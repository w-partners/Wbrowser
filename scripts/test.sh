#!/usr/bin/env bash
# scripts/test.sh — run every test and FAIL LOUDLY. Use this, not a hand-rolled loop.
#
# 🔴 Why this file exists: the suite mixes two runners. Most files are plain scripts that
#    `process.exit(1)` on failure, but some use node:test — and on node 22 a node:test file run
#    as `node test/x.test.js` prints "# fail 3" and still exits 0. A loop that judges by exit
#    code therefore reports those files as OK. Measured 2026-10-02: three real failures in
#    fallback_recovery.test.js were invisible for a day because of exactly that loop.
#    `npm test` (node --test) does return 1 — so the fix is to stop inventing a runner.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# 🔴 Say whether Chrome is here BEFORE running anything. A few tests need a live Chrome, and
#    without this the suite turns red on a machine where nothing is wrong — which trains people
#    to ignore red. Measured 2026-10-02: rawcdp.test.js #8/#9 failed with ECONNREFUSED 9222
#    simply because Chrome was closed, and the runner reported it the same way it reports a bug.
#    🔵 The point is not to hide those failures; it is to label them, so "2 failing" means
#       something different from "2 skipped because Chrome is closed".
CDP="${WBROWSER_CDP:-http://127.0.0.1:9222}"
if curl -s -o /dev/null --max-time 3 "$CDP/json/version" 2>/dev/null; then
  CHROME=up
  echo "== Chrome: up ($CDP) — browser-dependent tests will run =="
else
  CHROME=down
  echo "== Chrome: NOT running ($CDP) =="
  echo "   Tests that need a live browser will fail with ECONNREFUSED. That is the environment,"
  echo "   not the code. Start it with 'node launch.js' to exercise them, or read past those."
fi

echo "== node --test (the whole suite) =="
if npm test --silent; then
  echo "  ✅ node --test"
else
  echo "  ❌ node --test reported failures"
  fail=1
fi

# 🔵 Belt and braces: node --test only collects files it recognises as tests. Any file that is a
#    plain script gets run again here, where a non-zero exit is the signal. Double-running is
#    cheap (these are all Chrome-free) and catches a file that node --test silently skipped.
echo "== plain scripts (re-run; a skipped file would otherwise be a silent pass) =="
for t in test/*.test.js; do
  out="$(node "$t" 2>&1)" || { echo "  ❌ $(basename "$t") (exit)"; echo "$out" | tail -5; fail=1; continue; }
  # A node:test file can print failures and still exit 0 — read its summary, not its status.
  if echo "$out" | grep -qE '^# fail [1-9]'; then
    echo "  ❌ $(basename "$t") — $(echo "$out" | grep -E '^# fail' | head -1) (exited 0 anyway)"
    fail=1
  else
    echo "  ✅ $(basename "$t")"
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "== all green =="
elif [ "$CHROME" = down ]; then
  # 🔵 Still exit non-zero — a red suite is red. But name the likely cause, so nobody spends
  #    an hour on a bug that is a closed browser.
  echo "== FAILURES ABOVE — note Chrome is NOT running; check whether every failure is an"
  echo "   ECONNREFUSED on $CDP before treating these as code defects =="
else
  echo "== FAILURES ABOVE =="
fi
exit "$fail"
