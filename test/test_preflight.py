"""The install guard — the one thing that must never say "ready" when it is not.

A clone that skipped `npm install` used to get `✅ Chrome · ✅ Engine` from
`wb status`, because every command talks to an engine over HTTP and someone else's
engine was answering. The commands then ran against a stranger's browser and looked
like they had worked. Present from 0.1.0 to 0.9.3.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def bare_clone(tmp_path):
    """A checkout with the source but no node_modules — what `git clone` gives you."""
    dest = tmp_path / "clone"
    dest.mkdir()
    for name in ("wb", "preflight.js", "package.json", "engine.js", "mcp-server.js", "fmt.py", "mkcmd.py"):
        shutil.copy(ROOT / name, dest / name)
    (dest / "wb").chmod(0o755)
    return dest


def run(cwd, *args):
    return subprocess.run([str(cwd / "wb"), *args], cwd=cwd,
                          capture_output=True, text=True, timeout=60)


def test_every_command_refuses_without_dependencies(tmp_path):
    d = bare_clone(tmp_path)
    # 🔴 Not a list of the verbs we remembered — that is how `shot` and `tabs` stayed
    #    open after the first attempt at this fix. The gate runs before dispatch, so
    #    anything that is not explicitly exempt must be refused.
    for cmd in ("status", "read", "shot", "tabs", "eval", "press", "click"):
        p = run(d, cmd)
        assert p.returncode != 0, f"{cmd} succeeded on a clone with nothing installed"
        assert "npm install" in (p.stdout + p.stderr), f"{cmd} refused without saying why"


def test_the_refusal_says_the_port_may_be_someone_elses(tmp_path):
    # The dangerous part is not the missing install, it is what answers instead.
    p = run(bare_clone(tmp_path), "status")
    assert "someone else" in (p.stdout + p.stderr)


def test_version_still_works_without_dependencies(tmp_path):
    # Reading a version out of a file needs nothing installed, and refusing it would
    # make "which version am I on" impossible exactly when you need to ask.
    p = run(bare_clone(tmp_path), "version")
    assert p.returncode == 0 and "wbrowser" in p.stdout


def test_the_check_lives_in_exactly_one_place(tmp_path):
    # 🔴 This was in three files with three different tests (a directory check in the
    #    shell, require.resolve in each entry point). Three tests for one fact can
    #    disagree, and the one that passes is whichever you happen to run.
    hits = subprocess.run(
        ["grep", "-rln", "node_modules/playwright", "wb", "engine.js", "mcp-server.js"],
        cwd=ROOT, capture_output=True, text=True).stdout.split()
    assert hits == [], f"install detection leaked back into {hits}"


def test_every_runnable_entry_point_is_guarded():
    """🔴 Not a list — the list is what failed. `cron.js` and `launch.js` were missed
    on the first pass because they do not import playwright themselves, so they ran
    happily on a clone with nothing installed: `cron list` printed the schedule as
    though it were live, and `launch.js` said ALREADY_UP after attaching to somebody
    else's Chrome. Anything with a shebang or a main guard has to be covered, and the
    next file added is covered by this test rather than by someone remembering.
    """
    exempt = {"preflight.js"}          # it *is* the check
    libraries = {"journal.js", "rawcdp.js", "vault.js", "loginfields.js", "credaudit.js", "sitememory.js"}   # required by others, never run directly
    missing = []
    for js in sorted(ROOT.glob("*.js")):
        if js.name in exempt or js.name in libraries:
            continue
        if "require('./preflight')" not in js.read_text():
            missing.append(js.name)
    assert not missing, f"entry points with no install guard: {missing}"


def test_a_typo_fails_instead_of_printing_help(tmp_path):
    """🔴 `wb reed` used to print the help text and exit 0, so it looked like it had
    run and a script wrapping it could not tell. Same shape as the engine accepting
    {"action":"read"} with a 200 — a mistake that reports success sends you looking
    at the browser instead of at what you typed.
    """
    # 🔵 Run it in the real checkout: the dependency gate answers first in a bare
    #    clone, and faking node_modules does not fool preflight (it uses
    #    require.resolve, not a directory check — deliberately).
    d = ROOT
    p = run(d, "reed")
    assert p.returncode != 0, "an unknown command exited 0"
    assert "No such command" in (p.stdout + p.stderr)

    ok = run(d, "help")
    assert ok.returncode == 0, "help should still succeed"


def test_slow_is_not_reported_as_dead(tmp_path):
    """🔴 Reported 2026-08-31 from a machine at load 26: /health answered 200 in 11.2s
    and `wb up` called it "won't come up". The engine was fine; the box was busy.
    A fixed 2s limit was deciding a question it could not see.
    """
    import subprocess, sys, textwrap, time, socket
    port = 7996
    srv = tmp_path / "slow.js"
    srv.write_text(textwrap.dedent("""
        const http = require("http");
        http.createServer((q, r) => setTimeout(() => {
          r.writeHead(200, {"Content-Type": "application/json"});
          r.end(JSON.stringify({ok: true, browser: true, build: "t", startedAt: "x"}));
        }, 4000)).listen(%d, "127.0.0.1");
    """ % port))
    proc = subprocess.Popen([shutil.which("node"), str(srv)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):                       # wait for the port, not a fixed sleep
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.25)
        env = {**os.environ, "WBROWSER_PORT": str(port)}
        p = subprocess.run([str(ROOT / "wb"), "status"], cwd=ROOT, env=env,
                           capture_output=True, text=True, timeout=90)
        assert "✅ Engine" in p.stdout, f"a 4s reply was called dead:\n{p.stdout}"

        # And with the old limit it must still explain itself rather than just failing.
        p2 = subprocess.run([str(ROOT / "wb"), "status"], cwd=ROOT,
                            env={**env, "WB_HEALTH_TIMEOUT": "1"},
                            capture_output=True, text=True, timeout=90)
        out = p2.stdout + p2.stderr
        assert "no answer within 1s" in out and "WB_HEALTH_TIMEOUT" in out, out
    finally:
        proc.terminate()


def test_cdp_probe_honours_its_own_timeout(tmp_path):
    """🔴 Reported 2026-09-04: `_cdp_up` (the Chrome/CDP check behind `wb status`) had a
    hardcoded 2s timeout while `_engine_up` honoured WB_HEALTH_TIMEOUT. On a loaded box a
    healthy Chrome answering /json/version just over 2s was read as "❌ Chrome", and the
    layer-diagnosis then sent people to restart Chrome (closing other agents' tabs).
    A slow CDP is not a dead CDP — and the limit must be overridable, like the engine one.
    """
    import subprocess, textwrap, time, socket
    port = 9298
    srv = tmp_path / "slowcdp.js"
    srv.write_text(textwrap.dedent("""
        const http = require("http");
        http.createServer((q, r) => setTimeout(() => {
          r.writeHead(200, {"Content-Type": "application/json"});
          r.end(JSON.stringify({Browser: "Chrome/1.2.3", webSocketDebuggerUrl: "ws://x"}));
        }, 4000)).listen(%d, "127.0.0.1");
    """ % port))
    proc = subprocess.Popen([shutil.which("node"), str(srv)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.25)
        env = {**os.environ, "WBROWSER_CDP_PORT": str(port)}
        # Default (5s) must call a 4s reply alive — slow is not dead.
        p = subprocess.run([str(ROOT / "wb"), "status"], cwd=ROOT, env=env,
                           capture_output=True, text=True, timeout=90)
        assert "✅ Chrome" in p.stdout, f"a 4s CDP reply was called dead:\n{p.stdout}"
        # And the limit is overridable: a 1s budget on the same 4s reply reads as down.
        p2 = subprocess.run([str(ROOT / "wb"), "status"], cwd=ROOT,
                            env={**env, "WB_CDP_TIMEOUT": "1"},
                            capture_output=True, text=True, timeout=90)
        assert "❌ Chrome" in p2.stdout, f"WB_CDP_TIMEOUT=1 did not shorten the wait:\n{p2.stdout}"
    finally:
        proc.terminate()


def test_tabs_says_slow_not_dead_when_engine_is_alive_but_slow(tmp_path):
    """🔴 Reported 2026-09-05 (idifference): `wb status` (WB_HEALTH_TIMEOUT=30) said the engine
    was up while `wb tabs` (default timeout) said "Engine is not running" for the SAME live-but-
    slow engine. A bare `_engine_up ||` throws the reason away and reads as "never started",
    sending the reader to `wb up` when the fix is a longer timeout / a restart. Every engine-
    gated command must distinguish slow from dead, the way status already does.
    """
    import subprocess, textwrap, time, socket
    port = 7993
    srv = tmp_path / "slowhealth.js"
    # /health answers 200 with a good body, but only after 3s — so a 1s probe times out (000)
    # even though the engine is plainly alive and listening.
    srv.write_text(textwrap.dedent("""
        const http = require("http");
        http.createServer((q, r) => setTimeout(() => {
          r.writeHead(200, {"Content-Type": "application/json"});
          r.end(JSON.stringify({ok: true, browser: true, build: "t", startedAt: "x"}));
        }, 3000)).listen(%d, "127.0.0.1");
    """ % port))
    proc = subprocess.Popen([shutil.which("node"), str(srv)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.25)
        env = {**os.environ, "WBROWSER_PORT": str(port), "WB_HEALTH_TIMEOUT": "1"}
        p = subprocess.run([str(ROOT / "wb"), "tabs"], cwd=ROOT, env=env,
                           capture_output=True, text=True, timeout=60)
        out = p.stdout + p.stderr
        # 🔴 The censored message must be gone: a slow engine is not "not running".
        assert "not running" not in out, f"tabs still calls a slow engine 'not running':\n{out}"
        # It must instead say WHY (slow / no answer within Ns), like status does.
        assert "no answer within" in out or "too slow" in out, \
            f"tabs did not explain that the engine was slow:\n{out}"
    finally:
        proc.terminate()
