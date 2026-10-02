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

[ "$fail" -eq 0 ] && echo "== all green ==" || echo "== FAILURES ABOVE =="
exit "$fail"
