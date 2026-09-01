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
    for k in ("newtab", "fullPage", "limit", "filter"):
        assert f"'{k}'" in keys, f"{k} is handled but not in KNOWN_KEYS"


def test_agent_name_walks_the_process_tree_not_just_the_parent():
    # 🔴 Reported 2026-09-01: seven tabs read "agent@pasia" because the name was taken
    #    from the immediate parent only, and an agent often runs wb from a folder that
    #    is not its own AGENT/<name> dir. The session's dir is somewhere up the tree.
    src = (ROOT / "wb").read_text()
    assert 'for _ in 1 2 3 4 5' in src, "only checks the immediate parent"
    # 🔴 And PPid must come from /status, not field 4 of /stat — a process name with a
    #    space or ")" shifts /stat's fields and the walk climbs the wrong tree.
    assert '/status' in src and 'PPid:' in src
