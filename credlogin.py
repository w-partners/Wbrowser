#!/usr/bin/env python3
"""wb login — enroll or use a stored credential, without the model ever seeing the secret.

🔴 Security boundary: this script reads the USER's keystrokes (getpass, no echo) and posts
   them to the local engine. The values are never printed, never placed in argv, never written
   to shell history, and never returned to the agent that ran `wb`. The engine encrypts them
   into the local vault and types them into the login form over CDP.

Env in: WBROWSER_ENGINE (base url), WB_ORIGIN (site), WB_SAVE (1=enroll), WB_AGENT (identity).
"""
import getpass
import json
import os
import sys
import urllib.request

ENGINE = os.environ.get("WBROWSER_ENGINE", "http://127.0.0.1:7981")
ORIGIN = os.environ.get("WB_ORIGIN", "").strip()
SAVE = os.environ.get("WB_SAVE", "0") == "1"
CONFIRM = os.environ.get("WB_CONFIRM", "0") == "1"
AGENT = os.environ.get("WB_AGENT", "").strip()

if not ORIGIN:
    print("wb login: no site given", file=sys.stderr)
    sys.exit(1)


def post(path, body):
    """POST json to the engine. Returns (status, parsed-json-or-None)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        ENGINE + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, None
    except Exception as e:
        print(f"wb login: cannot reach the engine at {ENGINE} ({e})", file=sys.stderr)
        sys.exit(1)


def unlock():
    """Ask for the master passphrase once and unlock the engine's vault for this session."""
    # 🔴 The passphrase is read from the user here and sent straight to the engine. It is not
    #    stored by this script and not shown.
    passphrase = getpass.getpass("Vault master passphrase: ")
    st, resp = post("/cred/unlock", {"passphrase": passphrase})
    if st != 200:
        print(f"wb login: {(resp or {}).get('error', 'could not unlock the vault')}", file=sys.stderr)
        sys.exit(1)


def enroll():
    """Read username + password from the user and store them. The model sees neither."""
    print(f"Enrolling a credential for {ORIGIN}.")
    print("  (These go straight to the local engine and into the encrypted vault.")
    print("   They are never shown, never logged, and the AI never receives them.)")
    username = input("  Username: ").strip()
    password = getpass.getpass("  Password: ")
    if not password:
        print("wb login: empty password — nothing stored", file=sys.stderr)
        sys.exit(1)
    st, resp = post("/cred/enroll", {"origin": ORIGIN, "username": username, "password": password})
    # Drop the local references promptly.
    del password
    if st == 200:
        print(f"✅ Stored a credential for {ORIGIN}. Use it with: wb login {ORIGIN}")
    else:
        print(f"wb login: {(resp or {}).get('error', 'enroll failed')}", file=sys.stderr)
        sys.exit(1)


def autologin():
    """Fill the login form for ORIGIN using the stored credential."""
    st, resp = post("/cred/login", {"origin": ORIGIN, "agent": AGENT, "confirmSubmit": CONFIRM})
    resp = resp or {}
    if st == 200:
        if resp.get("submitted"):
            print(f"✅ Filled and submitted the login for {ORIGIN}.")
        elif resp.get("needsConfirm"):
            print(f"✅ Filled the login for {ORIGIN}. Submit is gated on your confirmation the "
                  f"first time — run:  wb login {ORIGIN} --confirm")
        else:
            print(f"✅ Filled the login for {ORIGIN}. Press Enter in the page or click Sign in.")
    elif st == 404:
        print(f"wb login: no credential stored for {ORIGIN}. Enroll it: wb login {ORIGIN} --save",
              file=sys.stderr)
        sys.exit(1)
    elif st == 422:
        # Field detection refused — the engine would not guess where to type the secret.
        print(f"wb login: {resp.get('error', 'could not find the login fields')}", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"wb login: {resp.get('error', 'login failed')}", file=sys.stderr)
        sys.exit(1)


def main():
    unlock()
    if SAVE:
        enroll()
    else:
        autologin()


if __name__ == "__main__":
    main()
