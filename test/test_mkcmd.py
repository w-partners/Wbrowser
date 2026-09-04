#!/usr/bin/env python3
"""Argument -> command JSON, the layer between what a person types and what the engine runs.

Run: python3 -m unittest discover -s test -p 'test_*.py'

These need no browser and no dependencies. The point is not that the JSON is
well-formed -- json.dumps guarantees that. The point is that the *meaning* of an
argument survives the trip: a space stays a space, a quote does not truncate the
text, and a flag changes one field rather than being swallowed into the payload.
"""
import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mkcmd  # noqa: E402


class TestType(unittest.TestCase):
    def test_joins_the_text_with_spaces(self):
        # The shell splits on spaces, so 'hello world' arrives as two arguments.
        # Dropping the join would type only the first word and report success.
        cmd = mkcmd.build(["type", "#q", "hello", "world"])
        self.assertEqual(cmd["type"]["text"], "hello world")
        self.assertEqual(cmd["type"]["selector"], "#q")

    def test_defaults_to_real_keystrokes(self):
        # The default must NOT be fast. Typing like a person is the reason this
        # tool exists; a fast default breaks re-rendering composers silently.
        cmd = mkcmd.build(["type", "#q", "text"])
        self.assertNotIn("fast", cmd["type"])

    def test_fast_flag_sets_the_field_and_leaves_the_text(self):
        cmd = mkcmd.build(["type", "--fast", "#q", "hello", "world"])
        self.assertTrue(cmd["type"]["fast"])
        self.assertEqual(cmd["type"]["text"], "hello world")

    def test_fast_flag_is_removed_from_the_text(self):
        # If --fast leaked into the payload the user would see the flag typed
        # into the page, which looks like the tool ignored them.
        cmd = mkcmd.build(["type", "#q", "--fast", "hello"])
        self.assertNotIn("--fast", cmd["type"]["text"])
        self.assertTrue(cmd["type"]["fast"])

    def test_quotes_and_backslashes_survive(self):
        # This is the whole reason mkcmd exists instead of shell string concat.
        text = 'say "hi" \\ then stop'
        cmd = mkcmd.build(["type", "#q", text])
        self.assertEqual(cmd["type"]["text"], text)

    def test_non_ascii_survives(self):
        cmd = mkcmd.build(["type", "#q", "안녕하세요", "🔵"])
        self.assertEqual(cmd["type"]["text"], "안녕하세요 🔵")

    def test_empty_text_is_allowed(self):
        # Clearing a field is a legitimate action, not an error.
        cmd = mkcmd.build(["type", "#q"])
        self.assertEqual(cmd["type"]["text"], "")


class TestOtherOps(unittest.TestCase):
    def test_go_asks_for_a_read(self):
        # Navigating without reading back leaves the caller guessing what loaded.
        cmd = mkcmd.build(["go", "https://example.com"])
        self.assertEqual(cmd["goto"], "https://example.com")
        self.assertTrue(cmd["read"])

    def test_click_waits_before_reading(self):
        # A click that reads instantly reports the pre-click page as the result.
        cmd = mkcmd.build(["click", "button.submit"])
        self.assertEqual(cmd["click"], "button.submit")
        self.assertGreater(cmd["wait"], 0)

    def test_eval_joins_its_argument_back_together(self):
        cmd = mkcmd.build(["eval", "document.title", "+", "1"])
        self.assertEqual(cmd["eval"], "document.title + 1")

    def test_console_filter_is_optional(self):
        self.assertNotIn("filter", mkcmd.build(["console"]))
        self.assertEqual(mkcmd.build(["console", "MyApp"])["filter"], "MyApp")

    def test_shot_takes_no_arguments(self):
        self.assertEqual(mkcmd.build(["shot"]), {"shot": True})


