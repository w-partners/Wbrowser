#!/usr/bin/env python3
"""Decides whether the Chrome we are attached to is a 'logged-in window' or an 'empty dedicated window'.

Why this is needed: the fact that CDP responds only means the browser is alive,
not that it holds any login assets. We have actually driven an empty window
while reporting that we were ready.

The decision is made from the profile path — the cookie file size can't be read
because the original is locked, and page content requires opening a page, which is
slow. The userDataDir that CDP reports is the cheapest and surest discriminator.
"""
import json
import os
import sys
import urllib.request


def cdp_json(cdp, path, timeout=3):
    with urllib.request.urlopen(cdp + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def profile_from_sidecar():
    """Reads the .session.json left behind by launch.js.

    🔵 This is better than asking Chrome for chrome://version:
       · Chrome 151 does not give userDataDir on /json/version (measured)
       · No need to open a tab
       · Not shaken by the Chrome version or language setting
    But if Chrome was launched without going through launch.js, it may be absent → None.
    """
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".session.json")
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return None
    # If it differs from the CDP port we are attached to, it's someone else's record — don't use it.
    want = os.environ.get("WBROWSER_CDP_PORT")
    if want and str(d.get("cdpPort")) != str(want):
        return None
    return d.get("profileDir")


def profile_of(cdp):
    """Finds out the profile directory.

    🔴 /json/version does not give userDataDir (Chrome 151, measured 2026-08-23).
       So we open the chrome://version page and read its 'Profile Path' row —
       that page is the SSOT for the profile location.
    """
    try:
        v = cdp_json(cdp, "/json/version")
        browser = v.get("Browser")
    except Exception:
        return None, None
    if v.get("userDataDir"):          # if this version does give it, use it as-is
        return browser, v["userDataDir"]

    # 🔴 Ask ourselves before asking Chrome. launch.js knows the profile for certain —
    #    it passed it on the command line — and writes it to runtime.json. Reading that
    #    back is free and exact, while the fallback below opens a tab and scrapes a page.
    #
    #    Measured 2026-08-25: status printed "Profile unknown" for hours while
    #    runtime.json sat there holding the answer, and someone reasonably concluded the
    #    agent might be driving the wrong Chrome. The value existed; nothing read it.
    #
    #    🔵 Only trust it if it describes *this* Chrome — a stale file from a previous
    #    run would be worse than saying nothing, so the CDP port has to match.
    try:
        state = os.path.join(
            os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"),
            "wbrowser", "runtime.json")
        with open(state, encoding="utf-8") as fh:
            rt = json.load(fh)
        if rt.get("profileDir") and str(rt.get("cdpPort")) == str(cdp.rsplit(":", 1)[-1]):
            return browser, rt["profileDir"]
    except Exception:
        pass                          # no state file, or it is not about this Chrome

    # Read chrome://version through the engine
    import re
    engine = os.environ.get("WBROWSER_ENGINE", "http://127.0.0.1:7981")
    # 🔴 Close the probe tab after reading. It used to stay open, so every `wb status` left one
    #    chrome://version tab behind — 73 of 79 tabs on one machine (2026-11-13). Close only the
    #    version tabs that appeared during this call, never one that was already open.
    def version_tabs():
        try:
            return {t["id"] for t in cdp_json(cdp, "/json")
                    if t.get("type") == "page" and t.get("url", "").startswith("chrome://version")}
        except Exception:
            return None
    before = version_tabs()
    try:
        body = json.dumps({"tab": "_whoami", "newtab": True,
                           "goto": "chrome://version", "wait": 600, "read": True}).encode()
        req = urllib.request.Request(engine + "/act", data=body,
                                     headers={"Content-Type": "application/json"})
        page = (json.load(urllib.request.urlopen(req, timeout=25)).get("page") or {})
        text = page.get("text", "")
    except Exception:
        text = ""
    finally:
        after = version_tabs()
        if before is not None and after:
            for tid in after - before:
                try:
                    urllib.request.urlopen(cdp + "/json/close/" + tid, timeout=3).read()
                except Exception as e:
                    print(f"   (could not close the probe tab {tid}: {e})", file=sys.stderr)
    if not text:
        return browser, None

    # Grab the Windows path that follows '프로필 경로' / 'Profile Path'
    # (the Korean label matches the Korean-language Chrome UI — do not translate it)
    m = re.search(r"(?:프로필 경로|Profile Path)\s*[:\s]\s*([A-Za-z]:\\[^\n]+)", text)
    if not m:
        # Even without the label, find the path itself (independent of the language setting)
        m = re.search(r"([A-Za-z]:\\[^\n]*User Data\\[^\n]*)", text) \
            or re.search(r"([A-Za-z]:\\[^\n]*\.wbrowser[^\n]*)", text)
    return browser, (m.group(1).strip() if m else None)


