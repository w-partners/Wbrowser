#!/usr/bin/env python3
"""Prints wb's JSON responses in a human-readable form.

Left as an inline `python3 -c`, it breaks once shell quoting and f-string escaping
get mixed together (it actually broke — 2026-08-23). Keeping it as a file removes that layer.
"""
import json
import sys


def sel_of(x):
    """Builds a selector pointing at an input field. Most specific first: id > name > tag."""
    if x.get("id"):
        return "#" + x["id"]
    if x.get("name"):
        return "[name=%s]" % x["name"]
    return x.get("tag") or "?"


def main():
    raw = sys.stdin.read()
    try:
        d = json.loads(raw)
    except Exception:
        # If it can't be parsed, show the raw text as-is. We do not swallow it silently.
        print(raw.strip() or "(empty response — is the engine up? ./wb status)")
        return 1

    if "error" in d:
        print("❌ " + str(d["error"]))
        return 1

    if d.get("done"):
        # Also print which account's window it happened in — essential when there are several accounts.
        acct = d.get("account")
        prefix = "[%s] " % acct if acct else ""
        print("· " + prefix + ", ".join(d["done"]))

    # eval result
    # 🔴 Print it whole. `eval` returns the one value you asked for by name, which is a
    #    different thing from the page summary below — there we cut lists short because
    #    the point is a glance, here the value *is* the answer.
    #    This used to stop at 1200 characters with nothing to say it had, so a query that
    #    returned more looked like it had returned exactly that much. The data was never
    #    missing: the engine sends the whole result and only this line dropped it.
    if "result" in d:
        v = d["result"]
        print("  result:", v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
    if d.get("evalError"):
        print("  ❌ execution error:", d["evalError"])

    ICON = {"error": "🔴", "warning": "🟡", "warn": "🟡", "info": "🔵", "log": "  ", "debug": "  "}

    con = d.get("console")
    if con is not None:
        print("  console (%d)" % len(con))
        for m in con:
            where = ""
            if m.get("url"):
                where = "  ← %s:%s" % (m["url"].rsplit("/", 1)[-1][:28], m.get("line", ""))
            print("   %s %s%s" % (ICON.get(m.get("type"), "  "),
                                  (m.get("text") or "").replace("\n", " ")[:110], where))
        if not con:
            print("   (none)")

    errs = d.get("errors")
    if errs is not None:
        print("  uncaught exceptions (%d)" % len(errs))
        for e in errs:
            print("   🔴 %s" % (e.get("message") or "")[:110])
            for ln in (e.get("stack") or "").split("\n")[1:3]:
                if ln.strip():
                    print("      %s" % ln.strip()[:100])
        if not errs:
            print("   (none)")

    net = d.get("network")
    if net is not None:
        print("  failed requests (%d)" % len(net))
        for r in net:
            tag = r.get("status") or r.get("failure") or "?"
            print("   🔴 %-22s %s" % (str(tag)[:22], (r.get("url") or "")[:80]))
        if not net:
            print("   (none)")

    p = d.get("page")
    if not p:
        return 0

    print("  title:", p.get("title"))
    print("  url  :", (p.get("url") or "")[:100])
    if p.get("h1"):
        print("  h1  :", p["h1"])

    links = p.get("links") or []
    if links:
        print("  links(%d):" % len(links))
        for a in links[:8]:
            print("    - %s  →  %s" % (a.get("text", ""), (a.get("href") or "")[:60]))

    buttons = p.get("buttons") or []
    if buttons:
        print("  buttons(%d): %s" % (len(buttons), ", ".join(buttons[:8])))

    inputs = p.get("inputs") or []
    if inputs:
        print("  inputs(%d):" % len(inputs))
        for x in inputs[:8]:
            hint = x.get("placeholder") or x.get("type") or ""
            # 🔴 Show what the field currently holds. The engine reports it; printing only
            #    the selector meant the one question you ask after typing — "did it land?"
            #    — could not be answered from this output, so people evaluated against the
            #    element themselves and picked the wrong one. Measured 2026-08-25.
            val = x.get("value")
            n = x.get("length")
            if val:
                print("    - %s  (%s)  = %r" % (sel_of(x), hint, val))
            elif n == 0:
                print("    - %s  (%s)  = (empty)" % (sel_of(x), hint))
            else:
                print("    - %s  (%s)" % (sel_of(x), hint))

    # 🔴 The body text. The engine has always sent this and nothing printed it, so a
    #    page whose whole point was its prose read as if it had none — worse than a
    #    cut, because a cut at least shows you the first half.
    #    We keep `read` a glance: the first few lines, with the character count beside
    #    them so you can see there is more. `wb eval 'document.body.innerText'`
    #    returns the rest.
    text = (p.get("text") or "").strip()
    if text:
        head = text[:400]
        print("  text(%d chars):" % len(text))
        for line in head.splitlines()[:6]:
            print("    %s" % line)
        if len(text) > len(head) or len(head.splitlines()) > 6:
            print("    … (wb eval 'document.body.innerText' for all of it)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
