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

# --- health says which build is answering ------------------------------------
# 🔴 Reported 2026-08-31: a fix was released and pulled, and it still did not work —
#    an engine started before the pull was holding the port, so old code answered.
#    Nothing printed said which build was live, so it took comparing process start
#    times by hand. "Fixed but not working" should cost one request, not a hunt.
check "health names the running build" "$H" "d.get('build')"
check "health says when it started"    "$H" "d.get('startedAt')"

# 🔴 And that `build` is what is *running*, not what is on disk. Read the file on
#    every request and an old process picks up a new version number — which is a lie
#    told at exactly the moment this field exists to prevent one. Measured on the
#    neighbouring project the same day: editing the version file made a process
#    started hours earlier report the new version.
#    So: change the file underneath a live engine and the answer must not move.
cp package.json /tmp/wb-e2e-pkg.bak
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("package.json"); d = json.loads(p.read_text())
d["version"] = "9.9.9"; p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
H2=$(curl -s --max-time 5 "http://127.0.0.1:$PORT_ENGINE/health")
cp /tmp/wb-e2e-pkg.bak package.json && rm -f /tmp/wb-e2e-pkg.bak
check "build reports the running code, not the file" "$H2" "'9.9.9' not in (d.get('build') or '')"

# --- goto + read ------------------------------------------------------------
R=$(act '{"goto":"https://example.com","read":true,"agent":"'"$AGENT"'"}')
check "goto example.com lands"          "$R" "d['page']['url'].startswith('https://example.com')"
check "read returns the heading"        "$R" "d['page']['h1'] == 'Example Domain'"
check "read returns links"              "$R" "len(d['page']['links']) > 0"
# 🔴 The tab title carries who is driving. Without it a person cannot tell an
#    agent's tab from their own in the tab bar, which is the one safety feature here.
check "the tab is labelled with the agent" "$R" "d['page']['title'].startswith('[$AGENT]')"

# 🔴 The reply has to say WHOSE tab it read. Tabs are keyed by (agent, tab), so two
#    callers on the default `main` are on different pages — and the answer used to say
#    `tab: "main"` to both. Reported 2026-08-31: someone compared a bare curl against
#    `wb read`, got different pages, and went looking for a client-side parser bug.
#    There was none. `wb` sends an agent name, the bare curl does not, and nothing in
#    either reply said they were different tabs.
check "the reply names the agent whose tab it read" "$R" "d.get('agent') == '$AGENT'"
U=$(act '{"read":true}')
check "and says so when no agent was given"         "$U" "d.get('agent') is None"

# 🔴 One part failing must not take the others down. Reported 2026-08-31: on a heavy
#    feed `{read:true,shot:true}` came back as {"error":"page.screenshot: Timeout"} and
#    nothing else — the page summary had already been gathered and was thrown away with
#    the exception. A collector reading three sites got zero characters from all three,
#    and the reply blamed the screenshot, which was not what the caller had asked for.
R2=$(act '{"goto":"https://example.com","read":true,"shot":true,"agent":"'"$AGENT"'"}')
check "read and shot in one call both arrive" "$R2" \
  "d.get('page') and d.get('screenshot_b64')"
check "and neither reports a failure"         "$R2" \
  "not d.get('readError') and not d.get('shotError')"

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

# 🔴 The keystrokes have to be spaced out. Sites that re-render as you type swallow
#    input that arrives all at once — that is the whole reason `type` is not `fill`.
#    Nothing about the final value shows it: set the delay to 0 and the field still
#    ends up correct, which is why mutate.sh walked past every check that read
#    `.value`. So watch the events instead.
act '{"eval":"window.__wbGaps=[];window.__wbLast=0;document.querySelector(\"[name=q]\").addEventListener(\"keydown\",function(){var t=performance.now();if(window.__wbLast)window.__wbGaps.push(t-window.__wbLast);window.__wbLast=t;});\"ok\"","agent":"'"$AGENT"'"}' >/dev/null
act '{"type":{"selector":"textarea[name=q]","text":"spaced out"},"agent":"'"$AGENT"'"}' >/dev/null
V=$(act '{"eval":"JSON.stringify(window.__wbGaps)","agent":"'"$AGENT"'"}')
#    🔴 The threshold is not "greater than zero". Measured 2026-08-31: with the delay
#       set to 0 the gaps still come out around 14ms, because each keystroke is its own
#       CDP round trip. A check at >10ms passes on the broken build. The real 25ms
#       delay lands near 30ms, so the line goes between them.
check "type spaces its keystrokes apart" "$V" \
  "(lambda g: len(g) >= 5 and sorted(g)[len(g)//2] >= 22)(__import__('json').loads(d.get('result') or '[]'))"

