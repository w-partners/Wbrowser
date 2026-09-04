#!/usr/bin/env python3
"""Turns wb's arguments into the engine's command JSON.

Building JSON by concatenating strings in the shell breaks once quotes, backslashes,
or non-ASCII text get mixed in. A single " in a search term is enough to silently
send the wrong command.

Usage: mkcmd.py <op> [args...]
"""
import json
import os
import sys


# 🔴 Say what the command needs, in one line the person can act on. Without this a
#    missing argument came out as `IndexError: list index out of range` and a Python
#    traceback — measured 2026-08-31 on `wb go`, `wb click`, `wb type` and `wb press`.
#    Typing a command bare to see what it wants is the most ordinary thing a new user
#    does, and it was answered with a stack trace.
def need(rest, n, usage):
    if len(rest) < n:
        raise SystemExit("Usage: wb %s\n       (run `wb read` first — it lists the "
                         "selectors actually on the page)" % usage)


def build(argv):
    if not argv:
        raise SystemExit("mkcmd: no op given")
    op, rest = argv[0], argv[1:]

    if op == "go":
        # 🔵 --window opens the page in its own OS window instead of a tab in the
        #    current one — same Chrome, same control, just split off so one agent can
        #    watch two pages side by side. --tab <name> names the tab so later commands
        #    (`wb --tab right read`) reach the same one.
        args = list(rest)
        new_window = False
        tab_name = None
        if "--window" in args:
            args.remove("--window")
            new_window = True
        if "--tab" in args:
            i = args.index("--tab")
            if i + 1 >= len(args):
                raise SystemExit("Usage: wb go <url> --tab <name> [--window]")
            tab_name = args[i + 1]
            del args[i:i + 2]
        need(args, 1, "go <url>   [--tab <name>]   [--window]")
        cmd = {"goto": args[0], "read": True}
        if new_window:
            cmd["newwindow"] = True
        if tab_name:
            cmd["tab"] = tab_name
        return cmd
    if op == "read":
        return {"read": True}
    if op == "click":
        need(rest, 1, "click <selector>")
        return {"click": rest[0], "wait": 1200, "read": True}
    if op == "type":
        # Preserve spaces in the text as-is — join all the remaining arguments.
        # 🔵 --fast sets the value in one shot instead of typing it. Quicker on long text
        #    in a plain field, but it is not what a person does, and sites that re-render
        #    while you type will drop part of it. Opt-in for that reason.
        args = list(rest)
        fast = False
        if "--fast" in args:
            args.remove("--fast")
            fast = True
        # 🔵 Only the selector is required — `wb type <selector>` with no text clears
        #    the field, which is a real thing people do. Do not "fix" this into two.
        need(args, 1, "type <selector> [text]   [--fast]   (no text clears the field)")
        cmd = {"type": {"selector": args[0], "text": " ".join(args[1:])}}
        if fast:
            cmd["type"]["fast"] = True
        return cmd
    if op == "press":
        need(rest, 1, "press <key>            e.g. Enter, Tab, Control+A")
        return {"press": rest[0], "wait": 1800, "read": True}
    if op == "shot":
        return {"shot": True}
    if op == "console":
        # If a first argument is present, use it as a filter (regex)
        c = {"console": True, "errors": True, "limit": 60}
        if rest:
            c["filter"] = " ".join(rest)
        return c
    if op == "errors":
        return {"errors": True, "limit": 60}
    if op == "network":
        c = {"network": True, "limit": 60}
        if rest:
            c["filter"] = " ".join(rest)
        return c
    if op == "eval":
        need(rest, 1, "eval <javascript>")
        return {"eval": " ".join(rest)}
    raise SystemExit("mkcmd: unknown op %r" % op)


if __name__ == "__main__":
    cmd = build(sys.argv[1:])
    # The account comes in via an environment variable — mixed in as a positional
    # argument it becomes indistinguishable from the text.
    acct = os.environ.get("WIN_ACCOUNT_RESOLVED", "").strip()
    if acct:
        cmd["account"] = acct
    # 🔵 Attach which agent opened the tab to its title — the user has to be able to
    #    tell them apart by eye in the Chrome tab bar. If we don't pass it, no marker appears.
    agent = os.environ.get("WIN_AGENT", "").strip()
    if agent:
        cmd["agent"] = agent
    print(json.dumps(cmd, ensure_ascii=False))
