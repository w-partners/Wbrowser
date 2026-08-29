#!/usr/bin/env bash
# End-to-end check: launch a headless Chrome, drive it through /act, assert what
# came back. This is the layer the unit tests cannot reach.
#
# 🔵 It uses its own profile and its own two ports, so it never touches the browser
#    you are signed into. Nothing here logs in anywhere and nothing is left behind
#    except a throwaway profile directory.
# 🔴 It does NOT kill Chrome. Chrome may be a window a person is using — the demo
#    browser is closed by closing it. Only the engine, which we started, is stopped,
#    and only by the port we gave it.
#
# Usage:  bash scripts/e2e.sh          from the repo root
# Exit:   0 all checks passed, 1 a check failed, 2 could not get set up

set -u

PORT_CDP=9444
PORT_ENGINE=7984
PROFILE="${WBROWSER_E2E_PROFILE:-$HOME/.wbrowser-e2e}"
AGENT=e2e

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
die()  { printf '\n%s\n' "$1" >&2; exit 2; }

# --- act: POST one command, print the raw JSON ------------------------------
act() {
  curl -s --max-time 45 -X POST "http://127.0.0.1:$PORT_ENGINE/act" \
    -H 'Content-Type: application/json' -d "$1" 2>/dev/null
}

# --- assert: run a jq-ish check in python, since jq is not a given ----------
# $1 label   $2 json   $3 python expression over `d`, must be truthy
check() {
  local label="$1" json="$2" expr="$3"
  local out
  out=$(printf '%s' "$json" | python3 -c "
import json,sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print('not JSON: ' + raw[:120]); sys.exit(1)
try:
    v = ($expr)
except Exception as e:
    print('check raised %s: %s' % (type(e).__name__, e)); sys.exit(1)
if not v:
    print('was: ' + json.dumps(d, ensure_ascii=False)[:200]); sys.exit(1)
" 2>&1)
  if [ $? -eq 0 ]; then ok "$label"; else bad "$label" "$out"; fi
}

cleanup() {
  # 🔴 By port, never by name. `pkill -f engine.js` once matched the shell running
  #    it and killed that instead (exit 144). A port is unambiguous: we opened it.
  local pid
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT_ENGINE " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  printf '\n· Engine stopped. The headless browser on port %s is still up — close it or leave it.\n' "$PORT_CDP"
}
trap cleanup EXIT

cd "$(dirname "$0")/.." || die "cannot find the repo root"

printf '· Starting headless Chrome (profile %s, cdp %s)\n' "$PROFILE" "$PORT_CDP"
WBROWSER_PROFILE_DIR="$PROFILE" WBROWSER_CDP_PORT="$PORT_CDP" WBROWSER_HEADLESS=1 \
  node launch.js >/dev/null 2>&1 \
  || die "Chrome did not start. Run it by hand to see why:
    WBROWSER_PROFILE_DIR=$PROFILE WBROWSER_CDP_PORT=$PORT_CDP WBROWSER_HEADLESS=1 node launch.js"

printf '· Starting the engine on port %s\n' "$PORT_ENGINE"
WBROWSER_CDP_PORT="$PORT_CDP" WBROWSER_PORT="$PORT_ENGINE" WIN_AGENT="$AGENT" \
  node engine.js >/dev/null 2>&1 &

for _ in $(seq 1 25); do
  curl -s --max-time 2 "http://127.0.0.1:$PORT_ENGINE/health" 2>/dev/null | grep -q '"ok"' && break
  sleep 2
done
curl -s --max-time 3 "http://127.0.0.1:$PORT_ENGINE/health" 2>/dev/null | grep -q '"ok"' \
  || die "the engine never became healthy on port $PORT_ENGINE"

printf '\nchecks\n'

# --- health -----------------------------------------------------------------
H=$(curl -s --max-time 5 "http://127.0.0.1:$PORT_ENGINE/health")
check "health says the browser is attached" "$H" "d['ok'] and d['browser']"

# --- goto + read ------------------------------------------------------------
R=$(act '{"goto":"https://example.com","read":true,"agent":"'"$AGENT"'"}')
check "goto example.com lands"          "$R" "d['page']['url'].startswith('https://example.com')"
check "read returns the heading"        "$R" "d['page']['h1'] == 'Example Domain'"
check "read returns links"              "$R" "len(d['page']['links']) > 0"
# 🔴 The tab title carries who is driving. Without it a person cannot tell an
#    agent's tab from their own in the tab bar, which is the one safety feature here.
check "the tab is labelled with the agent" "$R" "d['page']['title'].startswith('[$AGENT]')"

# --- read finds a real form -------------------------------------------------
R=$(act '{"goto":"https://duckduckgo.com","read":true,"agent":"'"$AGENT"'"}')
check "read lists the search field"     "$R" "any(i.get('name')=='q' for i in d['page']['inputs'])"
# 🔵 It is a textarea, not an input — which is exactly the assumption the error
#    message below exists to correct.
check "read reports the real tag"       "$R" "any(i.get('name')=='q' and i['tag']=='textarea' for i in d['page']['inputs'])"

# 🔴 read must list only what a person can actually see. Drop the visibility filter
#    and hidden inputs flood the list — the caller then aims at a box that is not on
#    screen and the click times out on something that was never broken. Measured
#    2026-08-25 on X, where an aria-hidden duplicate of the composer read as len 1
#    while the real one held 21 characters.
# 🔵 Inject a hidden field and assert read does not offer it.
act '{"eval":"var i=document.createElement(\"input\"); i.name=\"wb_hidden_probe\"; i.style.display=\"none\"; document.body.appendChild(i); \"ok\"","agent":"'"$AGENT"'"}' >/dev/null
R=$(act '{"read":true,"agent":"'"$AGENT"'"}')
check "read hides what the user cannot see" "$R" "not any(i.get('name')=='wb_hidden_probe' for i in d['page']['inputs'])"

# --- type actually types ----------------------------------------------------
act '{"type":{"selector":"textarea[name=q]","text":"hello world"},"agent":"'"$AGENT"'"}' >/dev/null
V=$(act '{"eval":"document.querySelector(\"[name=q]\").value","agent":"'"$AGENT"'"}')
check "type puts the whole string in"   "$V" "d.get('result') == 'hello world'"

# 🔴 Typing into a field that already has text must replace it, not append. Without
#    the clear step you get "hello worldsecond" and the command still reports success —
#    the caller then submits a query nobody wrote.
act '{"type":{"selector":"textarea[name=q]","text":"second"},"agent":"'"$AGENT"'"}' >/dev/null
V=$(act '{"eval":"document.querySelector(\"[name=q]\").value","agent":"'"$AGENT"'"}')
check "type replaces, does not append"  "$V" "d.get('result') == 'second'"

# --- click, including a target below the fold -------------------------------
# 🔴 `click` had no check at all until 0.8.1 — one of eleven command branches,
#    entirely uncovered, while the suite reported 15 green. Removing the
#    scroll-into-view step left everything passing.
# 🔵 A button placed past the viewport is the case that step exists for: it is
#    perfectly clickable, just not *yet* on screen. Without the scroll, playwright
#    times out on something that was never broken.
act '{"eval":"var b=document.createElement(\"button\"); b.id=\"wb_probe_btn\"; b.textContent=\"probe\"; b.style.cssText=\"position:absolute;top:9000px;left:10px\"; b.onclick=function(){window.__wbProbe=1;}; document.body.appendChild(b); \"ok\"","agent":"'"$AGENT"'"}' >/dev/null
R=$(act '{"click":"#wb_probe_btn","agent":"'"$AGENT"'"}')
check "click reaches a target below the fold" "$R" "any('wb_probe_btn' in s for s in d.get('done',[]))"

V=$(act '{"eval":"String(window.__wbProbe)","agent":"'"$AGENT"'"}')
check "the click actually fired the handler" "$V" "d.get('result') == '1'"

# 🔵 And that it reports the element it hit, not the selector it was handed —
#    a selector matching the wrong element still "succeeds" otherwise.
check "click names what it hit"         "$R" "'->' in ' '.join(d.get('done',[]))"

# --- a selector that matches nothing says so --------------------------------
# 🔴 This used to surface as `locator.scrollIntoViewIfNeeded: Timeout 10000ms
#    exceeded`, which reads as a slow page and sends you to look at load times.
E=$(act '{"type":{"selector":"input[name=q]","text":"x"},"agent":"'"$AGENT"'"}')
check "a bad selector names itself"     "$E" "'input[name=q]' in (d.get('error') or '')"
check "a bad selector says nothing matched" "$E" "'nothing on this page matches' in (d.get('error') or '')"

# --- press ------------------------------------------------------------------
R=$(act '{"press":"Escape","agent":"'"$AGENT"'"}')
check "press reports what it sent"      "$R" "any('Escape' in s for s in d.get('done',[]))"

# 🔴 Reporting is not doing. The check above passes even if the chord never reaches
#    the page — `Escape` is a named key, so it survives any normalisation bug.
#    Measured 2026-08-28 with scripts/mutate.sh: reverting the chord fix (the
#    toUpperCase that makes `Control+a` work) left this suite fully green. A test
#    that watches the log watches the log.
# 🔵 So press a chord whose effect is visible: select-all then delete. If the chord
#    is mangled, the field keeps its text and this fails.
act '{"type":{"selector":"textarea[name=q]","text":"select me"},"agent":"'"$AGENT"'"}' >/dev/null
act '{"press":"Control+a","agent":"'"$AGENT"'"}' >/dev/null
act '{"press":"Backspace","agent":"'"$AGENT"'"}' >/dev/null
V=$(act '{"eval":"document.querySelector(\"[name=q]\").value","agent":"'"$AGENT"'"}')
check "Control+a then Backspace empties the field" "$V" "d.get('result') == ''"

# 🔵 And that a lowercase chord is normalised — the actual bug from v0.5.0.
R=$(act '{"press":"Control+a","agent":"'"$AGENT"'"}')
check "a lowercase chord is normalised" "$R" "any('Control+A' in s for s in d.get('done',[]))"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
