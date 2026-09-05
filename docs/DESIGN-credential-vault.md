# Design — credential vault + no-expose autologin

Status: **draft** (v0.14.0 target). Author: wbrowser-primary. 2026-09-05.

## Why

Wbrowser lends an agent a logged-in Chrome. But when a session is *not* yet logged in, the
agent hits a login wall and stops — the single biggest reason a browser agent fails to finish
a task. The competitor (Aside) closes this with credential autofill where **the AI never sees
the password**. This design does the same, on our CDP-based architecture.

## Non-negotiable security properties

1. **The AI (the model driving wb) never sees a secret value.** Not in a command argument, not
   in a tool result, not in a log line, not in an error message. The value exists only inside
   the *engine process* memory, briefly, and inside the encrypted vault at rest.
2. **At rest, encrypted.** The vault file is AES-256-GCM; the key is derived (scrypt) from a
   master passphrase the user enters. `session.json` (plaintext cookies) is NOT reused for
   secrets — it is the wrong tool.
3. **Injected over CDP, not through the model.** The engine decrypts, then types the value into
   the login field with `Input.insertText` — the same lane `rawcdp` already uses for keys. The
   value never crosses the wb CLI ↔ model boundary.
4. **Every use is logged** (which site, which field, when — never the value). A tamper-evident
   append-only audit line.
5. **The user sets and approves.** Storing a credential and the first use on a new site both
   require the user to confirm — the human-approval-at-the-edge property. The model cannot
   silently enroll or use a credential.

## What is reused vs new

| Reuse | New |
|---|---|
| `rawcdp` CDP `Input.dispatchKeyEvent` (field typing) | `lib/vault.js` — encrypt/decrypt (Node `crypto`, scrypt + AES-256-GCM) |
| engine's CDP page driving | `wb login <site>` / `wb creds …` CLI |
| rawcdp selector resolver (find the field) | login-form field detection (user/pass/submit) |
| — | append-only audit log |

## Data model

Vault file (default `~/.wbrowser/creds.enc`, overridable):
```
{ "v": 1, "salt": <b64>, "iv": <b64>, "tag": <b64>, "ciphertext": <b64> }
```
Decrypted payload:
```
{ "sites": { "<origin>": { "username": "...", "secretRef": "...", "field_hints": {...} } } }
```
🔴 The decrypted payload is held in the engine only for the duration of one injection, then
zeroed. It is never written back in the clear and never returned by any endpoint.

## Flow — enrolling a credential (`wb login example.com --save`)

1. wb prompts the **user** (not the model) for username + password on the controlling terminal,
   reading the password with echo off. 🔴 The model never receives these keystrokes.
2. wb hands them to the engine over the loopback socket in a single request that is **never
   logged**; the engine encrypts into the vault. The request/response carry no secret back.
3. Audit line appended: `enrolled <origin> user=<username-masked> at <ts>`.

## Flow — autologin (`wb login example.com`)

1. Engine loads the vault (asks the user for the master passphrase once per engine lifetime, or
   uses an OS-provided unlock — TBD), decrypts the entry for `<origin>` into memory.
2. Engine navigates the agent's tab to the login page, finds the username/password fields
   (field detection), and types each with `Input.insertText`.
3. Submit is **gated**: the engine fills, but the final submit either waits for the user's
   confirmation or is allowed per a per-site policy the user set at enroll time.
4. Audit line: `autologin <origin> field=password at <ts>` (no value).
5. Memory holding the decrypted value is cleared.

## Decisions (confirmed by the user 2026-09-05)

- **Master passphrase unlock cadence: once per engine start.** The user enters the passphrase
  once on the controlling terminal at the first credential use after `wb up`; the engine holds
  the derived key in memory for the engine's lifetime. Restarting the engine re-locks.
- **Submit gating: confirm on the first login per site, then remember the choice.** The engine
  fills the fields always; the final submit waits for the user's confirmation the first time a
  site is used, then follows the remembered per-site policy.
- **Field detection failure: refuse and say so.** If we cannot confidently identify the
  password field, we do NOT type the secret anywhere — same "refuse, don't guess" rule as the
  tab-isolation work. A wrong-field secret leak is the worst outcome and is designed out.

## Test plan

- `lib/vault.js` unit tests: round-trip encrypt/decrypt; wrong passphrase fails; tampered
  ciphertext/tag fails (GCM auth); the plaintext never appears in the file bytes.
- Injection: a stub CDP records that `Input.insertText` received the value and that **no wb
  command argument or tool result ever carried it** (the boundary test — mirrors the
  agent-isolation tests).
- Audit: a use appends exactly one line, with the value masked.

## Explicitly NOT in this design

- No cloud sync of the vault. Local only (matches Aside's "local by default").
- The model is never given a "read credential" path, even for debugging.