# --- a mistyped key is refused, not silently ignored -------------------------
# 🔴 Reported 2026-08-31: someone read the docs, sent {"action":"read"}, and got 200
#    with `done: []`. Nothing ran and nothing complained, so they tried three more
#    times before working out the schema. A typo that returns success is worse than
#    one that returns an error — it sends you looking at the wrong thing.
U=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "http://127.0.0.1:$PORT_ENGINE/act" \
  -H 'Content-Type: application/json' -d '{"action":"read","agent":"'"$AGENT"'"}')
if [ "$U" = "400" ]; then ok "an unknown key is refused with 400"; else bad "an unknown key is refused with 400" "got $U"; fi

U=$(curl -s --max-time 20 -X POST "http://127.0.0.1:$PORT_ENGINE/act" \
  -H 'Content-Type: application/json' -d '{"action":"read","agent":"'"$AGENT"'"}')
check "and the refusal names the key and the fix" "$U" \
  "'\"action\"' in d.get('error','') and 'read' in d.get('error','')"

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

# --- goto: a page that never finishes loading -------------------------------
# 🔴 A goto timeout does not mean the page failed. Heavy SPAs keep requests in
#    flight long past the point where the document is usable, and playwright
#    rejects on the clock. Rejecting here would throw away the rest of the
#    command — the click, the type, the read that were meant to follow.
# 🔵 The fixture is the real shape: the HTML completes, then an image request
#    hangs forever. `document.readyState` reaches interactive while the network
#    never goes idle. A page stuck at `loading` is correctly NOT recovered —
#    that one really is unusable, and the first fixture we tried made that
#    mistake (it hung a <script>, which blocks parsing).
PORT_SLOW=7985
node -e '
  const http = require("http");
  http.createServer((req, res) => {
    // Getting this fixture right took five attempts, so the reasoning stays.
    // The branch fires when goto times out and the page is still usable, so the
    // fixture has to produce BOTH. Measured 2026-08-31, all on real Chrome:
    //   hanging image / stylesheet / iframe  -> DCL fires in 30ms, goto never times out
    //   a route that returns nothing at all  -> evaluate itself blocks, and rethrowing
    //                                           is right: nothing came back
    //   body streamed, response left open    -> goto times out, evaluate works, the
    //                                           DOM is fully operable. This one.
    // NOTE: inside a single-quoted shell string. No apostrophes.
    res.writeHead(200, {"Content-Type": "text/html"});
    res.write("<!doctype html><html><head><title>Slow</title></head><body>"
            + "<h1>Slow Page</h1><p>usable</p>");
    // no res.end() — the document never completes, but everything sent is live
  }).listen(process.env.PORT_SLOW || 7985, "127.0.0.1");
' PORT_SLOW="$PORT_SLOW" >/dev/null 2>&1 &
sleep 2

# 🔵 This one takes ~30s — the whole point is that goto hits its timeout.
R=$(act '{"goto":"http://127.0.0.1:'"$PORT_SLOW"'/","read":true,"agent":"'"$AGENT"'"}')
# 🔴 Assert the recovery FIRED, not just that the command came back. `'goto' in done`
#    passes either way — a page that never needed recovering says `goto <url>` too, so
#    that check scored zero against mutate.sh while looking perfectly reasonable.
#    The branch writes its own sentence; that sentence is the evidence.
check "goto recovers a page that never completes" "$R" \
  "any('still loading after 30s' in s for s in d.get('done',[]))"
check "and the recovered page is usable"          "$R" "d.get('page',{}).get('h1') == 'Slow Page'"
check "and the rest of the command still ran"     "$R" "d.get('page',{}).get('text')"

# 🔵 By port, never by name.
slow_pid=$(ss -ltnp 2>/dev/null | grep ":$PORT_SLOW " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "${slow_pid:-}" ] && kill "$slow_pid" 2>/dev/null

# 🔴 Put the tab back where the later checks expect it. This one bit us: adding the
#    goto checks left the browser on the slow fixture and three press checks below
#    went red — not because press broke, but because the field they type into was
#    no longer on screen. A check that navigates owes the next check a known page.
act '{"goto":"https://duckduckgo.com","agent":"'"$AGENT"'"}' >/dev/null

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
