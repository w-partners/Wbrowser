"""The install guard — the one thing that must never say "ready" when it is not.

A clone that skipped `npm install` used to get `✅ Chrome · ✅ Engine` from
`wb status`, because every command talks to an engine over HTTP and someone else's
engine was answering. The commands then ran against a stranger's browser and looked
like they had worked. Present from 0.1.0 to 0.9.3.
"""
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
