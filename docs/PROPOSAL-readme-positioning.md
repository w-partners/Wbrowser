# Proposal — reconcile the README promise with `wb login`

Status: **proposal for the master / whitegun** (positioning call, not mine to make). 2026-09-05.

## The conflict

`wb login --save` stores a password (encrypted, AI-invisible, opt-in). Three README lines
promise the opposite in absolute terms:

| Line | Current text |
|---|---|
| ~29 | *"Your password never leaves you. You log in by hand; Chrome keeps it…"* |
| ~116 | *"Wbrowser never sees your passwords. You type them; Chrome stores them…"* |
| ~175 | *"**Ask for or store your password.** You sign in; Chrome keeps it…"* (under "What it won't do") |

If we ship `wb login` without touching these, a clone user reads "never stores your password"
and then finds a `--save` that stores it. That reads as a broken promise — the worst outcome
for a public tool people paid attention to.

## The fix: promise what is actually invariant

The invariant that survives `wb login` is **the AI never sees the secret** — not "nothing is
ever stored". That is also the sharper claim (it is what Aside leads with) and it is true in
both modes:

- **Default (hand login):** you type into Chrome; Wbrowser drives the already-open window.
- **`wb login` (opt-in):** *you* type the password into the vault; the engine types it into
  the field over CDP; the AI never receives it, and it never appears in logs or the audit trail.

### The three lines differ in strength (whitegun's review, 2026-09-05) — do not treat them alike

- **~29 — head-on conflict.** *"Your password never leaves you. You log in by hand…"* — "log in
  by hand" is the opposite of `wb login`, and "never leaves you" is wrong once it is in the
  vault. Rewrite.
- **~116 — the headline SURVIVES; only the tail is wrong.** *"Wbrowser never sees your
  passwords."* is true even with `--save` (the engine sees it, the AI does not). Keep that
  sentence; fix only the tail *"You type them; Chrome stores them"* which names Chrome as the
  only store. Do **not** replace the whole line — it is already the reconstructed promise.
- **~175 — head-on and the most dangerous.** It sits in the "what it won't do" list, which
  reads like a contract. *"Ask for or store your password"* directly contradicts `--save`.
  Rewrite to an AI-exposure promise.

### Proposed rewrites (for the master to accept or edit)

- ~29 → *"The AI never sees your password. Log in by hand and Chrome keeps it, or store it once
  in a local encrypted vault (`wb login`) that the engine — never the AI — reads."*
- ~116 → keep the headline *"Wbrowser never sees your passwords."*; change the tail to
  *"You type them — into Chrome, or once into a local encrypted vault the engine reads. Either
  way the AI never receives them."*
- ~175 (under "won't do") → replace *"Ask for or store your password"* with
  *"Expose your password to the AI. You sign in by hand, or store it in a local vault only the
  engine can read — the model never receives it either way."* And, if desired, add a positive
  line elsewhere describing `wb login` as opt-in.

## Make the change visible, not silent (whitegun's point, 2026-09-05)

Someone who cloned earlier read "never stores your password" and trusted it. Rewriting the
promise silently would be a *retroactive* change to that trust. So whichever wording is chosen,
say **when and how it changed**, in two places:

- **CHANGELOG:** the release that adds `wb login` states plainly that credential storage is a
  new, opt-in capability, that it did not exist before, and that the default (hand login,
  nothing stored) is unchanged.
- **README:** next to the reworded promise, one line — *"`wb login` (opt-in credential storage)
  was added in v0.14.0; before that Wbrowser stored nothing. The default still stores nothing —
  you opt in per site."* — so a returning reader sees the boundary, not a moved goalpost.

The invariant we never broke — *the AI never sees the secret* — is exactly what makes this an
honest evolution rather than a walked-back promise, as long as we date it.

## Why this is a positioning call, not a code call

The words are the product's headline trust claim. Changing them changes what we tell the world,
so whitegun (marketing) and the master should own the exact wording. The code is ready and
tested; it waits on this decision before release. My recommendation is above; the choice is
yours.

## What I did NOT do

- I did not edit README.md. The proposal is here so the change is deliberate, not a side effect.
- `wb login` is committed but unreleased and unpushed until this is settled.
