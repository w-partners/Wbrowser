#!/usr/bin/env python3
"""The named-browser registry: one place that maps a name to its fixed number.

A person refers to a browser by name (`work`) or by number (`1`), and to a tab by
`[browser-tab]` — `[1-2]` is the second tab of browser 1. For that to be usable the
number must not move: `work` is 1 today and 1 tomorrow, whatever order things start
in. So the mapping is written down here, assigned once, never reused.

The default browser — the Chrome you were already logged into — is always browser 1,
and is not stored here. Named browsers are 2, 3, 4… .

Usage (called by `wb`, not by people):
  browsers.py resolve <name-or-number>   -> prints:  num<TAB>name<TAB>cdp_port<TAB>engine_port   (exit 1 if unknown)
  browsers.py add <name>                 -> assigns the next number, prints the same line
  browsers.py list                       -> num<TAB>name per line
"""
import json
import os
import sys

# The default browser is 1 and lives on the historical ports.
DEFAULT_CDP = 9222
DEFAULT_ENGINE = 7981

# Named browsers get ports from their number, so a number is all you need to reach one.
# Number N (>=2) -> CDP 9300+N, engine 7800+N. Room for ~90 browsers, no overlap with
# the default and no dependence on a hash (a hash could collide; a counter cannot).
def ports_for(num):
    if num == 1:
        return DEFAULT_CDP, DEFAULT_ENGINE
    return 9300 + num, 7800 + num


def registry_path():
    root = os.environ.get("WBROWSER_STATE_DIR") or os.path.join(
        os.path.expanduser("~"), ".local", "state", "wbrowser")
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, "browsers.json")


def load():
    try:
        with open(registry_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"browsers": []}          # [{num, name}], num starts at 2


def save(data):
    with open(registry_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def emit(num, name):
    cdp, eng = ports_for(num)
    print("%d\t%s\t%d\t%d" % (num, name, cdp, eng))


def resolve(token):
    # Number or name -> the browser. "1" and "default" are the browser you started with.
    if token in ("1", "default", ""):
        print("1\tdefault\t%d\t%d" % (DEFAULT_CDP, DEFAULT_ENGINE))
        return 0
    data = load()
    for b in data["browsers"]:
        if token == b["name"] or token == str(b["num"]):
            emit(b["num"], b["name"])
            return 0
    sys.stderr.write(
        "No browser named %r. Make it with `wb new %s`, or see `wb browsers`.\n"
        % (token, token if not token.isdigit() else "<name>"))
    return 1


def add(name):
    if not name or name.isdigit() or name in ("default",):
        sys.stderr.write("A browser name must be a word, not a number or 'default'.\n")
        return 2
    data = load()
    for b in data["browsers"]:
        if b["name"] == name:          # idempotent: making it twice is not an error
            emit(b["num"], b["name"])
            return 0
    num = max([1] + [b["num"] for b in data["browsers"]]) + 1
    data["browsers"].append({"num": num, "name": name})
    save(data)
    emit(num, name)
    return 0


def profile_dir(name):
    """Where `wb -b <name> up` puts that browser's profile (same rule as wb)."""
    root = os.environ.get("WBROWSER_PROFILE_ROOT") or os.path.join(
        os.path.expanduser("~"), ".wbrowser"
    )
    return os.path.join(root, name)


def account_of(name):
    """Which account a browser's profile belongs to, read from Chrome's own record.

    Reads `Local State` -> profile.info_cache, the same record Chrome keeps and
    `whoami.describe` reads. This resolves the path itself instead of calling
    describe(), because describe() first maps a Windows path into WSL and gives up
    when handed a plain Linux path — which is exactly what these profiles are.

    Returns None when it cannot be determined — a browser that has never been
    started has no profile yet. 🔴 None means "not known", which is not the same
    as "signed out"; the caller must not render the two the same way.
    """
    root = profile_dir(name)
    for base, prof in ((root, "Default"), (os.path.dirname(root), os.path.basename(root))):
        state = os.path.join(base, "Local State")
        if not os.path.exists(state):
            continue
        try:
            with open(state, encoding="utf-8", errors="replace") as handle:
                cache = json.load(handle).get("profile", {}).get("info_cache", {})
        except Exception:
            continue
        entry = cache.get(prof)
        if entry is None and len(cache) == 1:
            entry = list(cache.values())[0]
        if entry is None:
            continue
        return entry.get("user_name") or entry.get("name") or None
    return None


def list_all(with_accounts=False):
    rows = [(1, "default")] + [
        (b["num"], b["name"]) for b in sorted(load()["browsers"], key=lambda x: x["num"])
    ]
    for num, name in rows:
        if not with_accounts:
            print("%d\t%s" % (num, name))
            continue
        # Browser 1 is the Chrome the user was already in; its profile lives
        # wherever that Chrome put it, not under the wbrowser root.
        account = account_of(name) if num != 1 else None
        print("%d\t%s\t%s" % (num, name, account or ""))
    return 0


def main(argv):
    if not argv:
        sys.stderr.write("usage: browsers.py {resolve|add|list} [name]\n")
        return 2
    op = argv[0]
    if op == "resolve":
        return resolve(argv[1] if len(argv) > 1 else "")
    if op == "add":
        return add(argv[1] if len(argv) > 1 else "")
    if op == "list":
        return list_all(with_accounts="--accounts" in argv[1:])
    sys.stderr.write("unknown op %r\n" % op)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
