# Design options — remote control / cloud handoff (Aside's "Channels" / "Cloud handoff")

Status: **options for the master to decide** (touches infra, auth, and possibly cost — a
stop-and-ask point). Not started in code. 2026-09-05.

## What Aside offers, and what it would mean for us

Aside's Pro tier lists **Channels (remote control)** and **Cloud handoff**: start or steer an
agent run from your phone / another device, and let a long task continue when you step away.
For us this is the one remaining headline feature we do not have — and unlike the others it is
**not a local, reversible code unit**. It needs a reachable endpoint, authentication, and a
decision about where the browser actually runs. That is why this is a design doc, not a commit.

## The hard constraint that shapes every option

🔴 Wbrowser's whole premise is that it drives **the Chrome you are already signed into, on
127.0.0.1**. The engine binds to loopback on purpose — anyone who can reach the port can drive
your logged-in sessions. "Remote control" means letting *something outside this machine* reach
that. Every option below is really a different answer to: **how do we let you reach your own
machine safely, without opening your logged-in Chrome to the network?**

## Options (rough cost / risk, for the master to pick)

### A. Tailnet-only remote (lowest new surface) — recommended starting point
Reach the engine over the user's existing Tailscale tailnet (which the harness already uses),
not the public internet. The engine still binds loopback; a thin authenticated shim forwards
from the tailnet address to it. No new public endpoint, no hosting cost.
- **Cost:** ~none (uses infra the user already runs). **Risk:** low — traffic stays on the tailnet.
- **Limit:** only reaches machines on your tailnet; not "from any phone browser" out of the box.

### B. Relay through the existing portal (medium)
The harness already has a portal with webhooks and auth. A `wb` remote command could enqueue an
instruction the local engine polls for and executes, with results posted back. Reuses auth and
the portal we operate.
- **Cost:** portal load (a real concern — a past broadcast pushed it to load 34). **Risk:** medium
  — the portal becomes a control path for a logged-in browser; auth and rate-limits must be tight.

### C. Hosted cloud browser (highest — matches Aside's "cloud handoff" literally)
Run the browser in the cloud so a task continues with the machine off. This is a different
product: it needs a server that holds a logged-in session, i.e. **the user's cookies leave
their machine** — the opposite of our core promise.
- **Cost:** real hosting + ongoing. **Risk:** 🔴 high — it breaks "your logins never leave your
  Chrome". Would need its own, loudly-stated security model. Probably **not** us.

## Recommendation

Start with **A (tailnet-only)** if we do this at all: it extends reach without a public endpoint,
without hosting cost, and without moving any login off the machine — consistent with the edge
we just wrote up (`docs/PROPOSAL-our-edge.md`: no migration). B is a fallback if reach beyond the
tailnet is required. C is a different product and conflicts with our core promise.

## What the master needs to decide before any code

1. **Do we build remote control at all**, or is "runs on your machine, you're at your machine"
   an acceptable (even principled) limitation we state instead of close?
2. **If yes, which option** — and for A/B, is the added attack surface on a logged-in browser
   acceptable, with what auth?
3. Anything involving a hosted session (C) or ongoing cost is a **money / secret-movement**
   decision — explicitly the master's, not mine.
