---
name: wbrowser
description: Use when a task needs a browser that is already signed in — reading a dashboard, checking a web app, filling a form, taking a screenshot of a real page, or debugging a site's console. Drives a real Chrome window the user signed into by hand, so no re-login and no API keys. Do not guess selectors; run `wb read` first and use what it reports.
---

# wbrowser — drive a Chrome the user is signed into

The user signed into a real Chrome window once, by hand. You drive **that window**,
so anything behind a login is reachable without credentials.

🔴 **You never handle passwords.** If a site is signed out, ask the user to sign in.
Do not type credentials, even if the user pastes them.

## Before anything else

```bash
wb status
```

| Output | Meaning | What to do |
|---|---|---|
| `✅ Chrome · ✅ Engine · ✅ N cookies` | Ready | Work |
| `❌ Chrome` or `❌ Engine` | Not running | `wb up` |
| `🔵 No logins yet` | Empty window | 🔴 **Stop. Ask the user to sign in.** |

🔴 On the last one, do not proceed. Driving an empty window and reporting success is
a real failure mode — it has happened.

## The loop

```bash
wb go <url>          # open, and print what is on the page
wb read              # what is on screen right now
wb click '<sel>'
wb type '<sel>' '<text>'
wb press Enter
wb shot /tmp/x.png   # screenshot — you can then read the image
```

### 🔴 Do not guess selectors

`wb read` reports the page's **actual** inputs and buttons with selectors:

```
inputs(1):
  - #searchbox_input  (Search the web)
buttons(3): Search, Sign in, Settings
```

Use what it printed. Guessing `input[name=q]` for a search box has failed here — the
element was a `textarea`, and `read` had said so.

## Forms

`wb type` sends **real keystrokes**, so React and similar frameworks see the same events
they would from a person. No native-setter trick is needed — just type.

```bash
wb type '<selector>' 'the text'
wb type --fast '<selector>' 'long text'   # sets the value in one go
```

🔴 **Do not reach for `--fast` by default.** It sets the value in one shot, which any
site that re-renders while you type will partly swallow — measured on X's composer: a
92-character string with a link arrived as 55, losing everything before the URL, and the
command still reported success. Use it only for long text in a plain, quiet field.

🔵 **Check what landed.** `wb read` now prints each field's current contents
(`= 'text'` or `(empty)`), so verifying is one command, not a hand-written `eval`.

## 🔴 Before anything irreversible

Submit, pay, delete, send:

1. **Read back every value you entered** and show the user
2. Wait for them to say go
3. Then click, and report what actually happened

🔵 Real case: filling ten booking rows, rows 2–10 had empty name and phone fields.
Pressing submit would have created nine nameless bookings. Reading the rows first
caught it.

## Repeating an action — count, don't spray

```bash
# 🔴 Wrong: eight presses in a row produced forty rows
for i in $(seq 1 8); do wb press Enter; done

# ✅ Right: press once, count, stop when you reach the target
for i in $(seq 1 12); do
  n=$(current_count)
  [ "$n" -ge 10 ] && break
  wb press Enter; sleep 0.6
done
```

## Debugging a page

```bash
wb console          # console output + uncaught exceptions
wb console 'error'  # filter by regex
wb network          # failed requests (404, CORS)
wb logs             # engine log
```

🔵 `pageerror` (uncaught exceptions) never reaches `console.error`. `wb console`
returns both.

### When `read` times out but the page is fine

If `read` times out and the message says Chrome answers raw CDP instantly, the page is
not the problem — playwright cannot reach its execution context. **First restart the
engine — `wb down && wb up`.** The stale connection often lives in the engine's playwright
client, not Chrome, and an engine restart is light and touches nobody else's tabs (measured
2026-09-04: restarting Chrome left the symptom; `wb down && wb up` cleared it). **Only if
that does not clear it, restart Chrome** — heavier, because it closes open windows that may
be the master's or another agent's, so get the master's OK first: *utility worlds* from
earlier connections can build up inside Chrome (one per frame per connection, held until
Chrome restarts) and only a Chrome restart clears those. Do not retry either way — each
attempt adds another world. This piles up fastest from repeated reconnects (many restart
cycles, or `kill -9` on the engine), not from normal use.

