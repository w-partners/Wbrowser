"""Named browsers: a person refers to one by name or number, never by port.

`work` is browser 2 today and browser 2 tomorrow, whatever order things start in —
because a coordinate like [2-1] is only useful if the 2 does not move. The registry
assigns the number once and never reuses it.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "browsers.py"


def run(state, *args):
    return subprocess.run([sys.executable, str(REG), *args],
                          env={**os.environ, "WBROWSER_STATE_DIR": str(state)},
                          capture_output=True, text=True, timeout=30)


def test_default_is_always_browser_1_on_the_standard_ports(tmp_path):
    out = run(tmp_path, "resolve", "1").stdout.split("\t")
    assert out[0] == "1" and out[2] == "9222" and out[3].strip() == "7981"
    # an empty token means the default too
    assert run(tmp_path, "resolve", "").stdout.startswith("1\t")


def test_a_name_keeps_its_number(tmp_path):
    first = run(tmp_path, "add", "work").stdout
    # re-adding is not a new number, and not an error
    assert run(tmp_path, "add", "work").stdout == first
    # and a third browser does not disturb the second
    run(tmp_path, "add", "image")
    assert run(tmp_path, "add", "work").stdout == first


def test_name_and_number_reach_the_same_browser(tmp_path):
    run(tmp_path, "add", "work")           # -> 2
    by_name = run(tmp_path, "resolve", "work").stdout
    by_num = run(tmp_path, "resolve", "2").stdout
    assert by_name == by_num


def test_ports_do_not_collide_with_the_default(tmp_path):
    run(tmp_path, "add", "work")
    _, _, cdp, eng = run(tmp_path, "resolve", "work").stdout.strip().split("\t")
    assert cdp != "9222" and eng != "7981"


def test_an_unknown_name_is_an_error_with_a_hint(tmp_path):
    p = run(tmp_path, "resolve", "nope")
    assert p.returncode != 0 and "wb new" in p.stderr


def test_a_number_cannot_be_a_browser_name(tmp_path):
    # otherwise `wb -b 2` would be ambiguous: the browser numbered 2, or one named "2"?
    assert run(tmp_path, "add", "2").returncode != 0


# --- tab coordinate is a permanent id, not a position -----------------------
# 🔴 Reported 2026-09-01: order-based numbering renumbers when a tab closes, so
#    "[1-3], look at that one" pointed at a different tab minute to minute. The id
#    must be assigned once and never reused. Verified end-to-end against the e2e
#    browser in the release checks; here we assert the engine has the machinery.
import re as _re


def test_engine_assigns_permanent_tab_ids():
    src = (ROOT / "engine.js").read_text()
    # a monotonic counter, seeded so restarts do not reuse an id
    assert "nextTabId" in src and "tabSeq += 1" in src
    # the coordinate uses the id, not the page's position in the list
    assert "idOf(page)" in src
    assert "pages.indexOf(page)" not in src, "coordinate still uses position, which renumbers"


def test_newtab_is_a_known_key():
    # 🔴 newtab was handled by the engine but missing from KNOWN_KEYS, so {"newtab":true}
    #    came back 400 — measured 2026-09-01.
    src = (ROOT / "engine.js").read_text()
    keys = _re.search(r"KNOWN_KEYS = new Set\(\[(.*?)\]\)", src, _re.S).group(1)
    for k in ("newtab", "newwindow", "fullPage", "limit", "filter"):
        assert f"'{k}'" in keys, f"{k} is handled but not in KNOWN_KEYS"


def test_engine_opens_new_window_via_cdp_not_newpage():
    # 🔵 --window must split the tab into its own OS window. newPage() always makes a
    #    tab in the current window; only CDP's Target.createTarget({newWindow:true})
    #    opens a window. Requested 2026-09-04. Same Chrome/CDP, so control is unchanged.
    src = (ROOT / "engine.js").read_text()
    assert "cmd.newwindow" in src
    assert "Target.createTarget" in src and "newWindow: true" in src


def test_newtab_does_not_open_a_second_orphan_page():
    # 🔴 Reported 2026-09-04: {newtab, goto} added TWO tabs per call — getTab ran first and
    #    created a page for the unknown tab name, then the newtab block created another and
    #    overwrote the map entry, orphaning the first as a mark-less about:blank. That blank
    #    is exactly what piled a session up to 30+ tabs. getTab must be skipped when newtab
    #    (or newwindow) is set, since those open their own page.
    import re
    src = (ROOT / "engine.js").read_text()
    # The behaviour, checked without pinning the exact line formatting: when newtab/newwindow
    # is set, page is null (getTab is skipped); otherwise getTab runs. Match across whitespace
    # so adding an argument or wrapping the line does not falsely fail (2026-09-05).
    assert re.search(r"\(cmd\.newtab\s*\|\|\s*cmd\.newwindow\)\s*\?\s*null\s*:\s*await getTab", src, re.S), \
        "getTab still runs alongside newtab/newwindow — orphan page returns"


def test_engine_reaps_agent_tabs_but_never_marked_by_no_one():
    # 🔴 Requested 2026-09-04 ("it keeps opening tabs"). Agent tabs must be capped so a
    #    session cannot reach 30-40 open tabs. Two rules, and the safety rule is absolute:
    #    a tab is only ever closed if it carries the __wbrowserMark stamp. A human/login tab
    #    has no mark and must never be counted or closed.
    src = (ROOT / "engine.js").read_text()
    assert "function reapAgentTabs" in src
    assert "MAX_AGENT_TABS" in src
    # the mark gate: no mark → skip (never close)
    assert "if (!info || !info.mark) continue;" in src
    # both entry points reap before opening a page
    assert src.count("reapAgentTabs(") >= 2, "reaper not called from both newtab and getTab paths"


def test_connect_reconnects_once_before_blaming_utility_worlds():
    # 🔴 Reported 2026-09-04: a browser websocket went half-dead — connectOverCDP timed out
    #    for hours while raw CDP stayed instant — over a network boundary (Windows Chrome ↔
    #    WSL2 over Tailscale). The engine used to declare "utility worlds, restart Chrome"
    #    on the first timeout, which is wrong for a half-dead socket: a fresh connection
    #    recovers it. connect() must try exactly ONE reconnect (drop the browser, reconnect)
    #    before telling the caller to restart Chrome, and it must not loop.
    src = (ROOT / "engine.js").read_text()
    assert "async function connect(_reconnecting)" in src
    assert "await connect(true);" in src, "no single reconnect attempt"
    assert "!_reconnecting" in src, "reconnect not guarded against looping"
    # the message reached only AFTER the reconnect failed must prescribe the ENGINE restart
    # first (light, tab-safe) and Chrome restart only as the heavier fallback. Updated
    # 2026-09-04 (idifference): the stale state is often the engine's connection, not Chrome.
    assert "First restart the ENGINE" in src
    assert "get the master\\'s OK first" in src   # Chrome restart is gated behind approval


def test_reconnect_is_once_engine_wide_not_once_per_request():
    # 🔴 Reported 2026-09-04 (zalman): [reconnect] logged 68 times in one sitting. The guard
    #    was a function argument (_reconnecting), which resets on every fresh connect() call,
    #    so "once" became once-per-request. It must be an engine-lifetime flag: after the
    #    reconnect fails, later requests skip it until a successful connect clears it.
    src = (ROOT / "engine.js").read_text()
    assert "let reconnectFailed = false;" in src, "no engine-wide reconnect flag"
    # the reconnect branch is gated on the flag being clear
    assert "!_reconnecting && !reconnectFailed" in src
    # failure sets it, success clears it
    assert "reconnectFailed = true;" in src
    assert "reconnectFailed = false; return;" in src
    # 🔴 and a second guard against CONCURRENT reconnects: the failure flag is set only
    #    AFTER the attempt, so back-to-back requests could each start their own before any
    #    failed. Measured 2026-09-04 (zalman): 6 reconnects in 0.96s, some 2ms apart — a
    #    race. An in-progress flag set at the START closes it.
    assert "let reconnecting = false;" in src
    assert "reconnecting = true;" in src          # set before the await
    assert "!reconnecting" in src                 # gate excludes an in-flight reconnect


def test_rawcdp_fallback_exists_and_is_gated_on_a_dead_playwright():
    # 🔴 The raw-CDP fallback is the emergency lane for when playwright's connection is
    #    half-dead (reconnectFailed). It must be reached BEFORE getTab (which would call
    #    connect() and hang), and it must not try to serve newtab/newwindow (those need
    #    playwright). Requested/approved 2026-09-04; zalman proved raw CDP stays live.
    src = (ROOT / "engine.js").read_text()
    assert "async function actViaRawCDP" in src
    assert "if (reconnectFailed && !cmd.newtab && !cmd.newwindow)" in src
    assert "return actViaRawCDP(cmd, tab);" in src
    # the module the fallback drives Chrome with
    raw = (ROOT / "rawcdp.js").read_text()
    assert "Page.navigate" in raw and "Page.captureScreenshot" in raw
    assert "Input.dispatchMouseEvent" in raw
    # click must fail loudly on a zero-size / missing target, never click blindly
    assert "no element matches" in raw and "zero-size box" in raw


def test_rawcdp_attach_probes_for_a_live_tab():
    # 🔴 Reported 2026-09-04 (zalman): the fallback kept picking a half-dead tab (the tabs
    #    playwright killed carry our stamp), so every command timed out while other tabs
    #    answered raw CDP in 3-9ms. attach() must probe each candidate and take the first
    #    that replies, skipping the dead ones.
    raw = (ROOT / "rawcdp.js").read_text()
    assert "no live page target" in raw
    assert "Runtime.evaluate" in raw and "1500" in raw   # short liveness probe

def test_engine_handles_eaddrinuse_instead_of_crashing_silently():
    # 🔴 Reported 2026-09-06 (idifference): a stale engine held the port, so `wb up`'s new engine
    #    hit EADDRINUSE — with no listen-error handler that became an uncaughtException and killed
    #    the NEW process, while the OLD engine kept answering /health. So `wb status` showed ✅ and
    #    "restarted into new code" vs "old engine still running" became indistinguishable. The
    #    server must handle the listen error, name EADDRINUSE, and exit non-zero.
    src = (ROOT / "engine.js").read_text()
    assert "server.on('error'" in src, "server.listen has no error handler — EADDRINUSE crashes"
    assert "EADDRINUSE" in src and "PORT_IN_USE" in src, "the port-in-use case is not named"
    # after saying what happened, exit non-zero so `wb up` (which checks the exit code) reports it
    err_block = src[src.index("server.on('error'"):src.index("server.listen(PORT")]
    assert "process.exit(1)" in err_block, "a failed listen must exit non-zero, not fall through"


def test_wb_up_flags_a_stale_engine_of_a_different_build():
    # 🔴 Same report: "an engine answers" is not "the engine running my code". After a git pull a
    #    stale engine kept answering /health, so `wb up` said "already up" and the user believed
    #    the new code was live. `wb up` must compare the running build to the local version and
    #    warn when they differ (the port is held by an older engine).
    wb = (ROOT / "wb").read_text()
    up_block = wb[wb.index("  up)"):wb.index("  version|")]
    assert "/health" in up_block and "build" in up_block, "wb up does not read the running engine's build"
    assert "OLDER engine" in up_block or "not live" in up_block.lower() or "NOT live" in up_block, \
        "wb up does not warn when the running engine is a stale build"
    assert "wb down && wb up" in up_block, "no remedy told to the user (reload with wb down && wb up)"


def test_wb_log_path_follows_the_browser(tmp_path):
    # 🔴 Reported 2026-09-06 (idifference): `-b <name>` runs its engine on a different port, but
    #    the log path ignored -b — every browser wrote to and read from the same engine.log. A
    #    fallback that happened on the named browser's engine was invisible in `wb -b <name> logs`
    #    (it showed the default log), so "the log is empty" and "it never happened" became
    #    indistinguishable — a silent failure at the exact moment you are debugging. The default
    #    keeps the plain name; a named browser gets its own file; the name is sanitised for a path.
    wb = ROOT / "wb"

    def logpath(*args):
        r = subprocess.run(["bash", str(wb), *args, "logs"],
                           env={**os.environ, "WBROWSER_STATE_DIR": str(tmp_path)},
                           capture_output=True, text=True, timeout=30)
        for tok in (r.stdout + r.stderr).split():
            if tok.endswith(".log"):
                return tok
        return ""

    assert logpath().endswith("/engine.log"), "default browser keeps the plain engine.log"
    assert logpath("-b", "work").endswith("/engine-work.log"), "named browser gets its own file"
    # a browser name is user text — it must not escape into a path
    assert logpath("-b", "a/b c").endswith("/engine-a_b_c.log"), "name not sanitised for the path"


def test_a_failed_revive_never_leaves_a_null_browser_for_the_caller():
    # 🔴 Reported 2026-09-06 (idifference): after v0.17.1/0.17.2, `go` worked but the next
    #    `read`/`eval` crashed with "Cannot read properties of null (reading 'contexts')".
    #    Root cause: getTab's knock fails → reviveIfHalfDead() sets browser=null and its fresh
    #    connect times out → it returned false leaving browser null, and getTab walked straight
    #    into pickContext()'s browser.contexts(). Three things must hold to close this:
    src = (ROOT / "engine.js").read_text()
    # 1) a failed revive marks the engine degraded so the caller routes to the fallback
    revive = src[src.index("async function reviveIfHalfDead("):src.index("function needsFallbackError(")]
    assert "reconnectFailed = true;" in revive, "a failed revive must set reconnectFailed"
    # 2) getTab guards against a null browser instead of dereferencing it, and signals fallback
    assert "function needsFallbackError(" in src
    assert "if (!browser) {" in src and "throw needsFallbackError();" in src, \
        "getTab must guard a null browser before pickContext, not crash on .contexts()"
    # 3) act() catches the sentinel and reroutes to the raw-CDP fallback (not a 500 crash)
    assert "e.needsFallback" in src and "return actViaRawCDP(cmd, tab)" in src, \
        "act() must reroute a needsFallback signal to the raw-CDP fallback"


def test_connect_snapshots_browser_before_reading_contexts():
    # 🔴 Reported 2026-09-06 (idifference RPT-01): the null crash still fired five minutes into a
    #    fresh v0.17.3 engine, at engine.js:335 `ctx = browser.contexts()[0]`. Root cause: the
    #    attach assigns the SHARED `browser` and connectOverCDPBounded() awaits; during that await
    #    a previous connection's 'disconnected' handler can null the shared `browser`, so even a
    #    successful attach can read `.contexts()` off null. connect() must snapshot the handle into
    #    a local and guard it before dereferencing — the same fix applied to tryRecoverFromFallback.
    src = (ROOT / "engine.js").read_text()
    connect_body = src[src.index("async function connect(_reconnecting)"):src.index("async function getTab(")]
    # after the successful-attach path, it reads contexts off a snapshot, not the shared global,
    # and bails to the fallback (not a null deref) if the handle vanished mid-attach.
    assert "const b = browser;" in connect_body, "connect() does not snapshot browser before contexts()"
    assert "b.contexts()" in connect_body, "connect() still reads contexts() off the shared browser"
    assert "throw needsFallbackError();" in connect_body, \
        "connect() must route to the fallback if the handle vanished mid-attach, not crash on null"


def test_fallback_is_not_one_way_playwright_recovery_clears_the_flag():
    # 🔴 Reported 2026-09-06 (idifference): on a machine where the playwright connection comes
    #    and goes (intermittent), the engine dropped to the raw-CDP fallback (reconnectFailed=
    #    true) during one dead spell — and then never came back, because the ONLY place that
    #    clears reconnectFailed is inside connect(), and act() skips connect() entirely while
    #    reconnectFailed is set (it returns actViaRawCDP first). So once trapped in the
    #    fallback, a recovered playwright could not lift the engine out: every command ran raw
    #    CDP, which cannot open a new tab, so `no tab stamped` blocked everything. The fallback
    #    entry was one-way. It must first try to recover playwright and clear the flag; only if
    #    that still fails does it use the fallback.
    src = (ROOT / "engine.js").read_text()
    assert "async function tryRecoverFromFallback(" in src, "no recovery attempt before the fallback"
    # the recovery is attempted at the fallback gate, before actViaRawCDP is returned
    fb = src.index("if (reconnectFailed && !cmd.newtab && !cmd.newwindow)")
    recover = src.index("tryRecoverFromFallback(")
    assert recover < fb, "recovery must be attempted BEFORE the fallback gate, not after"
    # recovery clears the flag when a fresh connect succeeds
    assert "reconnectFailed = false" in src


def test_gettab_reconnects_when_knock_dies_but_raw_cdp_is_up():
    # 🔴 Reported 2026-09-06 (idifference): over a network boundary (Windows Chrome ↔ WSL2),
    #    a browser websocket goes half-dead AFTER a successful connect — the first goto works,
    #    then every later command times out. connect()'s reconnect only fires when
    #    connectOverCDP itself times out; here it succeeds, so isConnected() stays true and
    #    connect() reuses the dead handle forever ("engine-restart per goto"). The tab-reuse
    #    knock in getTab (evaluate round-trip) is the first thing that hangs on the dead socket,
    #    so that is where we detect it: if the knock does not answer but raw CDP is instant,
    #    the browser socket is half-dead — drop it and reconnect once, then retry, instead of
    #    opening another tab on the same dead socket (which hangs identically).
    src = (ROOT / "engine.js").read_text()
    # a single SSOT helper decides "socket half-dead" (raw CDP up while playwright hangs),
    # used by both the connect() timeout path and the getTab knock path — not duplicated.
    assert "async function rawCdpAlive(" in src, "no SSOT helper for the raw-CDP liveness check"
    # getTab's knock failure must consult it and trigger the one-shot reconnect, not just
    # delete the tab and open a fresh one on the same dead socket.
    assert "reviveIfHalfDead" in src, "getTab does not try to revive a half-dead socket"


def test_halfdead_revive_is_bounded_and_one_shot():
    # 🔴 The revive must not loop and must not hang. It reuses the same engine-wide guards as
    #    connect()'s reconnect (reconnectFailed / reconnecting) so a socket that will not come
    #    back does not reconnect on every request, and it is bounded by the same wall-clock
    #    backstop so a second half-dead socket fails fast instead of hanging forever.
    src = (ROOT / "engine.js").read_text()
    # revive drops the dead browser handle and goes through connect(), which is already
    # guarded one-shot and wall-clock-bounded (see the two tests above).
    assert "async function reviveIfHalfDead(" in src
    # it only acts when raw CDP is actually up — never blindly reconnects on any timeout
    assert "rawCdpAlive()" in src


def test_fallback_click_handles_playwright_selectors_and_fails_loudly():
    # 🔴 Reported 2026-09-04 (zalman): fallback click on `button:has-text("...")` / `text=...`
    #    threw a bare "Uncaught" (a querySelector SyntaxError) before any click logic — the
    #    selector was playwright syntax raw CDP does not understand. The resolver now handles
    #    text= / :has-text() by text search, and an unsupported selector fails with a clear
    #    message instead of leaking a SyntaxError.
    raw = (ROOT / "rawcdp.js").read_text()
    assert "text=" in raw and "has-text" in raw
    assert "not supported in the raw-CDP fallback" in raw


def test_rawcdp_socket_error_after_open_does_not_leak():
    # 🔴 An 'error' AFTER the socket opened had no handler — on Node's WebSocket that is an
    #    unhandled rejection that took the engine down on the NEXT request, with no log line
    #    (it died outside every catch). A persistent error listener now fails pending sends
    #    instead of throwing loose. Reported 2026-09-04 (zalman): the crash left only a
    #    [reconnect] line and killed the port.
    raw = (ROOT / "rawcdp.js").read_text()
    assert "websocket error after open" in raw
    # and the reconnect close swallows a late background rejection with a bounded wait
    src = (ROOT / "engine.js").read_text()
    assert "b.close().catch(() => {})" in src


def test_fallback_failure_does_not_kill_the_engine():
    # 🔴 Reported 2026-09-04: a few requests into the fallback the engine crashed — the
    #    caller got an empty body (not even a 500) and the port went dead. A half-closed
    #    websocket's late 'error' becoming an unhandled rejection is the path. Two guards:
    #    close() rejects pending and swallows the late error; the engine has a top-level
    #    unhandledRejection/uncaughtException handler so one bad request never takes the
    #    process down.
    raw = (ROOT / "rawcdp.js").read_text()
    assert "rawcdp: connection closed" in raw            # close() rejects pending
    src = (ROOT / "engine.js").read_text()
    assert "process.on('unhandledRejection'" in src
    assert "process.on('uncaughtException'" in src


def test_500_errors_are_logged():
    # 🔴 A stalled tab returned 500 to the caller but wrote nothing to the log, so there was
    #    no trail. Anything >=500 must leave a line; 400s (caller typos) stay quiet.
    src = (ROOT / "engine.js").read_text()
    assert "[act-error]" in src
    assert "status >= 500" in src


def test_read_timeout_does_not_assert_the_page_changed():
    # 🔴 Reported 2026-09-04: read timed out on a small, static page (1ms of real DOM
    #    work), and the old message "the page kept changing while it was being read"
    #    sent the reporter hunting for an infinite re-render that did not exist. The
    #    timeout has two causes and the message must not assert the one it did not see.
    src = (ROOT / "engine.js").read_text()
    # the old assertive wording is gone
    assert "the page kept changing while it was being read" not in src
    # the timeout branch distinguishes a stalled connection (utility worlds) from a
    # genuinely changing page — and detects it WITHOUT opening a new connection (which
    # would add another world), by checking the raw CDP endpoint answers fast.
    assert "utility worlds" in src
    assert "/json/version" in src  # the world-free liveness probe reused in the read path
    # and it does not claim the page was changing as fact — it says the timeout is what
    # happened, not what was observed (the wording spans a line break in the source, so
    # match the distinctive tail rather than the full sentence).
    assert "not what was observed" in src


def test_agent_name_walks_the_process_tree_not_just_the_parent():
    # 🔴 Reported 2026-09-01: seven tabs read "agent@you" because the name was taken
    #    from the immediate parent only, and an agent often runs wb from a folder that
    #    is not its own AGENT/<name> dir. The session's dir is somewhere up the tree.
    src = (ROOT / "wb").read_text()
    assert 'for _ in 1 2 3 4 5' in src, "only checks the immediate parent"
    # 🔴 And PPid must come from /status, not field 4 of /stat — a process name with a
    #    space or ")" shifts /stat's fields and the walk climbs the wrong tree.
    assert '/status' in src and 'PPid:' in src


def test_roster_lookup_is_gated_and_carries_no_hardcoded_url():
    # 🔴 The roster fallback must not fire for a plain clone, and must not bake in a
    #    private endpoint. It runs only when BOTH an instance id and a roster URL are
    #    present, and the URL comes from the environment / harness file, never a literal.
    src = (ROOT / "wb").read_text()
    assert 'AOE_INSTANCE_ID' in src and 'WBROWSER_ROSTER_URL' in src
    assert '/api/terminals' in src            # built from SELF_PORTAL_URL, not hardcoded host
    import re
    # loopback (127.0.0.1) is the engine's own address and fine; a routable IP would
    # mean a private endpoint was baked in.
    ips = re.findall(r'https?://(\d+\.\d+\.\d+\.\d+)', src)
    leaked = [ip for ip in ips if not ip.startswith('127.')]
    assert not leaked, f"a routable IP leaked into wb: {leaked}"


def test_goto_that_lands_on_about_blank_is_not_reported_as_success():
    # 🔴 Reported 2026-09-04 (idifference): `goto http://<ip>:3100/ko/home` returned success
    #    every time but location.href stayed about:blank — playwright resolved the navigation
    #    without leaving the page (http / IP-literal / non-standard-port / download-typed
    #    response). It cost 20 minutes because nothing failed. goto now checks where it
    #    actually landed and throws (502) instead of a silent success.
    src = (ROOT / "engine.js").read_text()
    assert "goto reported success but the tab is at" in src
    assert "This is not a silent success" in src
    # the check must run on the SUCCESS path, not only on timeout
    assert "const where = await page.evaluate(() => location.href)" in src


def test_goto_surfaces_http_error_status():
    # 🔵 Suggested 2026-09-04 (idifference): a goto that 404s still "succeeds" (the tab loads
    #    the server's 404 body) and the caller cannot see it without the console. We report a
    #    4xx/5xx status instead of hiding it — but do NOT throw, since visiting an error page
    #    on purpose is legitimate.
    # 🔴 Check the behaviour, not one exact line: a >=400 status is captured and ends up on
    #    result.httpStatus. The status is stashed in a local first (result is declared later in
    #    the function — reading it inline was a TDZ crash, fixed 2026-09-05), so match both the
    #    capture and the assignment without pinning the variable name or spacing.
    import re
    src = (ROOT / "engine.js").read_text()
    assert "s >= 400" in src, "the 4xx/5xx threshold is gone"
    assert re.search(r"result\.httpStatus\s*=", src), "httpStatus is no longer set on result"
    # And it must be set AFTER result exists — i.e. not the old inline read that crashed.
    assert re.search(r"const result = \{[^}]*\}[\s\S]*result\.httpStatus\s*=", src), \
        "httpStatus is assigned before result is declared (TDZ risk)"


def test_rawcdp_fallback_is_a_complete_path_not_read_only():
    # 🔴 Reported 2026-09-08 (zalman): playwright 1.63 ↔ Chrome 152 mismatch hangs connectOverCDP;
    #    raw CDP is fine, so the fallback must become a COMPLETE path. Two gaps closed: it could
    #    not open its own tab (→ "no tab stamped" on a fresh go) and could not type a string.
    raw = (ROOT / "rawcdp.js").read_text()
    # raw CDP can now create the tab it drives (browser-scoped Target.createTarget)
    assert "async createTab(" in raw and "Target.createTarget" in raw
    assert "Target.attachToTarget" in raw, "createTab must attach so later sends target the new tab"
    assert "getBrowserWs(" in raw, "createTarget is browser-scoped — connect to the browser ws"
    # raw CDP can type a whole string, not just single keys
    assert "async type(" in raw and "Input.insertText" in raw
    # act() routes a navigating fallback command through createTab when no tab exists, and
    # sends cmd.type to raw.type
    eng = (ROOT / "engine.js").read_text()
    fb = eng[eng.index("async function actViaRawCDP("):eng.index("async function fillLogin(")]
    assert "raw.createTab(" in fb, "actViaRawCDP does not open a tab when none exists"
    assert "raw.type(" in fb, "actViaRawCDP does not route cmd.type to raw CDP"
    # a non-navigating command on no tab still fails honestly (does not conjure a blank tab)
    assert "throw e;" in fb, "a fallback eval/read with no tab must still error, not open a blank"
