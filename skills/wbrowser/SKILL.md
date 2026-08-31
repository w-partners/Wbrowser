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