🔵 **Closing Chrome on WSL:** `wb` never kills Chrome itself (it may be a window you're using).
When you do need to restart it, `powershell.exe`/`taskkill` may not be on the path if WSL interop
isn't configured (reported 2026-09-05). The portable way is the CDP browser endpoint, which works
wherever the debugging port does: open a websocket to the `webSocketDebuggerUrl` from
`curl http://127.0.0.1:9222/json/version` and send `{"id":1,"method":"Browser.close"}`. Then
`wb up` starts a fresh Chrome (and clears the utility-world buildup).

**Which layer is it?** These look alike from the outside but want different fixes. You do
not need to hand-write raw CDP — `wb status` already probes CDP and the engine, so read it
together with a `wb read`: `❌ Chrome`/`❌ Engine` → layer 1; `✅ Chrome` but you cannot
operate → not layer 2; everything green in `wb status` but `wb read` times out → layer 3.
The order and the layers (method from a peer's field notes, 2026-09-04):

1. **Is anything listening?** `curl` to the engine or CDP port refused instantly (HTTP 000,
   a few ms) means the port is not held — Chrome or the engine is gone, not stuck. Fast and
   unambiguous. 🔴 Judge engine liveness by `/health` (the port), **not** `pgrep engine.js`:
   the process can be alive while holding no port (measured — a live PID answering nothing).
   🔴 **HTTP 000 is two different things**: an *instant* refusal (0–6ms — no socket, waiting
   won't change it) vs a *timeout* (a slow engine cut off — raise `WB_HEALTH_TIMEOUT` and
   measure once more before calling it dead; a 10.9s /health has been misread as dead).
   🔵 **A special case: the port is held (a live PID) but `/health` never answers, even for
   30s+.** That is not "slow" — the engine is *stuck* attaching, because `connectOverCDP`
   hangs replaying stale execution contexts (its own timeout does not cover that phase). Since
   0.13.10 the engine bounds this itself and turns it into a named error (utility-world
   buildup — restart Chrome, with the master's OK); before, it just sat silent. Raise
   `WBROWSER_CONNECT_TIMEOUT` if 30s is genuinely too short for your box, but a multi-minute
   hang means buildup, not slowness.
2. **Does raw CDP answer?** If `/json/version` does not respond, the fault is in Chrome
   (utility-world buildup) — only a Chrome restart clears it.
3. **Does raw CDP answer but playwright does not?** Then it is the *engine's* connection —
   an engine restart (`wb down && wb up`) can clear it without touching Chrome. This is also
   the case the raw-CDP fallback covers: if the fallback works, you are in this layer.
   🔴 **`/health` returning `ok` does NOT rule this out.** `/health` answers "is the engine
   process alive", by design — it does not check that playwright can attach. In a half-dead
   state the engine is fine and says so while its playwright client is dead (see the
   "was healthy and said so; it was holding a dead tab" note in engine.js). So do not close
   on a green `/health` — layer 3 sits behind it.

🔵 On WSL with Chrome running on the Windows side, a tab pointed at `127.0.0.1:<port>`
resolves to Windows itself and can hang loading forever; while that tab is open, engine
calls slow down. Close the tab, or use the machine's real/Tailscale address instead of
loopback.

🔵 If playwright's connection goes half-dead (it times out while Chrome still answers raw
CDP), the engine falls back to a **raw-CDP lane** so you keep working — `go`/`read`/`eval`/
`shot`/`press` still run (responses are marked `via: "rawcdp"`). It is a reduced lane:
`click` is best-effort by coordinate and fails loudly rather than clicking nothing, and
opening tabs/windows needs a Chrome restart. Restart Chrome (`wb up`) to restore the full
engine when you can.

🔴 On that fallback lane, a command only ever touches **your own** tabs. If your agent has no
live tab of its own, the fallback **refuses** with `no tab stamped for '<agent>' … refusing
to attach to another agent's tab` — it will not borrow a stranger's tab, even the only live
one. (Before 0.13.8 it could, under load: a slow own-tab made `eval`/`shot` fall through to
another agent's logged-in page. Fixed.) If you hit that refusal, **restart the engine**
(`wb down; wb up`) — that is the only fix from here. Do **not** try to `go` your way out of it:
on the fallback, `go` needs a stamped tab too and just reprints the same refusal (a loop). If
the engine comes back still on the fallback, a utility-world buildup is holding playwright down
and only a Chrome restart clears it (get the master's OK).

🔵 If your own tab's **renderer** has hung (its `Page`/`Runtime` time out while `/json/list`
still answers — a long-reused tab can reach this), the fallback **closes that tab for you** and
says so: `'<agent>' had N tab(s) whose renderer had stopped responding … closed the stale
tab(s). Run the command again`. Just re-run — it opens a fresh tab. No Chrome restart needed,
and only your own tabs are ever closed. (0.13.9)

## Tabs

```bash
wb tabs      # every tab, and who is driving it
wb take 3    # the user hands you a tab they were working in
wb release   # give it back, and drop the [agent] label
wb close     # close only the tabs you opened
```

🔵 You work in **your own tab** — you never inherit the one the user is reading, and
you never pull the window to the front. The tab title shows `[<agent>] …` and the page
carries a translucent "in control" banner, so the user can always see it is you.

🔵 The engine caps how many tabs agents leave open: when it opens a new one it first
closes any agent tab that went blank, and if more than 8 agent tabs are alive it closes
the oldest. So a long session no longer climbs to 30-40 tabs. Only tabs an agent opened
are touched — a tab you opened by hand, or a login tab, is never counted or closed.

🔴 The flip side, and be honest about it if asked: **moving the mouse does not pause
you.** You are not yielding the tab, you simply never shared one.

### One agent, two tabs — as tabs or as side-by-side windows

Name your tabs and drive both from the one connection:

```bash
wb go https://A --tab left            # a tab named 'left'
wb go https://B --tab right           # another named 'right'
wb --tab left read                    # later commands reach the same tab by name
```

Add `--window` to split a tab off into its **own OS window** — same Chrome, same
control (it is one CDP connection either way), just laid out separately so you can
watch two pages at once:

```bash
wb go https://A --tab left  --window
wb go https://B --tab right --window   # now two windows, still one agent driving both
```

🔵 `--window` changes the *layout*, not the control — splitting into windows never
costs you the connection. It is not a second browser: for a genuinely separate Chrome
(its own profile and logins) use a numbered browser (below).

### Which agent you run as (and why `wb shot` sometimes saved the wrong tab)

Every command runs *as an agent*, and each agent gets its **own** tabs — `wb shot`
captures the tab belonging to the agent the command runs as, never "whatever tab is on
top". The name is derived automatically (from the working directory, then the process
tree). If that derivation cannot find it, the name falls back to `agent@<you>` — and
then a `go` and a later `shot` can land on *different* identities' tabs, so the
screenshot is of a page you never navigated to (in the field: another agent's logged-in
page saved to your disk).

Force the identity when the auto-derivation is wrong:

```bash
wb go https://A --agent my-agent      # run this (and its tab) as 'my-agent'
wb shot out.png --agent my-agent      # screenshot my-agent's tab, not a guess
```

🔴 `--agent` is a real flag (added because it used to be silently swallowed — it looked
like it worked and did nothing). Unknown flags now **fail loudly** instead of being
dropped: `wb shot out.png --typo` says so rather than screenshotting the wrong tab.
`--account`, `--tab`, `--agent`, `--browser` work on any command; `--window`/`--fast`
are for `go`/`type`.

## Several accounts

```bash
wb windows                                  # open profiles
wb -a work@example.com go https://mail...   # drive a specific one
```

🔴 Naming an account that is not open **fails**. It does not pick a lookalike —
sending mail from the wrong account is worse than an error.

## Logging in without exposing the password (`wb login`)

When a site is **not** already signed in, you normally stop — you cannot type the user's
password, and you should not. `wb login` closes that: the user stores a credential once, and
the engine fills the login form for you. **The AI never sees the password** — it is entered by
the user, encrypted into a local vault, and typed into the field over CDP. The value never
crosses into the agent's context, the logs, or the audit trail.

```bash
wb login example.com --save     # the USER types username + password here (echo off).
                                #   Stored encrypted in ~/.wbrowser/creds.enc — you never see it.
wb login example.com            # the engine unlocks the vault and fills the login form.
wb login example.com --confirm  # …and clicks submit (first time per site needs this; then remembered)
```

- 🔴 `--save` requires the **user at the terminal** — the agent cannot enroll a credential on
  the user's behalf (that is the point). If you need a credential stored, ask the user to run
  `wb login <site> --save`.
- The engine **refuses** rather than guess: if it cannot confidently find the password field
  (none visible, or two — a change-password form), it says so and types nothing. A secret in
  the wrong field is the worst outcome, so it is designed out.
- Submit is gated: the first login per site waits for `--confirm`; after that the choice is
  remembered for the engine's lifetime.
- Every use is written to an audit log (`~/.wbrowser/creds-audit.log`) — which site, which
  action, when, username masked — **never the value**.
- The vault is unlocked once per engine start (the user enters the master passphrase); a
  `wb down; wb up` re-locks it.

## Remembering which site is for which task

A small **local** memory so you don't have to be told the site every time. Record the site you
use for a kind of task, then recall it later.

```bash
wb remember email mail.example.com   # "for the 'email' task I use mail.example.com"
wb recall email                      # → mail.example.com (used 3×)
```

- 🔵 **Local only.** It lives in `~/.wbrowser/memory.json` (0600) and is **never sent to any
  model**. It stores only a task tag, the origin, a count and a timestamp — no URLs with query
  strings, no page contents, no cookies.
- 🔴 `wb recall` on an unknown tag returns **nothing** — it never hands you a wrong site. Ask or
  store one; do not guess.
- Recall ranks the site you use most for that tag first.

## Scheduled runs

```bash
node cron.js list          # registered jobs   (run from the install directory)
node cron.js run <name>    # once, now
node cron.js daemon        # on schedule
```

🔴 Unattended runs **refuse** submit / pay / delete unless that job explicitly sets
`"allowIrreversible": true`. Nobody is watching when a cron job goes wrong.

## 🔴 Never

- **Type a password, card number, or national ID.** The user does that.
- **Print or log cookie values.** A cookie *is* the login.
- **`wb down` to close Chrome.** It may be the user's window. `wb down` stops the
  engine only — say so rather than killing the browser.

## Other machines

Sessions are per-machine; you cannot drive another machine's browser (the engine
binds to `127.0.0.1`). Install there and have that user sign in:

```bash
curl -fsSL https://raw.githubusercontent.com/w-partners/Wbrowser/main/setup.sh | bash
```

## Driving it over HTTP

`wb` is a wrapper. If you are calling the engine yourself, there is one endpoint —
`POST /act` on `127.0.0.1:7979` — and **the verb is a key, not a value**:

```bash
curl -s -X POST http://127.0.0.1:7979/act -H 'Content-Type: application/json' \
  -d '{"read":true}'
```

| what | payload |
|---|---|
| read the page | `{"read":true}` |
| screenshot | `{"shot":true}` |
| both at once | `{"read":true,"shot":true}` |
| navigate | `{"goto":"<url>","read":true}` |
| click | `{"click":"<selector>","wait":1200,"read":true}` |
| type | `{"type":{"selector":"<sel>","text":"..."}}` |
| keys | `{"press":"Control+A"}` |
| run JS | `{"eval":"document.title"}` |
| console / errors / network | `{"console":true}` `{"errors":true}` `{"network":true}` |

Add `"agent":"<your name>"` so the tab is labelled, and `"tab":"<name>"` to keep
separate tabs.

🔵 `{"action":"read"}` is not a thing. Anything the engine does not recognise comes
back as **400** naming the key — it will not accept a command it cannot carry out.

🔴 **Before anything you cannot undo** — submitting, paying, sending, deleting —
take `{"read":true,"shot":true}` in one call and keep both. The DOM alone has let
silent failures through: text truncated to 55 of 92 characters and reported as
success, rows two through ten of a form left empty. A selector failure looks the
same in the DOM whether it was a login wall, a modal, or a bot check; the pixels
tell you which. One call, because two round trips can straddle a change.

## Several browsers at once

A second Chrome — its own window, profile and logins, fully separate from the one you
are signed into. Register it once (it gets a permanent number), start it, sign in by
hand the first time.

```bash
wb new work          # register 'work' — gets a number, e.g. 2, and keeps it
wb -b work up        # start it; a window opens, sign into it once
wb -b work go https://mail.google.com
wb -b 2 read         # name or number, either works
wb browsers          # list them
```

Tab titles read `[browser-tab]`: `[1-2]` is the second tab of browser 1, `[2-1]` the
first tab of browser 2. That is how you point at one tab among several browsers.

🔵 No `-b` means browser 1 — the Chrome you were already logged into, unchanged. The
number is fixed once assigned, so `[2-1]` today is `[2-1]` tomorrow.
🔴 Each named browser starts empty. A person signs into it; agents never handle
passwords.

## Driving CDP by hand — field notes

If you skip `wb` and speak Chrome DevTools Protocol directly (comparing two tabs,
scripting a sweep), these came out of real use:

- **Navigate with `Page.navigate`, not `location.href` in `Runtime.evaluate`.**
  Changing `location.href` inside an evaluate often left the *next* CDP call hanging —
  the navigation tears down the execution context the evaluate is waiting on, and the
  reply is lost. `Page.navigate({url})` returns straight away. (Measured: five-plus
  timeouts with `location.href`, none after switching.)

- **Move tabs one at a time.** Navigating two tabs at once (via `location.href` in
  evaluate) timed out almost every time; sequential was stable. This may just be a
  second face of the point above — the same lost-reply, seen twice — so if you already
  navigate with `Page.navigate`, one-at-a-time may not be needed. Not independently
  confirmed.

- **Do not decide "these two screens match" from `innerText`.** Text comparison called
  a screen identical while it was missing three icons (not text), had an empty grey
  card (not text), and had a title with another string printed over it (both unreadable).
  Take `Page.captureScreenshot` and *look* — text and geometry are supporting evidence,
  not the verdict. `wb read` already pairs with `wb shot` for exactly this; use both.
  Real cases only the screenshot caught: empty grey cards, whole icons missing, a
  263px blank gap where a preview should be, and an audio result that was raw PCM the
  browser could not open — reported "success" from the 128KB file size alone.

- **A file existing is not the file working.** Bytes on disk (a 128KB download, a
  saved screenshot) do not mean the thing opened, rendered, or decoded. Verify the
  result, not the size — check that it actually *loads*:

  ```js
  // audio: only loadedmetadata counts as success
  const ok = await new Promise(r => {
    const el = new Audio(url);
    el.addEventListener('loadedmetadata', () => r({ok:true, dur:el.duration}));
    el.addEventListener('error',          () => r({ok:false, code:el.error?.code}));
    // a timeout is a FAILURE, not a pass — a broken file can hang with no error
    // event at all (a stale server did exactly this). ~6s is a local guess.
    setTimeout(() => r({ok:false, code:'timeout'}), 6000);
  });
  // video: same loadedmetadata shape.
  // image: await img.decode(), OR new Image().onload — the latter also gives
  //        naturalWidth/Height, so you get "loaded + dimensions" in one shot.
  ```

- **Before blaming your fix, check the server isn't holding the old file.** A corrected
  file still failed to load because the server was serving a pre-restart index — the
  browser got the *old* bytes (131086B) while disk had the fixed ones (131130B). Log
  the received byte-count next to the on-disk byte-count; if they differ, the server is
  stale, not your fix. (Same shape as a `kill -9`'d engine holding a stale browser
  state — always ask "is the server holding the current thing?" before you dig.)

- **Listing overlapping elements is a hint, not a verdict.** If you compute overlaps,
  the caller must judge them — a page often *stacks elements on purpose* (a background
  card under content), and that is indistinguishable from a real defect (a caption
  printed over a title) by geometry alone. Excluding parent/child nesting is still
  required, or every container reads as an overlap and buries the real ones:

  ```js
  if (a.contains(b) || b.contains(a)) continue;   // nesting is not overlap
  const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left);
  const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
  if (ox > 3 && oy > 3) { /* candidate — a human/model still decides */ }
  ```

- **The CDP port is not fixed — scan for it, never hardcode.** A number baked into a
  config goes stale the next launch.