class TestTabAtAnyPosition(unittest.TestCase):
    # 🔴 Reported 2026-09-04: `wb read --tab tk` silently dropped both tokens and read the
    #    DEFAULT tab (usually an about:blank), costing 20 minutes diagnosing a "dead site".
    #    --tab is now parsed in wb (any position, any command) and arrives via WIN_TAB; mkcmd
    #    attaches it. Run mkcmd as a subprocess because the WIN_TAB handling is in __main__.
    MK = os.path.join(os.path.dirname(__file__), "..", "mkcmd.py")

    def _run(self, args, win_tab=None):
        env = dict(os.environ)
        if win_tab is not None:
            env["WIN_TAB"] = win_tab
        out = subprocess.run([sys.executable, self.MK, *args], env=env,
                             capture_output=True, text=True).stdout
        return json.loads(out)

    def test_win_tab_attaches_to_read(self):
        cmd = self._run(["read"], win_tab="tk")
        self.assertEqual(cmd.get("tab"), "tk")

    def test_win_tab_attaches_to_eval(self):
        cmd = self._run(["eval", "1+1"], win_tab="right")
        self.assertEqual(cmd.get("tab"), "right")

    def test_no_win_tab_means_no_tab_key(self):
        cmd = self._run(["read"], win_tab="")
        self.assertNotIn("tab", cmd)

    def test_explicit_go_tab_is_not_overwritten_by_win_tab(self):
        # go --tab set it in build(); an env WIN_TAB must not clobber an explicit one.
        cmd = self._run(["go", "https://a.com", "--tab", "explicit"], win_tab="fromenv")
        self.assertEqual(cmd.get("tab"), "explicit")


class TestGoWindowAndTab(unittest.TestCase):
    # 🔵 --window opens the page in its own OS window (same Chrome, same control) so one
    #    agent can watch two pages side by side; --tab names the tab so later commands
    #    reach the same one. Requested 2026-09-04.
    def test_plain_go_opens_no_new_window(self):
        # The default must stay a tab in the current window — a stray newwindow would
        # spawn a window on every navigation.
        cmd = mkcmd.build(["go", "https://a.com"])
        self.assertNotIn("newwindow", cmd)
        self.assertNotIn("tab", cmd)

    def test_window_flag_sets_newwindow_and_keeps_the_url(self):
        cmd = mkcmd.build(["go", "https://a.com", "--window"])
        self.assertTrue(cmd["newwindow"])
        self.assertEqual(cmd["goto"], "https://a.com")
        # the flag must not become the url or a second positional
        self.assertNotIn("--window", cmd.values())

    def test_tab_names_the_tab_and_is_not_the_url(self):
        cmd = mkcmd.build(["go", "https://a.com", "--tab", "right"])
        self.assertEqual(cmd["tab"], "right")
        self.assertEqual(cmd["goto"], "https://a.com")

    def test_window_and_tab_combine(self):
        cmd = mkcmd.build(["go", "https://a.com", "--tab", "right", "--window"])
        self.assertTrue(cmd["newwindow"])
        self.assertEqual(cmd["tab"], "right")
        self.assertEqual(cmd["goto"], "https://a.com")

    def test_tab_without_a_name_is_an_error_not_a_swallowed_url(self):
        # `--tab` with nothing after it must not eat the url or pass silently.
        with self.assertRaises(SystemExit):
            mkcmd.build(["go", "https://a.com", "--tab"])


class TestRejections(unittest.TestCase):
    def test_no_op_is_an_error(self):
        with self.assertRaises(SystemExit):
            mkcmd.build([])

    def test_unknown_op_is_an_error(self):
        # Silently returning {} here would send an empty command and the engine
        # would answer "done" without doing anything.
        with self.assertRaises(SystemExit):
            mkcmd.build(["frobnicate", "x"])

    def test_unknown_flag_on_a_fixed_shape_command_is_an_error(self):
        # 🔴 Reported 2026-09-05: an unknown --flag was swallowed as a positional and did
        #    nothing, so the command ran under the wrong identity and shot saved another
        #    agent's tab. A flag that looks like it works but is ignored must fail, named.
        for argv in (["shot", "--bogus"], ["read", "--foo"],
                     ["go", "http://x", "--agent", "n"], ["click", "#b", "--nope"],
                     ["press", "Enter", "--x"], ["errors", "--y"]):
            with self.assertRaises(SystemExit, msg=f"{argv} was accepted"):
                mkcmd.build(argv)

    def test_double_dash_is_still_allowed_inside_free_text(self):
        # eval/type/console/network carry free text — a literal -- there is content, not a
        # flag, and must not be rejected.
        self.assertEqual(mkcmd.build(["eval", "a --b"])["eval"], "a --b")
        self.assertEqual(mkcmd.build(["type", "#s", "hello --world"])["type"]["text"],
                         "hello --world")
        self.assertEqual(mkcmd.build(["console", "--tag"])["filter"], "--tag")


