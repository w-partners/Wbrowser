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
not the problem — playwright cannot reach its execution context because *utility worlds*
from earlier connections have built up inside Chrome (one per frame per connection, held
until Chrome restarts). **Restart Chrome (`wb up`); do not retry** — each attempt adds
another world and moves it further from working. This piles up fastest from repeated
reconnects (many `wb up`/restart cycles, or `kill -9` on the engine), not from normal
use, which attaches once and reuses it.

🔵 On WSL with Chrome running on the Windows side, a tab pointed at `127.0.0.1:<port>`
resolves to Windows itself and can hang loading forever; while that tab is open, engine
calls slow down. Close the tab, or use the machine's real/Tailscale address instead of
loopback.

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

## Several accounts

```bash
wb windows                                  # open profiles
wb -a work@example.com go https://mail...   # drive a specific one
```

🔴 Naming an account that is not open **fails**. It does not pick a lookalike —
sending mail from the wrong account is worse than an error.

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
