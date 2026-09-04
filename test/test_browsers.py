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
    src = (ROOT / "engine.js").read_text()
    assert "(cmd.newtab || cmd.newwindow) ? null : await getTab" in src, \
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
    # the restart-Chrome message must be reachable only AFTER the reconnect failed
    assert "even on a fresh connection" in src


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