if __name__ == "__main__":
    unittest.main()


# 🔴 Typing a command bare to see what it wants is the most ordinary thing a new user
#    does. Until 0.9.7 it was answered with `IndexError: list index out of range` and a
#    Python traceback — measured on go, click, type and press.
def test_wb_agent_flag_sets_identity_and_is_not_swallowed():
    """🔴 Reported 2026-09-05: `wb go URL --agent <name>` was swallowed as a positional
    (wb had no such flag), so the run kept its auto-derived identity and `shot` saved a
    *different* agent's tab. wb must (a) parse --agent into the command's identity and
    (b) strip it so mkcmd never sees it as an unknown flag. Proven end to end against a
    stub engine that echoes the posted JSON back.
    """
    import subprocess, textwrap, socket, time, shutil, tempfile
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    port = 7994
    with socket.socket() as s:      # pick the fixed port only if free; skip if busy
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return
    body_file = Path(tempfile.gettempdir()) / "wb_posted_body.txt"
    if body_file.exists():
        body_file.unlink()
    srv = root / "test" / "_echo_engine.js"
    # The stub records the exact POST body to a file — fmt.py's rendering of the reply
    # would otherwise hide what was actually sent, and it is the sent identity we test.
    srv.write_text(textwrap.dedent("""
        const http = require("http"), fs = require("fs");
        http.createServer((q, r) => {
          let b = ""; q.on("data", c => b += c);
          q.on("end", () => {
            try { fs.writeFileSync(process.env.WB_BODY_OUT, b); } catch (e) {}
            r.writeHead(200, {"Content-Type": "application/json"});
            r.end(JSON.stringify({ok: true}));
          });
        }).listen(%d, "127.0.0.1");
    """ % port))
    proc = subprocess.Popen([shutil.which("node"), str(srv)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={**os.environ, "WB_BODY_OUT": str(body_file)})
    try:
        for _ in range(40):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.25)
        env = {**os.environ, "WBROWSER_PORT": str(port)}
        p = subprocess.run([str(root / "wb"), "go", "http://x", "--agent", "testagent"],
                           cwd=root, env=env, capture_output=True, text=True, timeout=30)
        out = p.stdout + p.stderr
        assert "unknown option" not in out, f"--agent leaked to mkcmd: {out}"
        for _ in range(20):                 # the POST is fire-and-forget; wait for the file
            if body_file.exists():
                break
            time.sleep(0.1)
        assert body_file.exists(), f"engine was never POSTed to (out={out!r})"
        posted = body_file.read_text()
        assert '"agent": "testagent"' in posted or '"agent":"testagent"' in posted, \
            f"--agent did not set the posted identity: {posted}"
    finally:
        proc.terminate()
        for f in (srv, body_file):
            try: f.unlink()
            except FileNotFoundError: pass


def test_missing_arguments_print_usage_not_a_traceback():
    import subprocess, sys
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    for op in ("go", "click", "type", "press", "eval"):
        p = subprocess.run([sys.executable, str(root / "mkcmd.py"), op],
                           capture_output=True, text=True, timeout=30)
        out = p.stdout + p.stderr
        assert p.returncode != 0, f"{op} with no argument was accepted"
        assert "Usage:" in out, f"{op} did not say what it needs: {out[:120]}"
        assert "Traceback" not in out, f"{op} still shows a traceback"
