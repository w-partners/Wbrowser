# Changelog

Notable changes per release. Dates are the release date; the repository history
has the detail.

---

## 0.15.4 — 2026-09-05

### A command with a tab name that was never opened now errors, instead of reading a blank tab

Reported 2026-09-05 (idifference): `goto` (no tab name → 'main') followed by an `eval {tab:"login"}`
hit two different tabs — tabs are keyed by `(agent, tab)` — and the `eval` quietly read
`about:blank` while `goto` had reported success. The navigation worked; the second command was
just looking at a different, empty tab, and nothing said so.

Now a command that does **not** navigate (`eval`/`read`/`click`/`press`/`type` with no `goto`)
refuses to conjure a blank tab: if no page exists for that `(agent, tab)` yet, it returns a 404
naming the tab and the fix — *"no page for tab 'login' … use the same tab name on your 'go', or
send 'go' first"* — rather than opening a blank one and acting on it. `goto`/`newtab` still open
their tab as before. Use the same tab name on the `go` and on later commands, or bundle them in
one call.

🔵 Known separate issue (not this fix): the e2e check "the tab is labelled with the agent" is
flaky on some runs — it predates this change (verified) and is being looked at on its own; it is
a stamp-title timing question, not the routing fixed here.

---

## 0.15.3 — 2026-09-05

### Docs: closing Chrome ends OTHER agents' tabs too, not just yours

Follow-up to 0.15.2. The WSL close-Chrome note said `wb` doesn't kill Chrome because "it may be
a window you're using" — but the real risk is wider: `Browser.close` ends the **whole** Chrome,
so it cuts off tabs **other agents** are using, not only your own. The SKILL now says to check
`wb tabs` first and hold off if a tab belongs to someone else — a stuck URL of yours is not
worth cutting another agent's work. Reported by a peer who correctly held off for exactly this.
Docs only.

---

## 0.15.2 — 2026-09-05

### Docs: how to close Chrome on WSL when a restart is needed

