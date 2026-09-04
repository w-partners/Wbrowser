#!/usr/bin/env python3
"""Argument -> command JSON, the layer between what a person types and what the engine runs.

Run: python3 -m unittest discover -s test -p 'test_*.py'

These need no browser and no dependencies. The point is not that the JSON is
well-formed -- json.dumps guarantees that. The point is that the *meaning* of an
argument survives the trip: a space stays a space, a quote does not truncate the
text, and a flag changes one field rather than being swallowed into the payload.
"""
import os
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


if __name__ == "__main__":
    unittest.main()


# 🔴 Typing a command bare to see what it wants is the most ordinary thing a new user
#    does. Until 0.9.7 it was answered with `IndexError: list index out of range` and a
#    Python traceback — measured on go, click, type and press.
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
