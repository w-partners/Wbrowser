# Proposal — what Wbrowser has that Aside cannot

Status: **proposal for the master / whitegun** (positioning). 2026-09-05. Not a code change.

We now match Aside's headline features (credential autologin without exposing the password,
a benchmark, local memory, a human-approval gate). Matching is table stakes. This is the one
axis where we are not catching up — we are structurally different, and it is worth naming.

## The edge: it's the browser you were already using

Aside is a **separate browser you install and switch to**. Comet, Dia — the same shape: a new
app with its own window, its own logins to establish. Wbrowser is **not a browser at all**. It
lends an agent the Chrome you are already signed into, over CDP. Nothing is installed as "your
new browser"; nothing is re-logged-in; the agent works in the exact window you had open.

Two things fall out of that, and only that:

1. **A person and an agent share one window, live.** You keep working in one tab while the agent
   works in another — same Chrome, same session, no handoff. On a separate-browser product this
   picture cannot exist: the agent is somewhere else, in an app you switched away from.
2. **Nothing to migrate, nothing to trust with your logins.** You do not move your accounts into
   a new browser and hope it keeps them safe. They never leave the Chrome they were always in.

## Say it as a thesis, not a feature list

The sharp version — for the master to accept, sharpen, or reject:

> **The AI browsers you've heard of — Aside, Comet, Dia — ask you to switch browsers. This one
> doesn't. It drives the one you're already in.**

🔴 Note the wording change: an earlier draft said *"Every other AI browser"*. That is a
universal claim that one counter-example sinks — we verified three, not all of them (whitegun's
point, 2026-09-05). Name the ones we checked, or say "the ones you've heard of"; do not claim
"every".

The proof is our own picture, shown — a human cursor and an agent working in the same window at
once. 🔵 Do NOT lean on "the competitor's screenshot can't show this": an absence is a weak
proof ("they just didn't screenshot it"). Our recorded demo *showing* the shared window is the
strong form — and it is the demo we have not recorded yet (it needs a clean profile so no real
login is on screen, which needs the master's go-ahead).

## The honest constraint (do not drop it)

This edge is real but it is **not** "we're safer" or "we're smarter". A separate browser is a
legitimate choice — it can sandbox harder, ship its own password manager, control its own
update cadence. Our claim is narrower and truer: **we don't make you switch, and your logins
never move.** Overreaching into "more secure" would be the same promise-vs-reality gap we just
spent a release reconciling. The edge is *no migration, shared window* — full stop.

## Where this is decided

- The **wording** is whitegun's and the master's (it is the product's public stance).
- The **demo** that proves it (shared window, clean profile) needs the master's go-ahead to
  record, because it involves launching Chrome and a fresh profile.
- The code already supports it; nothing here asks for a code change.