`wb` never kills Chrome (it may be a window you're using), so when a utility-world buildup
finally needs a Chrome restart, you close it yourself — and on WSL `powershell.exe` / `taskkill`
may not be on the path if interop isn't configured (reported by a peer). The SKILL now gives the
portable way: send `Browser.close` over the CDP browser websocket, which works wherever the
debugging port does. Docs only.

---

## 0.15.1 — 2026-09-05

### One place decides what counts as a sensitive action

The unattended-run gate (which refuses pay / send / delete / submit steps unless a job opts in)
was a regex living in `cron.js`; a separate idea of "sensitive" would have drifted from it over
time. It is now a shared classifier, `sensitiveaction.js`, that `cron.js` delegates to — so the
definition lives in **one** place, and the refusal now also names the *kind* it refused (pay,
send, delete, confirm). A regression test locks in that the classifier still catches every term
the old gate did, in all four languages, so consolidating did not quietly weaken the gate.

No behaviour change for you: unattended jobs still refuse those steps unless they opt in; they
just say which kind, and the rule is now defined once.

---

## 0.15.0 — 2026-09-05

### `wb remember` / `wb recall` — a local memory of which site is for which task

So you don't have to be told the site every time. Record the site you use for a kind of task,
recall it later.

```bash
wb remember email mail.example.com   # "for the 'email' task I use mail.example.com"
wb recall email                      # → mail.example.com (used 3×)
```

- 🔵 **Local only.** It lives in `~/.wbrowser/memory.json` (0600) and is **never sent to any
  model**. It stores only a task tag, the origin, a count and a timestamp — no query-string
  URLs, no page contents, no cookies. Not a browsing-history dump.
- 🔴 `wb recall` on an unknown tag returns **nothing** — it never hands back a wrong site.
- Recall ranks the site you use most for that tag first; the store is capped (LRU) so it cannot
  grow without bound.

### README: the vault's mechanism is named, not just "encrypted"

The password promise now says *what* the vault is — AES-256-GCM with a scrypt-derived key,
owner-only (0600), local — in all four languages. "What it is" is verifiable; "encrypted" alone
is not.

---

## 0.14.0 — 2026-09-05

### `wb login` — sign in without exposing the password to the AI (opt-in)

New, **opt-in** capability. When a site is not already signed in you normally stop — you cannot
type the user's password and should not. `wb login` closes that: the user stores a credential
once, and the engine fills the login form. **The AI never sees the password.** The user enters
it; it is encrypted into a local vault (scrypt + AES-256-GCM, `~/.wbrowser/creds.enc`, 0600);
the engine decrypts per-use and types it into the field over CDP — the value never crosses into
the agent's context, the logs, or the audit trail.

```bash
wb login example.com --save     # the USER types username + password (echo off) → encrypted vault
wb login example.com            # the engine unlocks the vault and fills the login form
wb login example.com --confirm  # …and submits (first time per site; then remembered)
```

- The engine **refuses** rather than guess: no visible password field, or two (a change-password
  form), and it types nothing. A secret in the wrong field is designed out.
- Submit is gated (first login per site needs `--confirm`, then remembered). Every use is
  audited — site, action, when, username masked — **never the value**. The vault unlocks once
  per engine start; `wb down; wb up` re-locks.

🔴 **The password promise is reworded, not walked back.** Earlier releases said Wbrowser would
"never store your password". `wb login` stores it — encrypted, AI-invisible, and only if you opt
in per site. The invariant that never changed, and is now the promise, is **the AI never sees
the secret** — true whether you log in by hand or use the vault. The default is unchanged: store
nothing unless you run `wb login --save`. Before 0.14.0 there was no credential storage at all.

### `wb bench` — a reproducible capability benchmark

`wb bench` launches a throwaway headless Chrome on its own profile and ports (never the browser
you use), serves a fixed local task set, and prints `score: N/M`. Rerun it and you get the same
number — a floor of capability you can verify, not a claim against live-web benchmarks that
cannot be reproduced.

---

## 0.13.11 — 2026-09-05

### The fallback's refusal no longer loops you into an impossible retry

0.13.8's isolation refusal ("no tab stamped for '<agent>'…") ended with *"or open this agent's
tab first with a `go`."* But on the raw-CDP fallback, `go` routes through the **same** check and
is refused identically — so the guidance looped, and following it just reprinted the message. A
peer burned time trying it before realizing the second option was impossible from that state.

The fallback genuinely cannot open a new tab (that needs playwright, which is exactly what is
down on the fallback), so the message now says the one thing that works — restart the engine,
and if it comes back on the fallback, a utility-world buildup is holding playwright down and
only a Chrome restart clears it (with the master's OK). No option that cannot be done from here.

---

## 0.13.10 — 2026-09-05

### `connect` can no longer hang forever — a stuck attach becomes a named error

`connectOverCDP`'s own `timeout` option only covers opening the websocket. After it connects,
playwright replays one `executionContextCreated` per stale utility world before it returns —
and **that** phase is not bounded by the option. With enough worlds it never returns. Because
the engine calls `connect()` from inside `/health`, `/health` then never answers either: the
port is held, the process is alive, and every probe times out with **no cause given**. (Reported
2026-09-05, idifference: `wb up` hung for over three minutes after a reconnect; the log's last
line was the reconnect attempt, then silence. A hang that says nothing is worse than a failure
that does.)

`connectOverCDP` is now wrapped in a wall-clock race that fires even when the built-in timeout
does not (`WBROWSER_CONNECT_TIMEOUT`, default 30000 — the same "hung, not slow" line the docs
tell you to use). When it trips, the attach becomes a named error naming the real cause (utility-
world buildup, cleared only by a Chrome restart) instead of an unbounded silence. The one-shot
reconnect is bounded by the same race, so the reconnect recursion can no longer hang forever —
which was the exact shape of this report.

---

## 0.13.9 — 2026-09-05

### A hung tab is dropped and you're told to retry — not left stuck behind a Chrome restart

Follow-up to 0.13.8. A long-reused tab can end up with a **hung renderer**: `/json/list` and
the browser-level CDP domains answer instantly, but `Page.enable` / `Runtime.evaluate` on that
one tab time out — even `about:blank` does. An engine restart does not help, because the engine
keeps holding that same dead tab; a Chrome restart does not help either if the fallback keeps
re-selecting it. (Diagnosed with a peer across two machines: same Chrome build, same WSL2 — one
machine's tab was hung, the other's identical setup was fine, so it is the tab, not the tool.)

On the raw-CDP fallback, when **this agent's own** stamped tabs all fail the liveness probe, the
fallback now **closes them** over `GET /json/close/<id>` — which the browser process serves even
when the renderer is hung — and fails with a message telling you to run the command again (the
retry opens a fresh tab). Only tabs stamped for this agent are ever closed; a stranger's tab is
never touched (the 0.13.8 isolation still holds). No Chrome restart, no master approval needed.

Reported and verified by a peer.

---

## 0.13.8 — 2026-09-05

### The raw-CDP fallback no longer attaches to another agent's tab

The deeper cause behind the wrong-tab reports. When the engine's playwright connection goes
half-dead (which happens under load), commands fall to a raw-CDP fallback lane. That lane's
tab picker had been widened — while fixing a *different* bug (skipping half-dead tabs) — to
consider **every** open page. So when this agent's own tab was slow to answer the liveness
probe, the loop fell through to a *different* agent's tab and ran `eval` / `shot` / `click`
there. In the field this saved another agent's logged-in page to the caller's disk and ran
JavaScript in a session that was never the caller's — a boundary leak, not just a wrong
screenshot, and it happened **even with `--agent` set correctly** because the leak was one
layer below the CLI.

- With an agent name, the fallback's candidate tabs are now **exactly that agent's stamped
  tabs** — never widened to other agents'. If none of them are live, it **fails, named**
  (`no tab stamped for '<agent>' … refusing to attach to another agent's tab`) instead of
  borrowing the nearest live one. Only an unnamed caller (no identity to protect) may fall
  back to any page. The half-dead-tab skip from 0.13.x is kept — within the agent's own tabs.
- `wb tabs`, `wb take`, `wb release` now report **why** an engine is unreachable — "no answer
  within Ns … alive but too slow" — instead of a flat "Engine is not running". A slow engine
  was being called dead, sending people to `wb up` when the engine was already up. `wb status`
  already did this; now every engine-gated command does.

Both diagnosed from source (rawcdp.js:44, wb's engine gate) after a peer's field reports.

---

## 0.13.7 — 2026-09-05

### `--agent` is now a real flag; unknown flags fail instead of being swallowed

`wb shot` was reported saving a *different* agent's tab — a logged-in page the caller
never navigated to — to the caller's disk. The root cause: `wb go URL --agent <name>`
passed a flag `wb` did not parse, so it fell through as a positional and did nothing.
The session kept its auto-derived identity, and `go` and `shot` then resolved to
different agents' tabs. A flag that looks like it works but is silently ignored is
exactly the failure this tool guards against.

- **`--agent <name>`** is now a real flag on every command — it forces which agent the
  invocation (and its tab) runs as, overriding the working-directory / process-tree
  derivation. Use it when the auto-derivation lands on the wrong name.
- **Unknown flags now fail, named.** On a fixed-shape command (`go`, `read`, `shot`,
  `click`, `press`, `errors`) any leftover `--flag` is rejected with a message instead of
  being dropped. Free-text commands (`type`, `eval`, `console`, `network`) still allow a
  literal `--` in their content — there it is text, not a flag.

`wb shot` already captured *the running agent's* tab (never "whatever is on top"); this
release makes sure you actually run as the agent you meant to.

---

## 0.13.6 — 2026-09-05

### `wb status`'s Chrome check honours a timeout override, like the engine check

`_cdp_up` (the CDP liveness probe behind `wb status`) had a hardcoded 2s timeout, even
though the comment right beside it says a timeout "cannot be a constant — slow is not
dead". That lesson had reached `_engine_up` (8s, `WB_HEALTH_TIMEOUT`) but not `_cdp_up`.
On a loaded machine a healthy Chrome answering `/json/version` just over 2s was read as
"❌ Chrome"; the layer-diagnosis then treats that as layer 1 (Chrome absent) and sends
you to restart Chrome — which closes other agents' and the master's tabs. `_cdp_up` now
takes `WB_CDP_TIMEOUT` (default 5, smaller than `/health` because raw CDP is lighter).
Pointed out by a peer reading the source.

Fix only; no behaviour change beyond the timeout.

---

## 0.13.4 — 2026-09-04

### "Can't attach" now tells you to restart the engine first, not Chrome

When playwright cannot reach the page, the engine used to prescribe "restart Chrome" — the
heavy move that closes open windows (which may be the master's or another agent's). Reported
2026-09-04 (idifference): the stale state was in the *engine's* playwright connection, not
Chrome; restarting Chrome left the symptom, while `wb down && wb up` cleared it. And when
Chrome and the engine are both alive with just a stale link, `wb up` is a no-op that changes
nothing — someone followed the old prescription, launched a fresh Chrome, and the symptom
stayed.

The connect-timeout and read-timeout messages (and the SKILL troubleshooting) now say:
**restart the engine first** (`wb down && wb up` — light, touches nobody else's tabs), and
restart Chrome only if that fails and only with the master's OK.

Docs/message only; no behaviour change.

## 0.13.3 — 2026-09-04

### `--tab` works in any position; `goto` stops reporting a blank page as success

Two silent failures reported 2026-09-04 (idifference):

- **`--tab` after the command was dropped.** `wb read --tab tk` silently discarded both
  tokens and read the *default* tab — usually an about:blank the agent never meant to be on
  — costing 20 minutes diagnosing a "dead site" that was really a blank tab. `--tab` was
  only parsed inside `go`; it is now parsed in `wb` at any position, for every command, and
  reaches the named tab. `wb --tab tk read` and `wb read --tab tk` are now the same.
- **`goto` reported success while the tab stayed on about:blank.** playwright can resolve a
  navigation (no error, no timeout) and yet never leave the page — seen with
  http / IP-literal / non-standard-port targets. `goto` now checks where it actually landed
  and throws (502) if it is about:blank or a different origin, instead of a silent success.
  It also surfaces a 4xx/5xx HTTP status (`httpStatus`) so a "200 pretending to be a 404" is
  visible without opening the console — without throwing, since visiting an error page on
  purpose is legitimate.

Fixes only; no API change.

## 0.13.2 — 2026-09-04

### Fallback click understands playwright selectors; two more unhandled-rejection paths closed

Verifying v0.13.1 against a real half-dead playwright (zalman): `①②③⑤` worked, `④ click`
did not, and the engine still crashed intermittently.

- **`click` in the fallback threw a bare "Uncaught".** A `button:has-text("…")` / `text=…`
  selector is playwright syntax that raw CDP's `querySelector` cannot parse, so it raised a
  SyntaxError before any click logic ran. The fallback now resolves `text=` and
  `:has-text()` by text search, and an unsupported selector fails with a clear "not
  supported in the raw-CDP fallback — restart Chrome" message rather than a bare Uncaught.
- **Two more places where a rejection could escape every `catch` and kill the engine.**
  Reported: the engine died on the request *after* the one that opened a raw-CDP socket,
  leaving only a `[reconnect]` line (it died outside all handlers). Now: `close()` and a
  persistent socket-`error` listener fail pending sends instead of throwing loose, and the
  reconnect's `browser.close()` swallows a late background rejection under a bounded wait.

🔵 This closes the two *known* unhandled paths; the crash is intermittent and if a third
path exists, an engine-stderr stack trace (zalman is capturing) will pin it. "Fixed the
paths we can see," not "the crash is gone."

Fix only; no API change.

## 0.13.1 — 2026-09-04

### The raw-CDP fallback now picks a live tab, and a fallback failure can't crash the engine

Two bugs surfaced verifying v0.13.0 against a real half-dead playwright (zalman):

- **The fallback kept attaching to a dead tab.** It took the first stamped page — but the
  tabs playwright had killed are exactly the ones carrying our stamp, so every command
  timed out while other tabs answered raw CDP in 3–9ms. `attach()` now probes each
  candidate with a short `Runtime.evaluate` and takes the first that replies, skipping the
  dead ones.
- **A fallback failure could take the whole engine down.** A few requests in, the caller
  got an empty body (not even a 500) and the port went dead — a half-closed websocket's
  late `error` becoming an unhandled rejection. Two guards now: `close()` rejects any
  pending sends and swallows the late error, and the engine has top-level
  `unhandledRejection`/`uncaughtException` handlers so one bad request fails that request,
  not the process.

Fix only; no API change. (Verification of the fallback carrying a real session through is
still on the environment that reproduces the half-dead state.)

## 0.13.0 — 2026-09-04

### A raw-CDP fallback keeps you working when playwright's connection is down

When playwright's `connectOverCDP` goes half-dead and its one reconnect cannot recover it
(v0.12.3–v0.12.5 detect this but only a Chrome restart fixes it), the engine no longer
leaves you stuck — it drives the page over a **fresh raw-CDP websocket** instead, which
stays fully responsive when playwright's does not (measured 2026-09-04: `Page.navigate`,
`Runtime.evaluate`, `Page.captureScreenshot`, `Input.dispatchMouseEvent` all worked while
playwright timed out for hours). So `goto`, `eval`, `shot`, `press` and a basic `read`
keep working, and a session does not have to stop for a Chrome restart.

🔴 This is the **emergency lane, not a replacement for playwright.** It has no
selector→coordinate resolution or actionability waiting, so `click` is best-effort
(resolve the element's box, dispatch a real mouse click) and **fails loudly** if the box
is zero-size or the selector matches nothing — it never clicks blindly. `newtab`/`newwindow`
need playwright and still error. Responses on this lane carry `via: "rawcdp"` and a note to
restart Chrome to restore full features.

Verified locally (the raw-CDP module drives a live Chrome end to end); the "does it carry
you through a real half-dead playwright" check is on the environment that reproduces that.

## 0.12.5 — 2026-09-04

### The reconnect now converges to exactly one, from both directions

v0.12.4 cut the reconnect storm from 68 to ~6, but not to 1. Two races remained, and both
are now closed:

- **Concurrent requests each started their own reconnect.** The failure flag was set only
  *after* the attempt, so back-to-back requests passed the gate before any of them failed
  (measured: 6 reconnects in 0.96s, some 2ms apart). A `reconnecting` flag set at the
  *start* of the attempt now turns those into a transient "retry shortly" (503) instead.
- **The reconnect attempt's own failure did not set the flag.** When the retry timed out
  too, it fell into the "reconnect in flight" branch and returned 503 instead of recording
  the failure — so every later request reconnected again (reproduced locally: `[reconnect]`
  every ~12s). The retry now falls through to set the flag and throw the restart message.

Reproduced end-to-end locally (a half-dead connection appeared after repeated engine
restarts) and confirmed `[reconnect]` converges to 1.

Still a loop/race fix, not a recovery: on the reported environment the connection only
comes back with a Chrome restart. The raw-CDP fallback that actually recovers it is in
progress.

Fix only; no API change.

## 0.12.4 — 2026-09-04

### The one-shot reconnect is now actually one-shot

v0.12.3 added a single reconnect to tell a half-dead socket apart from utility-world
buildup — but the guard was a function argument, which resets on every fresh `connect()`
call. So "once" became once-per-request: measured 2026-09-04, `[reconnect]` fired **68
times** in one sitting, each attempt failing and adding a world. The guard is now an
engine-lifetime flag — after the reconnect fails, later requests skip it and go straight to
the restart-Chrome message; a successful `connect()` clears it.

Note: this fixes the *loop*, not the underlying recovery. On the reported environment the
reconnect does not recover the connection (Chrome holds state that only a Chrome restart
clears — verified: raw CDP stays fully responsive throughout). A thin raw-CDP fallback for
that case is being designed separately.

Fix only; no API change.

## 0.12.3 — 2026-09-04

### A half-dead browser connection now recovers itself, instead of demanding a restart

Reported 2026-09-04: over a network boundary (Windows Chrome ↔ WSL2 over Tailscale) the
websocket playwright holds to Chrome went silently one-way — `connectOverCDP` timed out for
hours while raw CDP answered instantly. The engine read that timeout as utility-world
buildup and said "restart Chrome, do not retry" — but for a half-dead socket a *fresh*
connection recovers it, so people were restarting Chrome when a reconnect would have done.

`connect()` now tells the two apart: on a `connectOverCDP` timeout where Chrome still
answers raw CDP, it drops the stale browser handle and reconnects **once**. If that
succeeds it was a half-dead socket (recovered, with a `[reconnect]` line in the log); if it
times out again it really is utility-world buildup, and only then does it tell you to
restart Chrome. The one retry costs one extra world — the price of telling the two apart.

- **`act` errors (500s) are now logged.** A stalled tab returned 500 to the caller but
  wrote nothing, so there was no trail to follow. Anything ≥500 (timeouts especially) now
  leaves a `[act-error]` line; 400s (caller typos) stay quiet.

Fixes only; no API change.

## 0.12.2 — 2026-09-04

### Tabs no longer pile up — agent tabs are reaped, and `newtab` stops orphaning a blank

Two bugs made a session climb to 30-40 open tabs in a short sitting:

- **`newtab` opened two tabs, not one.** `getTab` ran first and created a page for the
  unknown tab name, then the `newtab` block created another and overwrote it — leaving the
  first as a mark-less `about:blank` nobody would ever close. `getTab` is now skipped when
  `newtab`/`newwindow` is set, so exactly one tab is opened.
- **Nothing ever closed old agent tabs.** The engine now reaps them before opening a new
  one: an agent tab that has gone to `about:blank` is closed, and if more than 8 agent tabs
  are still alive the oldest are closed down to that cap.

🔴 **Only tabs an agent opened are ever closed** — they carry a stamp (`__wbrowserMark`).
A tab you opened by hand, or a login tab, has no stamp and is never counted or closed.

Also: `click` no longer fails the whole action when `scrollIntoViewIfNeeded` can't scroll
to the element (a fixed/off-screen target) — it scrolls best-effort and lets the click try.

Fixes only; no API change.

## 0.12.1 — 2026-09-04

### `read` no longer blames the page for a timeout it did not observe

A `read` that timed out always said *"the page kept changing while it was being read (an
endless feed does this)"* — but that is one of two causes, and the message asserted it as
fact. Reported 2026-09-04: `read` timed out on a small, static page (measured 1ms of real
DOM work), and the wording sent the reporter hunting for an infinite re-render in their own
code that was not there.

The real cause was the other one: playwright could not reach the page's execution context
because *utility worlds* from earlier connections had piled up (Chrome holds one per frame
per connection until it restarts). Now, when `read` times out, the engine checks whether
raw CDP still answers instantly — and if it does, it says Chrome is fine and the connection
is stalled, name the utility-world buildup, and tell you to restart Chrome (not retry).
When it cannot tell, it says the page *may* still be changing **or** the read did not
return — no longer asserting a cause it did not see. Detection adds no new connection, so
it does not make the buildup worse.

Fix only; no API change.

## 0.12.0 — 2026-09-04

### One agent, two tabs — now splittable into side-by-side windows (`--window`)

You could already drive several named tabs from one connection. Now `wb go <url>
--window` opens the page in its own OS window instead of a tab in the current one — same
Chrome, same CDP connection, so **control is unchanged**; only the layout differs, so one
agent can watch two pages at once.

```bash
wb go https://A --tab left  --window
wb go https://B --tab right --window   # two windows, still one agent driving both
```

`newtab` opens a tab in the current window (`newPage()`); the new `newwindow` splits it
into its own window via CDP `Target.createTarget({newWindow:true})`, which is the only
way to do it — Playwright's `newPage()` cannot. It is not a second browser: for a
genuinely separate Chrome (its own profile and logins) use a numbered browser (`-b`).

Verified end-to-end against a live browser: `newwindow` took the window count from 1 to
2 and commands still reached the new window's tab (labelled `[3-29] …`).

## 0.11.3 — 2026-09-04

### Field notes for driving CDP by hand (SKILL)

From an agent comparing two sites side by side over raw CDP — measured, not guessed:

- **Navigate with `Page.navigate`, not `location.href` inside `Runtime.evaluate`** —
  the latter often left the next CDP call hanging (the navigation tears down the
  execution context the evaluate is waiting on). Moving two tabs at once may be a
  second face of the same lost-reply.
- **`innerText` is not enough to call two screens equal** — a screenshot caught empty
  grey cards, missing icons, a 263px blank gap, and audio that was raw PCM the browser
  could not open. Text and geometry are supporting evidence, not the verdict.
- **A file existing is not the file working** — verify it actually *loads*
  (`loadedmetadata` for audio/video, `img.decode()` / `new Image().onload` for images);
  a timeout is a failure, not a pass.
- **Before blaming your fix, check the server isn't serving the old file** — log the
  received byte-count next to the on-disk one.
- **Overlap detection is a hint, not a verdict** — pages stack elements on purpose;
  exclude parent/child nesting and let the caller judge.

Docs-only; no engine or CLI behaviour changed.

## 0.11.2 — 2026-09-02

### Tabs no longer label themselves "agent@you" when the session runs wb from elsewhere

The tab label takes the session name from its `AGENT/<name>` directory, walking up the
process tree to find it. But a session that runs `wb` from some other working folder —
a project subdir, /tmp — can be far enough from that directory that the walk misses,
and the label falls back to `agent@<user>`, the same for every session. Several tabs
driven by different sessions all read the same thing, and you could not tell which
session opened which.

There is now a last resort before that fallback, for orchestration setups only: if the
session carries an opaque instance id and a roster endpoint is configured, `wb` asks
the roster for the human-readable name. Measured 2026-09-02: sessions whose cwd had
moved out of their AGENT dir resolved correctly again.

🔵 A plain clone has neither the id nor a roster, so it skips this entirely and keeps
the `agent@<user>` fallback — no dependency on any private service enters normal use.
The roster URL is read from the environment or the harness file, never hardcoded (a
test checks no routable IP is baked in).

## 0.11.1 — 2026-09-02

### The landing page always shows the version, not only when behind

0.11.0 added an update banner, but it appeared *only* when the install was out of
date — so on a current machine the page said nothing about the version at all, and
someone asking "what am I running? is there anything newer? where are the notes?"
got no answer. It also stayed silent when GitHub could not be reached, which reads
the same as "you are current" when it is not.

The page now shows, every time, a line under the title:

    version v0.11.1 · up to date · what changed
    version v0.9.6  · v0.11.1 available · what changed   (plus the update command)
    version v0.9.6  · could not check for updates (rate-limited, try later)

- the running version, always;
- the result of the check spelled out — up to date, an update available, or could
  not check (never silence that looks like "fine");
- **what changed**, linking to the latest release's notes.

Opened from the repo without installing, it says `unknown` and checks nothing — no
false "update available".

## 0.11.0 — 2026-09-01

### The landing page tells you when an update is waiting

A person opening a browser sees the landing page — it is the one screen that comes up
every time. Until now nothing there said the install was behind, so a machine could run
an old copy for weeks while fixes piled up in releases. (`wb version` reports it, but
only if you think to ask.)

The page now checks the latest release and, if the running version is older, shows a
notice with the exact command to update:

```
🔵 An update is available. You have v0.9.6, latest is v0.11.0.
   cd <your Wbrowser folder> && git pull && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

🔵 It shows nothing when you are current, and nothing when GitHub can't be reached or
is rate-limited — a missing notice is better than a wrong one. `launch.js` stamps the
running version into the page on open; if that ever fails to happen the check disables
itself rather than guess.

## 0.10.2 — 2026-09-01

### Tab labels stopped saying "agent@you" for every session

Seven tabs in one window all read `[1-3] agent@you`, so the label told you nothing
about which session opened which tab. The name is derived from the session's
`AGENT/<name>` directory, but it was only read from the immediate parent process — and
an agent often runs `wb` from a working folder that is not that directory. When the
parent happened to be elsewhere, it fell back to `agent@<user>`, the same for everyone.

It now walks up the process tree (up to eight hops) to the nearest ancestor whose
working directory is the session's, so the real name — `wbrowser-primary`,
`seoul-primary` — lands on the tab. A fresh clone with no such directory anywhere on
the tree still falls back, which is correct there.

🔵 The parent's `PPid` is read from `/proc/<pid>/status`, not field 4 of `/stat`: a
process whose name contains a space or a `)` shifts every field of `/stat`, and the
walk would climb the wrong tree.

## 0.10.1 — 2026-09-01

### Tab coordinates are permanent — `[1-3]` stays the same tab

The tab number in `[1-3]` was the tab's position in the list, so closing tab 2 slid
everything after it down a number: "look at [1-3]" pointed at a different tab a minute
later. The number is now a per-tab id, assigned once, never reused. Close tab 2 and the
others keep their numbers; the next tab opened is 4, not a recycled 3. The id is stored
in the page itself, so an engine restart does not renumber it.

### `wb close` was matching nothing, and always said "0"

Two bugs, both from the label change in 0.10.0:

- `close` looked for a title starting with `[agent]`, but the label is now
  `[1-3] agent …` — so it matched no tabs and closed none. It matches the agent after
  the coordinate now.
- The "Closed N tabs" line always printed `0`, because the counter was never
  incremented. This is the tool for the runaway-tab problem — an agent that keeps
  opening tabs can now actually clear its own.

### `{"newtab": true}` was rejected as unknown

The engine handled `newtab` but it was missing from the accepted-keys list added in
0.9.1, so `{"newtab": true}` came back `400`. Three others handled the same way
(`fullPage`, `limit`, `filter`) were missing too. All added.

## 0.10.0 — 2026-09-01

### Several logged-in browsers at once, referred to by number

You can run more than one Chrome — a second, third, each with its own window, profile
and logins, fully separate from the one you started with. Register a browser by name
and it gets a permanent number; drive it by either.

```
wb new work          # 'work' is now browser 2, and stays browser 2
wb -b work up        # its window opens — you sign into it once, by hand
wb -b work go https://mail.google.com
wb -b 2 read         # name or number
wb browsers          # the list
```

Tab titles read `[browser-tab]`: **`[1-2]` is the second tab of browser 1**, `[2-1]`
the first tab of browser 2. That is the whole point — a coordinate you can say out loud
to pick one tab among several browsers.

🔵 No `-b` is browser 1, the Chrome you were already logged into, on the unchanged
ports. Nothing about the single-browser workflow moves.

🔴 The number is assigned once and never reused, because a coordinate is only useful if
it holds still — `browsers.py` is the single registry, so `work` is 2 from every caller
and every session. Ports come from the number, so **nobody types a port**: `wb -b work`
and `wb -b 2` resolve to the same place the same way every time.

🔴 Each named browser starts empty. The person signs in; agents never touch passwords —
the same rule as everywhere else in this tool.

## 0.9.10 — 2026-08-31

### A busy machine was being reported as a dead engine

`wb up` said `❌ Engine won't come up` while the engine was running perfectly well.
`wb status` agreed with it. On a box at load 26, `/health` answered `200` in 11.2
seconds — and the check gave it 2 seconds, twenty-five times, then concluded it was not
there.

**Slow is not dead.** A fixed timeout is a guess about how loaded the machine is, and
that is not something the code can know.

```
before   ❌ Engine won't come up.  Log: …
after    ❌ Engine (http://127.0.0.1:7981)
            no answer within 8s — :7981 is held by pid 1948659 — node engine.js
            If a process is listed, it is alive but too slow to reply: try WB_HEALTH_TIMEOUT=30
```

The limit is 8 seconds now and `WB_HEALTH_TIMEOUT` overrides it. More importantly the
failure says which failure it is: nothing listening, or something listening that cannot
answer in time. Those want opposite responses — read the log, or wait.

🔵 **Who holds the port**, too. `ss -lptn` leaves the process column empty when the
socket is not yours to inspect, so "something is on this port" was the whole story;
finding the pid meant matching an inode from `/proc/net/tcp` against every `/proc/*/fd`
by hand. `wb` does that itself now.

🔴 Third report today of one shape, and the reporter named it: **the tool knows why it
failed and does not say.** An empty response called "is the engine up?", a screenshot
timeout that swallowed the page, and now a slow reply called "not running."

## 0.9.9 — 2026-08-31

### One part failing no longer takes the whole reply with it

Two reports from real use, both the same shape.

**A screenshot timeout deleted the page summary.** On a heavy feed,
`{read:true, shot:true}` came back as `{"error":"page.screenshot: Timeout"}` and
nothing else. The summary had already been gathered — it was thrown away with the
exception. Someone collecting from three sites got zero characters from all three, and
the reply blamed the screenshot, which was not what they had asked for.

**`read` on an endless feed never returned.** `x.com/home` did not answer at 45s, or at
180s. `goto` has a 30-second guard; the summary that runs after it had none, so a page
whose DOM keeps growing while you walk it could be walked forever. The guard on one
step was undone by the next.

```
before   {read, shot} on a heavy page → {"error": "page.screenshot: Timeout"}
after    → page: {...}
           🔴 screenshot: timed out after 20s (the rest of the command still ran)
```

Both now have their own limit, and both report what failed while keeping what worked.
`read` says so plainly when it gives up: *the page kept changing while it was being
read (an endless feed does this)*.

🔵 This partly contradicts the rule added in 0.9.1 — *take `read` and `shot` together
before anything irreversible*. Following it on a heavy feed was losing the evidence it
was meant to preserve. The rule stands; it works now because a failed screenshot no
longer costs you the page.

## 0.9.8 — 2026-08-31

### A mistyped command printed the help and exited 0

`wb reed` showed the help text and reported success. Nothing said the command did not
exist, so it read as "it ran and did nothing" — and a script wrapping `wb` could not
tell the difference, because the exit code was 0.

```
before   wb reed → (help text)                      exit 0
after    wb reed → ❌ No such command: reed         exit 1
                   (help text)
```

🔵 Third instance of one shape today, after `{"action":"read"}` returning 200 and a
clone with no dependencies reporting `✅ Engine`: **a mistake that reports success
sends you looking at the browser, the network, the page — anywhere except what you
typed.** `help` still exits 0; it is not a mistake.

## 0.9.7 — 2026-08-31

### A missing argument answered with a Python traceback

Type a command bare to see what it wants — the most ordinary thing a new user does —
and four of them replied with a stack trace:

```
$ wb go
Traceback (most recent call last):
  ...
IndexError: list index out of range
```

`go`, `click`, `type` and `press`. They now say what they need:

```
Usage: wb go <url>
Usage: wb click <selector>
Usage: wb type <selector> [text]   [--fast]   (no text clears the field)
Usage: wb press <key>              e.g. Enter, Tab, Control+A
```

🔵 The first version of this fix required two arguments for `type` and broke clearing a
field, which `wb type <selector>` with no text has always done. The existing test
caught it. That is what those tests are for, and it is why the fix is one argument.

## 0.9.6 — 2026-08-31

### The reply now says *whose* tab it read

Tabs are keyed by `(agent, tab)`, so two callers both using the default `main` are on
two different pages. The reply said `tab: "main"` to both of them.

Someone compared a bare `curl {"read":true}` against `./wb read`, got two different
pages back, and spent an afternoon looking for a bug in the client parser. There was
no bug: `wb` attaches an agent name and a hand-written curl does not, so the two calls
were reading different tabs — and neither answer said so.

```
before   {"tab":"main", "account":"Default", …}      ← both callers, different pages
after    {"tab":"main", "agent":"e2e", …}
         · [Default · agent e2e] goto https://example.com
```

🔵 Same shape as the version field in 0.9.2: the tool reported *that* it did something
without reporting *what it did it to*. Two answers that cannot be told apart are worse
than one that is missing, because you compare them.

## 0.9.5 — 2026-08-31

### Two more entry points were running on a clone with nothing installed

0.9.4 guarded `wb`, `engine.js` and `mcp-server.js`. It missed `cron.js` and
`launch.js`, and it missed them for the reason that makes this class of bug so
persistent: **neither file imports playwright**, so nothing failed when it loaded.

```
node cron.js list   → printed the schedule, as though those jobs were live
node launch.js      → ALREADY_UP, after attaching to somebody else's Chrome
```

Both were doing what the last release fixed everywhere else: answering as though the
installation had happened.

🔴 The reason they were missed is that the first fix was a **list** of the places that
needed guarding. Lists are written from memory, and memory does not include the file
someone adds next month. There is now a test that walks every `*.js` in the repo and
fails if a runnable one has no guard — so the next entry point is covered by the test
rather than by someone remembering.

## 0.9.4 — 2026-08-31

### `wb` reported success on a clone that had installed nothing — since 0.1.0

Clone the repository, skip `npm install`, and run `./wb status`. It printed
`✅ Chrome · ✅ Engine` and looked completely ready. `./wb go <url>` then opened a
page and reported it worked.

Nothing was installed. Every command here talks to an engine over HTTP, so what
answered was **whoever else had an engine on that port** — another user, another
project, another checkout. Commands ran against their browser, and the output looked
exactly like success.

```
before   fresh clone → ./wb status → ✅ Chrome · ✅ Engine   (nothing installed)
after    fresh clone → ./wb status → ❌ Dependencies are not installed in this directory.
                                        cd <dir> && npm install
```

**Present since 0.1.0 (2026-08-23).** Only `wb up` ever checked, so anyone who started
with `status` or `go` never saw the message.

🔵 **`setup.sh` users are unaffected** — the one-line installer in the README runs
`npm install` itself and stops with an explanation if it fails. This hit people who
cloned the repo and installed by hand.

🔴 The check now runs **once, before the command is dispatched**, not per command. The
first attempt gated each verb by name and left `shot` and `tabs` open — a fresh clone
could still screenshot a stranger's screen. Gating by enumeration means the next verb
added is unguarded by default.

🔴 And there is now **one** answer to "can this run here?" (`preflight.js`). It had
been three: a directory check in `wb`, `require.resolve` in `engine.js`, another in
`mcp-server.js`. Three tests for one fact can disagree, and when they do the one that
passes is whichever you happened to run — which is this bug's own shape, one level up.
A test asserts the check has not leaked back into those files.

## 0.9.3 — 2026-08-31

### The version field now has a test that it reports the *running* code

0.9.2 added `build` so a stale process could not pass for a fresh one. Nothing
guaranteed it stayed that way. Read the version file on each request instead of once
at startup and the field starts lying at exactly the moment it exists to prevent a
lie — an old process picks up the new number the second someone edits the file.

The check edits `package.json` underneath a live engine and asserts the answer does
not move.

🔵 Writing it turned up something we did not know about our own code. The obvious
mutation — `require('./package.json').version` at call time — **does not break it**,
because Node caches `require` and hands back the copy read at startup. The field was
protected by a language detail nobody had chosen. Only bypassing the cache
(`readFileSync` on every call) breaks it, and that is what the check now proves it
catches.

🔴 So a check written against the plausible mutation would have passed on both the
good and the bad build. **The mutation has to be the one that actually breaks the
property, not the one that looks like it should.**

🔵 Found because a neighbouring project hit this for real: their version was read per
call, and editing the file made a process started hours earlier report the new
number. They asked, we tested ours, and ours held — but only by accident, and with
nothing keeping it that way.

## 0.9.2 — 2026-08-31

### "Fixed but still broken" is now one question, not a hunt

0.9.1 shipped, someone pulled it, and the bug was still there. The fix was in the
checkout the whole time — an engine started *before* the pull still held the port, so
old code answered every request. Working that out took reading process start times
out of `ss` and `ps` by hand and comparing them to a commit timestamp.

Nothing the tool printed said which build was answering. `wb status` said `✅ Engine`,
which was true and useless.

```
✅ Engine (http://127.0.0.1:7981)  0.9.2 (a1b2c3d)  up since 2026-08-31 09:11:04 UTC
```

`/health` carries `build` and `startedAt` too. If the version does not match what you
just pulled, or the start time predates it, you are talking to an old process — and
that now takes one glance instead of two commands and a subtraction.

🔵 The general shape, and worth stating plainly: **a tool that reports "running"
without saying *what* is running lets a stale process impersonate a fix.** Every check
we had passed while the wrong code served every request.

## 0.9.1 — 2026-08-31

### A key the engine does not know is now a 400, not a shrug

`{"action":"read"}` used to return `200` with `done: []`. Nothing ran, nothing said
so, and the page never changed. Someone hit this from another machine and tried three
times before working out that verbs are keys — `{"read":true}`, not
`{"action":"read"}`.

```
before   {"action":"read"}  →  200 {"done":[]}
after    {"action":"read"}  →  400 unknown key: "action". Verbs go in as keys…
```

The error names the key, shows the correct shape, and lists what is accepted. A typo
that returns success is worse than one that returns an error: it sends you looking at
the browser, the network, the page — anywhere but the request.

🔵 Errors now carry their own status. Everything used to come back as `500`, which
made a typo look like an outage.

### The HTTP schema is in the skill docs

Both copies described the `wb` CLI and never mentioned `POST /act`, so anyone calling
the engine directly was guessing. Now the payload for each verb is written down,
including `{"read":true,"shot":true}` in one call.

🔴 And a rule that had only ever been implied: **before anything you cannot undo, take
`read` and `shot` together and keep both.** Every silent failure in this file was
caught by the DOM disagreeing with the pixels or the other way round — text truncated
to 55 of 92 characters and reported as success, rows two through ten of a form left
empty. A selector failure looks identical in the DOM whether it was a login wall, a
modal, or a bot check. One call, not two: two round trips can straddle a change.

🔵 Reported by another agent on this machine, with the reproduction attached. Two of
the three items were real; the third — that `read` and `shot` could not be combined —
already worked, and was a gap in the docs rather than the code. That is the same
defect as the other two, one layer up.

## 0.9.0 — 2026-08-31

### `goto` was rejecting pages that worked

On a timeout, `goto` asked the page whether it was still `loading` and gave up if it
was. That is the wrong question. `readyState` describes whether bytes are still
arriving — not whether you can use what already got here.

Measured on a response that streams its body and never closes: the document reads
`loading` indefinitely, and a button appended to it is still created, still clicked,
and still fires its handler. The page was completely operable and we threw it away,
losing the rest of the command with it.

```
before   if (sameOrigin && landed.ready !== 'loading')
after    if (sameOrigin && landed.usable)      // body exists and has children
```

🔵 The opposite case still throws, and has to: when a route returns nothing at all,
`page.evaluate` never resolves, the 3-second race leaves `landed` null, and there is
genuinely nothing to carry on with.

### Mutation coverage: 5/7 → **7/7**

Both survivors from 0.8.4 are dead.

**`goto:timeout-recovery`.** Its check asserted `'goto' in done`, which a page that
never needed recovering also satisfies — the check read as reasonable and proved
nothing. The branch writes its own sentence (`still loading after 30s`), so that is
what we assert now.

Getting the fixture right took five attempts, each ruled out by measurement rather
than by guessing:

```
hanging image / stylesheet / iframe   DOMContentLoaded fires in 30ms — goto never times out
a route that returns nothing          evaluate itself blocks — rethrowing is correct
body streamed, response left open     times out, evaluate works, DOM operable ← this one
```

**`type:keystroke-delay`.** No assertion on `.value` can see this: set the delay to
zero and the field still ends up correct. The check watches `keydown` timing instead.
The threshold is not "greater than zero" — with the delay at 0 the gaps still measure
around 14ms, because every keystroke is its own CDP round trip. The real 25ms delay
lands near 30ms, so the line sits at 22ms, between two measured values rather than
beside a plausible-looking one.

🔵 e2e is now 22 checks, and this time the number means something: every scored
branch has a check that fails when the branch is disabled.

## 0.8.4 — 2026-08-31

### The `text(…)` header now says whether you are seeing all of it

`links(50)` never has to answer that question — a list is always a sample, so
nobody wonders. Body text is different: sometimes the whole page fits, sometimes it
doesn't, and 0.8.3 printed `text(N chars):` either way. The ellipsis below was the
only tell. That is a smaller version of the defect 0.8.3 existed to fix, in the
line we added to fix it.

```
text(29 of 349 chars):   ← shortened
text(9 chars, all):      ← whole
```

### The mutation score for 0.8.2's `goto` checks — measured, and it is bad news

That entry sat for a day saying the score was unverified because playwright could
no longer attach to the e2e browser. It was verifiable the whole time: `Browser.close`
over CDP shuts a browser down without going anywhere near a process name, and the
run completed on a fresh one.

```
caught 5 / 7 scored   (+1 equivalent, excluded)
survivors — goto:timeout-recovery · type:keystroke-delay
```

🔴 **`goto:timeout-recovery` survived** — the exact branch those two checks were
written for. Turning the recovery off entirely leaves the suite green: both checks
assert on the outcome (command finished, page usable), and a page that never needed
recovering gives the same outcome. So "18 → 20 checks" bought two checks and zero
covered branches. See the 0.8.2 entry, now corrected.

🔵 **Both survivors were killed in 0.9.0**, and chasing the `goto` one turned up a
real defect in the engine rather than a missing test. See that entry.

## 0.8.3 — 2026-08-31

### `read` never printed the page's text

The engine has always sent up to 3000 characters of body text. Nothing printed it.
So `read` on an article — the one kind of page whose entire content *is* its prose —
came back with a title, a URL, and a list of links, as though the page had no words
in it at all.

This is the same defect as 0.8.2's and one notch worse. A cut at least shows you the
first half; this showed you nothing and gave no sign there was anything to show.

```
read   title/url/links only → the same, plus:

  text(4820 chars):
    Whatever the page actually says, first few lines
    …
    … (wb eval 'document.body.innerText' for all of it)
```

🔵 It stays a glance. `read` exists to be skimmed, so the body is capped like the
link and button lists are — **and, like them, prints its real size beside it**. That
number is the whole point: you can see there is more, and the line below tells you
how to get it. A short page prints whole with no ellipsis.

🔵 We found this by taking someone else's summary of the last release. Ours was "we
removed the 1200-character cap", and inside that frame a field that prints *nothing*
is invisible. Theirs was **"if you shorten it, say how much there was"** — and one
pass over `fmt.py` with that sentence turned this up. Same defect, different seat.

## 0.8.2 — 2026-08-31

### `eval` printed 1200 characters and let you believe that was all of it

Ask the page for something long — the text of an article, a table you serialised,
a list of every link — and you got the first 1200 characters. No ellipsis, no
total, nothing. The value looked complete because there was no sign it wasn't.

The data was never missing. The engine sends the whole result and always has; the
cut was one line in `fmt.py`, the last place before the screen. Everything the
user thought they were looking at was in the response they never saw.

```
eval result   1200 chars → whole value
```

🔵 The summary printed by `read` still shortens its lists on purpose, and that is
the right call — it exists to be glanced at, so it caps links and buttons at eight
and prints the real count beside them (`links(50)`). `eval` is the other thing
entirely: you named the value you wanted, so the value *is* the answer. Those two
had been treated the same.

🔴 **The shape of this bug, not the size.** A tool that drops data loudly gets
fixed; one that drops it silently sends you looking somewhere else. We wrote that
down after `wb status` swallowed a `/health` diagnosis, and it was sitting in
`eval` the whole time.

`fmt.py` had no tests. It has five now, and they were checked the only way that
means anything: putting the old `[:1200]` back turned three of them red.

### `goto` now has a test for the case it exists to handle

A goto timeout does not mean the page failed — heavy SPAs keep requests in flight
long past the point where the document is usable, and rejecting there throws away
the rest of the command. That recovery path had no coverage.

The fixture is the real shape: the HTML completes, then an image request hangs
forever. `document.readyState` reaches interactive while the network never goes
idle. **A page stuck at `loading` is correctly *not* recovered** — that one really
is unusable, and the first fixture we wrote made exactly that mistake (it hung a
`<script>`, which blocks parsing, so the recovery never fired and we briefly
suspected the engine instead of the test).

```
e2e   18 → 20 checks
```

🔴 **A check that navigates owes the next check a known page.** Adding these left
the browser on the slow fixture and three `press` checks went red — not because
`press` broke, but because the field they type into was no longer on screen. The
goto block now returns the tab before moving on.

🔴 **Re-scored, and the checks do not catch it.** For a day this entry said the
score was unverified because `connectOverCDP` could no longer attach to the e2e
browser. It could be verified: `Browser.close` over CDP shuts that browser down
without going near a process name, and the mutation run then completed on a fresh
one. The result:

```
caught 5 / 7 scored   (+1 equivalent, excluded)
survivors — goto:timeout-recovery · type:keystroke-delay
```

**`goto:timeout-recovery` survived** — the same branch the two checks above were
written for. Disabling the recovery entirely leaves the suite green, because both
checks assert on the *outcome* (the command finished, the page is usable) and a
page that never needed recovering produces that outcome too. The fixture hangs an
image, so `domcontentloaded` resolves on its own and the recovery path is never the
reason the checks pass.

🔵 So the honest reading of "18 → 20 checks" is: two more checks, zero more
branches covered. That is worth writing down more than the number was.

🔵 **Fixed in 0.9.0.** The check now asserts the sentence the branch itself writes,
and the fixture that finally exercised it took five measured attempts.

---

## 0.8.1 — 2026-08-30

### `click` had no test at all

One of eleven command branches in `act()`, completely uncovered, while the suite
reported 15 green. Three checks now cover it: that a click reaches a target
**below the fold**, that it **actually fires the handler**, and that it reports
the element it hit rather than the selector it was handed.

```
e2e   15 → 18 checks
```

### 🔴 And the mutant that led us there is *equivalent*

`click:scroll-first` survived all three new checks — correctly. Removing the
`scrollIntoViewIfNeeded` line changes no observable behaviour: playwright's own
`click()` scrolls too, inside its own timeout budget. The separate step exists so
a long page does not eat the click's budget, which shows up as a **timing**
difference on a page slow enough to matter — not as a pass or a fail.

The code comment said so already. We wrote three checks before reading it.

```
before   caught 5 / 8
after    caught 5 / 7 scored   (+1 equivalent, excluded)
```

🔵 **Equivalent mutants are excluded from the denominator, not hidden.** Leaving
one in understates the suite; dropping it silently overstates it. `mutate.sh`
prints both numbers so a reader can do either arithmetic, and labels which
survivor is equivalent — the difference between *"we have work to do"* and
*"we do not know."*

🔴 A mutation score is never 100%. That is a property of the technique, not a gap.

`mutate.sh` now also warns before you chase a survivor: **apply the mutant by hand
first and check that anything observable changes at all.**

### Still uncovered, still named

```
goto:timeout-recovery   needs a deliberately slow page
type:keystroke-delay    typing speed has no observable effect
```

---

## 0.8.0 — 2026-08-29

### We measured our own tests, and the number was worse than we said

0.6.0 and 0.7.0 both claimed the suites were verified "by breaking the code on
purpose." That was true and it was not enough. **Both mutations we picked were
functions we had just written a check for** — of course they went red. That
proves the wiring, not the coverage: the switch is connected to the bulb, but it
says nothing about how many bulbs are in the room.

`scripts/mutate.sh` picks mutants from the **code** instead — one per command
branch in `act()`, including the branches nothing tests.

```
first run   caught 2 / 8      ← the two we had bragged about
now         caught 5 / 8      ← after adding four checks
```

The three survivors are named in the output and left there on purpose:

```
goto:timeout-recovery   needs a deliberately slow page
click:scroll-first      needs an element below the fold
type:keystroke-delay    typing speed has no observable effect
```

🔵 **A survivor is an uncovered branch, not a bug.** Printing them is the point —
a suite that only reports what it caught reads as if it caught everything.

### Four new end-to-end checks (11 → 15)

Each closes a mutant that used to survive:

- **`Control+a` then `Backspace` empties the field.** The old check only read the
  log line, so reverting the chord-normalisation fix from 0.5.0 — the one that
  made `Control+a` work at all — left it green. **Watching what a command reports
  tells you the report is right.**
- **Typing replaces instead of appending.** Without the clear step you get
  `hello worldsecond` and the command still says it succeeded.
- **`read` hides what the user cannot see.** A hidden input is injected and must
  not appear in the list.

### 🔴 The harness itself produced a false survivor

`read:visible-filter` stayed green after its check was added. The mutant was
replacing only the *first* of three `.filter(vis)` calls; the other two kept
working. **The check was fine — the mutant was weak.** `mutate.sh` now warns about
count=1 on repeated patterns, and skips cleanly when a pattern no longer matches
rather than reporting a false catch.

### 🔴 What is still true, and what was overstated

`scripts/e2e.sh` has only ever run on one machine (WSL2). The "verified on four
platforms" line in older notes refers to the **0.4.x manual pass** in August, not
to this harness. CI still covers the unit tests on three OSes; the browser
harness covers one.

---

## 0.7.0 — 2026-08-28

### The browser is under test now: `bash scripts/e2e.sh`

Launches a headless Chrome on its own profile and its own two ports, drives it
through `/act`, and asserts what came back. 11 checks, about a minute. It never
touches the browser you are signed into, logs into nothing, and leaves nothing
behind but a throwaway profile.

It covers what unit tests cannot reach: that `goto` lands, that `read` returns
the real structure, that **`type` actually puts the whole string in the field**,
that the tab carries the agent's label, and that `press` reports what it sent.

> 🔴 **Corrected 2026-08-29.** The paragraph below overstates what was measured.
> Both mutations were functions the checks were written for, so they were always
> going to go red — that is wiring, not coverage. A real mutation run (added in
> 0.8.0, `scripts/mutate.sh`) scores **5 of 8**. See that entry.

Each check was verified by breaking the engine on purpose. Disabling the title
stamp turns exactly one check red; removing the new selector guard turns exactly
two. A check that has never failed proves only that it runs.

🔴 **Not in CI, deliberately.** It needs a real Chrome and the open internet — a
site redesign would turn the build red for a reason unrelated to your change, and
a CI that cries wolf is a CI nobody reads. Run it before a release, or when you
touch `act()`.

**Still uncovered:** logged-in flows, multi-tab ownership, `take`/`release`,
account switching. Those stay a manual four-platform pass.

### Fixed: a selector that matches nothing said the page was slow

`click` and `type` both start by scrolling the element into view, so a selector
matching **zero** elements surfaced as:

```
locator.scrollIntoViewIfNeeded: Timeout 10000ms exceeded
```

That reads as a slow page. It sent whoever was debugging to look at load times,
when the real problem was a typo — or an assumption about the tag. Found while
building the harness: `input[name=q]` on DuckDuckGo, whose search box is a
**textarea**. Now:

```
type: nothing on this page matches "input[name=q]". Run read first — it lists
the actual selectors, and the element you want may be a different tag than you
assumed (a search box is often a textarea, not an input).
```

The check costs a millisecond on the working path and turns a ten-second dead end
into an answer.

### CONTRIBUTING no longer tells you to drive your own browser

It used to suggest `node launch.js && node engine.js` on the default ports for
manual checks — which attaches to **your** Chrome on 9222. Fine until a test types
into a tab you were using. It now points at `scripts/e2e.sh`, which uses ports of
its own.

---

## 0.6.0 — 2026-08-27

### A test suite, at last

`npm test` and `python3 -m unittest discover -s test -p 'test_*.py'` now run 23
tests in about a second. Neither needs `npm install`: `node --test` ships with
Node 18+ and `unittest` ships with Python. CI runs both on Linux, macOS and
Windows, before the step that installs dependencies — so a broken install cannot
hide a broken test.

They cover the layer between what you type and what the engine runs (`mkcmd.py`)
and the helpers that decide where Chrome and its profile live (`launch.js`).
Those are the parts that fail *quietly*: a wrong path does not crash, it uses the
wrong directory and reports success.

> 🔴 **Corrected 2026-08-29** — same overstatement as 0.7.0. See that entry.

Each test was checked by breaking the code on purpose and watching it go red.
Flipping `wb type`'s default to `--fast` turns one test red; truncating the text
join turns three red. A test that has never failed proves only that it runs.

🔴 **The browser is still not covered.** Selectors, timing, tab ownership and the
CDP connection are verified by hand on four platforms before a release. An
end-to-end harness over headless Chrome remains the highest-value contribution —
see CONTRIBUTING.

### `launch.js` can be imported without launching anything

Requiring it used to start Chrome, because the startup block ran at import time.
It is now behind `require.main === module`, and the path helpers are exported.
Running `node launch.js` behaves exactly as before.

### Fixed: `__pycache__` was one allow-rule away from being committed

`.gitignore` is an allow-list, so adding `!/test/` opened everything beneath it —
including Python bytecode. There were no `*.pyc` rules at all; the deny-everything
default had been doing that job silently. Both are now explicit.

---

## 0.5.0 — 2026-08-25

**Types like a person, and tells you what it actually did.**

### Changed
- 🔴 **`wb type` types, instead of setting the value.** The default was `page.fill`,
  which drops the whole string in at once — something no person does, in a tool whose
  premise is driving a browser the way a person would. It breaks on any site that
  re-renders as you type: measured 2026-08-25 on X's composer, the same 92-character
  string arrived complete without a link and **truncated to 55 with one**, losing
  everything before the URL as the site rebuilt the field around a link preview. The
  command reported success both times, so the text went out cut short.
  - `--fast` still uses `fill` for long text in stable fields. It is opt-in on purpose:
    a fast default that quietly drops characters is worse than a slower one that does not.

### Added
- **`wb read` reports contenteditable fields, and what each field currently holds.**
  Rich composers — X, Slack, Notion, most comment boxes — are `div`s, so a page full of
  places to type showed `inputs(0)` and the agent went hunting for a selector `read`
  should have handed it. Values are shown too (`= 'text'`, or `(empty)`), because
  "did my typing land?" was previously unanswerable from this output.
  - 🔴 The `aria-hidden` duplicate that rich editors mount alongside the real field is
    skipped. Reading it returns an empty box while the visible one holds text — someone
    spent an afternoon on that, believing they had cleared a field they had not.

### Fixed
- **`wb press` accepts `Control+a`.** Playwright wants the exact key name, so a
  lowercase letter in a chord pressed something else entirely — select-all did nothing
  and the following Backspace deleted one character instead of the field.
- **`wb click` says what it actually clicked** (`click #x -> textarea [Search] "..."`).
  A selector matching the wrong element still succeeds, and the caller carries on with
  the cursor somewhere it is not — measured: aiming at a composer, hitting the search
  box, and typing a character into the middle of a URL.
- **`wb click` and `wb type` scroll to the target first.** A field below the fold is
  perfectly typeable but not clickable, and the command timed out on something that was
  never broken.
- **A demo GIF in the README**, and `scripts/make-demo.sh` to regenerate it. The tool
  had no picture of itself working, which is a poor showing for something whose whole
  claim is that you can *see* the agent driving.
  - 🔴 The script records in a **throwaway profile on its own port**. Recording in your
    normal profile puts account names, mail subjects and open tabs into a file you are
    about to publish — and that profile is signed in by design, so this is not a
    hypothetical. Your real browser keeps running, untouched.
  - It refuses to encode if any frame came out nearly empty, since a screenshot of the
    wrong tab is a small white rectangle that looks fine until opened.

### Fixed
- **`wb shot` photographed the wrong tab.** It sent a bare `{"shot":true}` instead of
  going through the command builder, so no agent name was attached — and the engine
  resolves an empty agent to a *different* tab, the one owned by the unnamed agent.
  The result was a screenshot of a blank page while every other command in the same
  session worked correctly.

  Measured 2026-08-25: 4,742 bytes of white where the real page was 253,713. Nothing
  reported an error — the file was written, the command said `Saved:`, and the image
  looked plausible until opened. Found while testing whether screenshots could be
  strung together into a demo GIF.
- **`wb show` had the same defect**, which mattered more: it exists to raise the
  agent's window when you cannot tell which Chrome is which, and without the agent name
  it would touch whichever tab the unnamed agent owned — pointing at the wrong window
  while claiming to point at the right one.

---

## 0.4.3 — 2026-08-25

**Every dial read normal while the tool would not work. Fixed the leak, and made the
tool say what is wrong.**

### Fixed
- **The engine closes its browser connection on the way out.** Playwright creates an
  isolated "utility world" per frame when it attaches over CDP, and **Chrome keeps them
  for the life of the browser** — measured 2026-08-25: `browser.close()` does not remove
  them, so each fresh `connectOverCDP` leaves one per open tab behind regardless of how
  it ends. They are harmless sitting there, but the *next* connect receives one event per
  world, so attach time grows with every reconnect until it exceeds the timeout and the
  browser cannot be driven at all.

  🔵 Normal use does not reconnect: the engine attaches once and reuses it, verified by
  running `wb` commands and watching the count stay flat. The cost lands on **restarts** —
  and the shutdown handler does not prevent that, it only stops the engine holding a
  connection open when it should not. Restart the engine often enough and the browser
  still degrades, which is why the diagnostic below matters more than the handler.

  Measured: 723 stale worlds after a run of `kill -9` during development, and
  `connectOverCDP` could not finish in 25s. What made it expensive to find is that
  everything else looked healthy — Chrome reported `Responding=true`, `/json/version`
  and `/json/list` answered instantly, the websocket handshake completed in 2ms, and a
  raw CDP command came back in 7ms. Only a count was wrong, and nothing counted it.
- **Connect failures now say which failure it is.** "Chrome is not running" and "Chrome
  answers but will not attach" need different responses, and the second one is the case
  where retrying actively makes things worse. Both messages lead with the instruction —
  *do not retry, restart Chrome* — because someone hitting this is mid-task and reads
  one line before deciding. Measured: 723 → 911 stale worlds in twenty minutes, almost
  entirely from two people diagnosing the same failure.
- **`wb status` prints the engine's diagnosis.** It grepped `/health` for `"ok"` and
  discarded the rest, so the engine was reporting the real cause while status showed a
  bare `❌ Engine`. Someone read that output dozens of times and went looking outside
  the tool, because the tool appeared to have nothing to say.
- **`wb status` knows which profile it is driving.** `launch.js` records the profile in
  `runtime.json`; `whoami` never read it, so when Chrome 151 declined to report
  `userDataDir` over CDP the status line said `Profile unknown`. The answer was on disk
  the whole time — and `unknown` reads as a finding rather than a gap, which is worse
  than silence: it prompted a reasonable worry that the agent might be driving a
  personal Chrome. Guarded on the CDP port matching so a stale file is ignored.

---

## 0.4.2 — 2026-08-25

**A clone now gets everything: the tool, the instructions, and a label that cannot
silently go missing.**

### Added
- **The agent skill ships with the tool** — `skills/wbrowser/SKILL.md`, copied to
  `~/.claude/skills/wbrowser/` by `setup.sh`. Until now the binary landed on your PATH
  and nothing told your assistant the tool existed, so a fresh clone had `wb` available
  and no idea when to use it, how to find selectors, or what it must never do (type a
  password, print a cookie, close your Chrome). Installing a tool without its
  instructions is half an install.
  - Setup will not overwrite a `SKILL.md` you edited; it writes `SKILL.md.new` and says so.

### Changed
- **`setup.sh` now registers the systemd user service itself** on Linux and WSL,
  instead of printing a suggestion to run `./install.sh` afterwards. A step people have
  to read about at the end is a step most people skip — and the symptom shows up much
  later, as "Engine is not running" in some other session after a reboot.
  - Where systemd is unavailable (common on WSL) it says so and tells you to run
    `wb up` after a reboot, rather than failing quietly or claiming success.
- `setup.sh` gained a `warn` helper. Three of the new steps can legitimately not run,
  and each one now prints why. A step that silently skips looks exactly like one that
  worked.

### Fixed
- **The tab label could not be turned off by accident.** `wb` derives the agent name
  from the working directory (`.../AGENT/<name>`), and when it could not find one it
  returned an empty string — on the reasoning that no name is better than a made-up
  one. The effect was the opposite of safe: the `[agent] ` title prefix and the
  "in control" banner simply did not appear, with no warning, while the automation
  worked normally. So the one feature that tells a human an agent is driving their
  window was off, silently, and nothing said so.

  Measured 2026-08-25: running `./wb go` from the repository root — which is what a
  fresh clone does — produced a plain `Google` title and no banner. It now falls back
  to `agent@<user>`. A generic name still makes the true claim: something automated is
  driving this tab.
- **`wb tabs` no longer truncates the owner column.** It cut names to 13 characters,
  so `wbrowser-primary::main` printed as `wbrowser-prim`, and an unnamed agent printed
  as `::main` — which reads as though the tab belongs to nobody. This column exists to
  answer "whose tab is this"; a cut name answers it wrongly rather than not at all.
  The column is now sized to the data.

---

## 0.4.1 — 2026-08-25

**Published to npm, and registered so the MCP Registry can verify we own it.**

### Added
- `server.json` — the MCP Registry manifest. Declares this as an npm package with a
  stdio transport under the name `io.github.w-partners/wbrowser`.
- `mcpName` in `package.json`. The registry verifies ownership by checking that this
  matches the name in `server.json`, so the two are kept in step deliberately.

### Changed
- Package description no longer says "already-logged-in Chrome". It never was — you
  sign into a dedicated profile once, by hand (see 0.4.0's README correction). The
  npm page renders this string, so leaving it would have republished the same claim
  we had just removed from the README.
- `.gitignore` allows `/server.json`. The ignore file is an allow-list, so a new
  top-level file is invisible until it is named — the same thing happened to
  `/scripts/` in 0.4.0.

---

## 0.4.0 — 2026-08-24

**You can now tell which version you have, and whether a newer one exists.**

### Added
- `./wb version` (also `--version`, `-v`) — prints your version and checks GitHub
  for a newer release. Until now a clone had no way to answer either question, so
  nobody downstream could know an update existed.
  - 🔴 A failed lookup says *"could not reach GitHub"*, never *"up to date"*.
    Offline and current are different facts and are reported differently.
  - Skip the network check with `WBROWSER_NO_UPDATE_CHECK=1`. It never blocks the
    command and never changes its exit status.
  - Tells forks how to pull upstream, since a fork does not follow this repo.
- `scripts/install-hooks.sh` + `scripts/pre-commit` — the pre-commit guard now
  ships as a normal file you can install. It only ever lived in `.git/hooks`,
  which git does not clone, so CONTRIBUTING told people to install something the
  repo did not contain. Installing is explicit: it never touches `core.hooksPath`,
  is not wired into `npm install`, and refuses to overwrite an existing hook.

### Fixed
- `.gitignore` allow-list had no entry for `/scripts/`, so new source files there
  were silently ignored — the opposite of what an allow-list is for.

### Documentation
- Says plainly what the arrangement is: nothing is copied. The profile holds
  cookies; your data stays on the provider's servers, and the agent reaches it the
  way your phone does. Both halves are stated — no stale copy and no second store
  to secure, but also no sandbox: when the agent opens your mail, it is your mail,
  with exactly your access. All four languages.
- Verification tables now say the same thing in both places, and WSL2 is marked
  maintainer self-verified in all four languages — the badge previously flattened
  that distinction by covering it with a single "verified".
- The zh and es editions gained the intro verification table they were missing;
  those readers could not previously see who had checked what.
- Records that headless was confirmed from process arguments, and why the
  User-Agent cannot answer that question.

---

## 0.3.0 — 2026-08-24

**One command to install, and it survives being run twice.**

### Added
- `setup.sh` — installs from nothing in one line on macOS, Linux and WSL. Checks
  what you have, clones, installs, puts `wb` on your PATH, opens the browser.
  Windows-native gets sent to a documented PowerShell route instead: `wb` is a
  bash script and does not run there, so `node bin\wbrowser.js` stands in for it.
- Setup stops a running engine and MCP server before installing, and waits for
  the ports to free. Re-running it lands you in a known state rather than a
  second copy that dies on `EADDRINUSE` while the old one keeps serving.
- CI now rejects non-ASCII in `setup.sh`, and `CONTRIBUTING.md` says why.

### Fixed
- `wb` resolves symlinks before locating its own directory, so putting it on your
  PATH (`ln -s .../wb ~/.local/bin/wb`) works. It previously looked for
  `engine.js` next to the symlink and failed there.
- The clone URL in all four READMEs contained a `<your-account>` placeholder —
  copying the first command failed.

### Documentation
- "After a reboot" — one command, `wb up`, in all four languages. The boot
  section previously covered only the systemd service, which starts the engine
  and not the browser, so it never answered the actual question.
- macOS and Windows are now told there is no auto-start installer yet, rather
  than being left to infer it from a Linux-only snippet.
- A warning not to hand-roll a shortcut passing `--remote-debugging-port` on your
  normal profile: Chrome 136 (March 2025) ignores it there and says nothing, so
  it looks like Wbrowser is broken.

### Notes for anyone verifying
`setup.sh` is deliberately pure ASCII. A Korean Windows console runs in CP949,
where a check mark has no representation at all — the output becomes question
marks and a garbled installer reads as a failed install. ASCII shares 0x00–0x7F
with CP949, EUC-KR and UTF-8, so it renders the same everywhere.

The Windows-native path in `setup.sh` has been code-reviewed but not executed —
the machine that verified Windows for 0.1.0 currently cannot run Windows binaries
from WSL. Treat it as unverified until someone runs it.

---

## 0.2.0 — 2026-08-24

**Hand a tab over mid-task.**

### Added
- `./wb tabs` is numbered and shows who is driving each tab.
- `./wb take <#>` hands a tab you are on to the agent, which carries on from the
  page you built — no re-login, no re-navigating.
- `./wb release` gives it back, label and all.

### Fixed
- **An agent could take over the tab you were reading.** The default `main` tab
  adopted whatever page was already open, which was usually yours; it would then
  click and type there and relabel the title. Checking which tabs look "unused"
  cannot fix this — a tab you opened by hand is claimed by nobody and looks free
  by every test — so adoption was removed. An agent now opens its own tabs and
  drives only those.
- The tab key included the account, which is only resolved for commands carrying
  a URL. A `goto` and the `read` right after it keyed differently, so the second
  opened a fresh page where your work had been.
- Restarting the engine abandoned every tab it was driving while those tabs sat
  open in Chrome. The agent and tab name are now written into the page itself and
  adopted back. Each probe is capped at 800ms — `evaluate` waits for a ready
  page, and one mid-navigation tab otherwise stalls the whole scan.
- Tab numbering comes from the engine alone. It used to be counted in two places,
  so `take 3` could mean a different tab than the 3 you had just read.

### Changed
- The version lives only in `package.json`; `mcp-server.js` reads it. Two copies
  of a version number drift the moment someone bumps one of them.

---

## 0.1.0 — 2026-08-23

First public release. Drive the Chrome you are already logged into, from your
terminal or any AI assistant.

- Cross-platform: macOS, Linux, Windows and WSL — one launcher.
- Uses your existing sessions. No re-login; your password is never handed over.
- Per-agent tabs, with a translucent border and an `[agent]` tab label showing
  who is driving.
- MCP server: stdio locally, or HTTP with a mandatory token.
- Scheduled jobs, with submit/pay/delete blocked by default in unattended runs.
- Console and network inspection, including uncaught exceptions.

Verified on four platforms, each by a different person on a different machine —
except WSL2, which is the maintainer's own.
