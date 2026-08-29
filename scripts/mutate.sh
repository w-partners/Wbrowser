#!/usr/bin/env bash
# Mutation test: break the engine in places the checks do NOT target, and count
# how many mutants the suite actually catches.
#
# 🔴 Why this exists. The first attempt at "we verified the tests by breaking the
#    code" picked mutations *next to the checks that watch them* — disable the title
#    stamp, the title check goes red. That proves the wiring, not the coverage. It
#    says the switch is connected to the bulb; it says nothing about how many bulbs
#    are in the room. Measured 2026-08-28: disabling goto's timeout-recovery branch
#    — which no check aims at — left all 11 green.
#
# 🔵 So the mutants here are chosen from the *code*: one per command branch in
#    act(), including the branches nobody tests. A mutant that survives is not a
#    bug — it is an uncovered branch, and naming it is the whole point.
#
# Usage:  bash scripts/mutate.sh          from the repo root
# Exit:   always 0 — this reports coverage, it does not gate anything

set -u
cd "$(dirname "$0")/.." || exit 2

ENGINE=engine.js
BAK=$(mktemp -t engine.XXXXXX.bak)
cp "$ENGINE" "$BAK"
restore() { cp "$BAK" "$ENGINE"; rm -f "$BAK"; }
trap restore EXIT

# name | python replacement expression (applied to engine.js source)
# 🔵 Each one changes behaviour a user would notice. None of them is a syntax error —
#    a mutant that fails to parse proves nothing.
# 🔴 A mutant that only edits the *first* occurrence of a repeated pattern is a false
#    survivor: the other copies still do the job and the suite stays green, which reads
#    as "not covered" when the check was fine all along. Measured 2026-08-28 —
#    `.filter(vis)` appears three times in summarize(); replacing one left the check
#    passing. Count your occurrences before choosing count=1.
MUTANTS=(
"goto:timeout-recovery|s.replace(\"if (sameOrigin && landed.ready !== 'loading')\", \"if (false && sameOrigin && landed.ready !== 'loading')\", 1)"
"click:scroll-first|s.replace('await el.scrollIntoViewIfNeeded({ timeout: 10000 });', '', 1)"
"type:clear-before|s.replace(\"await field.fill('', { timeout: 3000 });\", 'void 0;', 1)"
"type:keystroke-delay|s.replace('Number(delay) || 25', '0', 1)"
"press:chord-normalise|s.replace('k.toUpperCase()', 'k', 1)"
"read:visible-filter|s.replace('.filter(vis)', '')"
"agent:label-stamp|s.replace('async function stampTitle(page, agent, tabName) {', 'async function stampTitle(page, agent, tabName) { if (1) return;', 1)"
"selector:require-match|s.replace('if (n === 0) {', 'if (false) {', 1)"
)

printf 'mutation coverage — %s mutants\n\n' "${#MUTANTS[@]}"

CAUGHT=0
SURVIVED=0
SURVIVORS=""

for m in "${MUTANTS[@]}"; do
  name="${m%%|*}"
  expr="${m#*|}"

  cp "$BAK" "$ENGINE"
  python3 - "$ENGINE" "$expr" <<'PY'
import sys
path, expr = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
before = s
s = eval(expr)                      # noqa: S307 — the table above is the only input
if s == before:
    sys.exit(9)                     # the pattern no longer matches the source
open(path, 'w', encoding='utf-8').write(s)
PY
  rc=$?
  if [ "$rc" -eq 9 ]; then
    printf '  %-26s SKIP  pattern no longer in engine.js\n' "$name"
    continue
  fi

  if ! node --check "$ENGINE" 2>/dev/null; then
    printf '  %-26s SKIP  mutant does not parse\n' "$name"
    continue
  fi

  # 🔵 By port, never by name.
  pid=$(ss -ltnp 2>/dev/null | grep ":7984 " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  sleep 2

  if bash scripts/e2e.sh >/dev/null 2>&1; then
    printf '  %-26s \033[31mSURVIVED\033[0m  no check noticed\n' "$name"
    SURVIVED=$((SURVIVED+1)); SURVIVORS="$SURVIVORS $name"
  else
    printf '  %-26s caught\n' "$name"
    CAUGHT=$((CAUGHT+1))
  fi
done

restore
trap - EXIT

TOTAL=$((CAUGHT+SURVIVED))
printf '\ncaught %s / %s\n' "$CAUGHT" "$TOTAL"
if [ -n "$SURVIVORS" ]; then
  printf '\nsurvivors —%s\n' "$SURVIVORS"
  printf '🔵 Each survivor is an uncovered branch, not a bug. Add a check or\n'
  printf '   say out loud that the branch is untested. Do not delete the mutant.\n'
fi