def wsl_path(win_path):
    """Windows path to WSL path (C:\\<path> → /mnt/c/<path>)"""
    if not win_path or len(win_path) < 3 or win_path[1] != ":":
        return None
    return "/mnt/%s/%s" % (win_path[0].lower(), win_path[2:].replace("\\", "/").lstrip("/"))


def describe(user_data_dir):
    """Looks at the profile folder to find out which account it is. None if unknown."""
    p = wsl_path(user_data_dir)
    if not p:
        return None
    # user_data_dir may be the parent (User Data), or the profile folder itself.
    for base, prof in ((p, "Default"), (os.path.dirname(p), os.path.basename(p))):
        ls = os.path.join(base, "Local State")
        if not os.path.exists(ls):
            continue
        try:
            with open(ls, encoding="utf-8", errors="replace") as f:
                cache = json.load(f).get("profile", {}).get("info_cache", {})
        except Exception:
            continue
        # If there is only one profile, take it; if several, look it up by name
        if prof in cache:
            return base, prof, cache[prof].get("user_name") or cache[prof].get("name") or ""
        if len(cache) == 1:
            only = list(cache.items())[0]
            return base, only[0], only[1].get("user_name") or only[1].get("name") or ""
    return None


def cookie_domains(base, prof):
    """Number of cookie domains — a rough measure of how large the login assets are."""
    import shutil
    import sqlite3
    import tempfile
    src = os.path.join(base, prof, "Network", "Cookies")
    if not os.path.exists(src):
        return None
    tmp = os.path.join(tempfile.mkdtemp(), "c.db")
    try:
        shutil.copy2(src, tmp)          # the original is locked, so work on a copy
        con = sqlite3.connect(tmp)
        n = con.execute("SELECT COUNT(DISTINCT host_key) FROM cookies").fetchone()[0]
        con.close()
        return n
    except Exception:
        return None


def live_cookie_count():
    """Asks the engine for the cookie count of the live browser.

    Returns: (cookie count, domain count). If the engine does not respond, (None, None) —
    🔴 we do not paper over it with 0. 'unknown' and 'none' are different things.
    """
    engine = os.environ.get("WBROWSER_ENGINE", "http://127.0.0.1:7981")
    try:
        with urllib.request.urlopen(engine + "/logins", timeout=20) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception:
        return None, None
    total = 0
    doms = 0
    for c in d.get("contexts", []):
        total += c.get("totalCookies") or 0
        doms += len(c.get("domains") or [])
    return total, doms


def main():
    cdp = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9222"
    verbose = "--verbose" in sys.argv

    browser, udd = profile_of(cdp)
    if not browser:
        print("   ❌ No CDP response")
        return 1

    # 🔵 If Chrome won't tell us, use the record left behind by launch.js.
    if not udd:
        udd = profile_from_sidecar()

    if not udd:
        # 🔴 If we don't know, we say we don't know. We do not guess and claim 'logged in'.
        print("   🔵 Profile unknown — this Chrome version does not report userDataDir")
        return 0

    info = describe(udd)
    if not info:
        print("   🔵 Profile path: %s (account unconfirmed)" % udd)
        return 0

    base, prof, account = info
    # 🔵 Deciding "is this a dedicated profile" from the folder name alone is wrong —
    #    the user can give a different name via WBROWSER_PROFILE_DIR (measured).
    #    If it is not Chrome's default data folder, treat it as dedicated.
    is_agent_only = (
        ".wbrowser" in udd
        or ("User Data" not in udd and "Chrome" not in udd)
    )

    if is_agent_only:
        # A dedicated profile is the normal path (Chrome 136+ blocks CDP on the default profile).
        # The issue is not 'that it is dedicated' but 'how many logins it has'.
        #
        # 🔴 Do not read the file (Cookies) — Chrome holds a lock on it, and some cookies
        #    have not been written to disk yet. Asking the live browser is what's accurate.
        #    (measured 2026-08-23: 0 by file vs 76 in reality)
        n, doms = live_cookie_count()
        if n:
            print("   ✅ Agent-dedicated window · %d cookies / %d domains" % (n, doms))
        elif n == 0:
            print("   🔵 Agent-dedicated window — no logins yet")
            print("      If you log in from this window it stays that way, and I use it in that state.")
        else:
            print("   🔵 Agent-dedicated window (login count unconfirmed — the engine is not responding)")
    else:
        n = cookie_domains(base, prof)
        extra = " · %d cookie domains" % n if n else ""
        print("   ✅ Logged-in window: %s (%s)%s" % (account or "(account unknown)", prof, extra))

    if verbose:
        print("      path: %s" % udd)
        print("      chrome: %s" % browser)
    return 0


if __name__ == "__main__":
    sys.exit(main())
