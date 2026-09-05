<div align="center">

# 🤖 Wbrowser

**Your AI can't see anything behind a login. This fixes that — on the OS you actually use.**

Your assistant can search the web, but it can't open your inbox, your dashboard, or your
company's internal tool. Everything useful is behind a sign-in it doesn't have.

Wbrowser gives it a seat at **a real Chrome that you sign into once, by hand.**
Not a headless browser and not a copy of your profile — a window you use too. You
watch each click land, in a tab the agent opened for itself, never the one you are
reading.

🔵 To be plain about the setup: Chrome 136+ refuses remote debugging on your default
profile, so this runs a dedicated one and **you sign in there once.** After that the
session persists — one Google sign-in also carried YouTube and two systems that use
"Sign in with Google" on a real profile we measured. It is one setup, not zero.

![Wbrowser driving a real Chrome tab, with the in-control banner visible](docs/media/demo.gif)

<sub>The agent works in its own tab. The border and the `[agent]` title say who is
driving, so you can always tell at a glance — recorded in a signed-out profile with
`scripts/make-demo.sh`.</sub>

And it goes the other way: get halfway through something tedious, then hand that
exact tab over — `./wb take 2` — and the agent carries on from the page you built.

**The AI never sees your password.** Log in by hand and Chrome keeps it, or store it once
in a local encrypted vault (`wb login`) that the engine — never the AI — reads. Either way
Wbrowser drives the window that's already open and the model never receives the secret.

Runs on **Windows, macOS, Linux and WSL** — each measured on real hardware, on a
different machine, by someone other than the person who wrote that part:

| Platform | Chrome | Verified by |
|---|---|---|
| Windows 10 | 151 | different machine & operator — incl. end-to-end |
| macOS 15 | 151 | different machine & operator |
| Linux (headless) | 148 | different machine & operator — incl. security review |
| WSL2 | 151 | maintainer (self-verified) |

<sub>Measured 2026-08-24. Not every check ran everywhere — details in
[Platform notes](#platform-notes). WSL2 is the maintainer's own environment, so it
is self-verified rather than independently checked.</sub>

About **2,600 lines** of JavaScript, Python and shell. MIT. Small enough to read in an
afternoon and change to suit you.

[English](README.md) · [한국어](docs/README.ko.md) · [中文](docs/README.zh.md) · [Español](docs/README.es.md)

[![check](https://github.com/w-partners/Wbrowser/actions/workflows/check.yml/badge.svg)](https://github.com/w-partners/Wbrowser/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-independently%20verified-success)
![Windows](https://img.shields.io/badge/Windows--native-verified-success)

</div>

---

## Why this exists

AI browsers all take the same shape: you install a *new browser* with an assistant
inside — **Aside**, **Comet**, **Dia**. That shape costs you three things:

| Their shape | What it costs |
|---|---|
| A new browser to install | A new profile, new logins, new defaults |
| The assistant lives inside it | Your sessions sit in someone else's build |
| Platform is their choice | Aside and Dia are macOS-only today |

**We took the opposite arrangement.** No browser to install and nothing to migrate —
it drives the Chrome already on your machine, in a window you can watch and use.
You watch every click land, in a tab the agent opened for itself. Nothing to migrate,
nothing to hand over.

🔵 To be exact about what that does and does not mean: the agent never takes the tab
you are reading and never pulls the window to the front, so you can keep working
alongside it. It does not pause when you move the mouse — you are not interrupting
it, you were simply never sharing a tab. When you *do* want it on the page you are
looking at, you hand that tab over yourself with `./wb take <#>`.

That choice is also why this runs on Windows, macOS, Linux and WSL: we didn't have to
build a browser for each one, so there was no platform to pick.

> **Need something? Build it.**
>
> That's the whole idea. Not a product waiting on someone else's roadmap —
> a small tool you own, on the machine you already use, in the browser you signed
> into yourself. About 2,600 lines of JavaScript, Python and shell — small enough to read
> in an afternoon. Read it, change it, make it yours.

Wbrowser targets **Windows, macOS, Linux, and WSL** — because "which OS are you on?"
should never be the reason you can't automate your own browser.
Measured on macOS, native Linux, WSL2 and Windows-native — though not every check ran
on every platform (see [Platform notes](#platform-notes)).

---

## What is this?

Most automation tools give your AI a *fresh, empty* browser. So it can't see your email,
your dashboards, or anything behind a login — unless you hand over passwords or set up
API integrations for every single service.

Wbrowser takes the opposite approach: **you log in once, by hand, in a normal Chrome window.**
After that, your terminal (or your AI assistant) can drive that exact window — already
logged in, everywhere.

```bash
./wb go https://mail.example.com   # opens in YOUR logged-in session
./wb read                          # tells you what's on screen
./wb click '#compose'              # clicks it
```

**Wbrowser never sees your passwords.** You type them — into Chrome, or once into a local
encrypted vault the engine reads (`wb login`, opt-in). Either way the AI never receives them;
Wbrowser just drives the window that's already open.

---

### Nothing is copied — it is your account, live

This is worth being precise about, because it is the difference between this and
most tools in the space.

Wbrowser holds **no copy of your data**. The profile folder contains cookies —
proof that you signed in — and nothing else. Your mail, your files, your dashboards
stay on the provider's servers, exactly as they do for your phone. The agent sees
them the same way your phone does: by presenting that proof and asking.

```
Google's servers          your account, your data
        |
        +-- your laptop Chrome     a session
        +-- your phone             a session
        +-- Wbrowser               a session   <- you created this by logging in
```

Two consequences, and you should hold both:

- 🔵 **No stale copy, no sync, no second place to secure.** Log out on Google's
  side and every session ends, including this one. Nothing lingers in a folder
  waiting to be stolen.
- 🔴 **It is the live account, not a sandbox.** When the agent opens your mail, it
  is your mail. Access is exactly what you have — no more, and no less.

> ⚠️ Copying a profile folder does not work anyway. We tried: 685 cookies became 3.
> Chrome invalidates a profile it does not recognise. Signing in by hand is not a
> workaround for that — it is the only arrangement that holds.

### One login often unlocks many sites

This is the part that makes it worth the setup. Log into Google once in that window and:

```
Google itself       google.com · youtube.com · your Workspace apps
Sites using Google SSO   your CRM, your booking system, your dashboards —
                         whatever "Sign in with Google" reaches
Everything else     log in by hand once; it stays
```

Measured on a real profile: **one Google sign-in** brought along YouTube and two
internal business systems that use Google SSO — none of which were logged into
separately. The rest (GitHub, Reddit, a bank-like portal) were signed into by hand
once and have persisted since.

So the setup cost is roughly: *one Google login, plus one login each for whatever
doesn't use Google.* After that your agent reaches all of it.

🔴 The flip side is the same fact: **whoever can drive this browser can act on every
one of those sites.** See [Security](#security).

### What it won't do

- **Expose your password to the AI.** You sign in by hand, or store it once in a local
  encrypted vault only the engine can read (`wb login`, opt-in) — the model never receives
  it either way. `type` never logs what was typed.
- **Print cookie values.** Not in output, not in logs — cookies *are* the login.
- **Guess which account you meant.** Name an account that isn't open and it fails.
  Sending mail from the wrong account is worse than an error message.
- **Click submit / pay / delete on a schedule.** Unattended jobs refuse those steps
  unless that specific job opts in. Nobody is watching when a cron job goes wrong.

### One limit we measured and are telling you about

Chrome's debugging port has **no authentication**. Any process running as *you* on that
machine can attach and drive your sessions — we verified this by connecting from an
unrelated process and listing the open tabs. `127.0.0.1` is not a fence; it means
"anything running as you gets in".

That is Chrome's design, not something we added, and every tool in this category
inherits it. We'd rather write it down than let you find out later —
see [Security](#security) for the full threat model.

## Quick start

**macOS · Linux · WSL** — one command:

```bash
curl -fsSL https://raw.githubusercontent.com/w-partners/Wbrowser/main/setup.sh | bash
```

It checks what you have, clones, installs, puts `wb` on your PATH, installs the agent
skill so your assistant knows the tool exists, registers the engine to start with your
session (Linux/WSL with systemd), and opens the browser window. Then you log into your
sites in that window — by hand, as usual — and that is the whole setup.

🔵 Each of those is done, not suggested. A step that cannot run says so on screen
rather than skipping quietly — on WSL without systemd, for instance, it tells you to
run `wb up` after a reboot instead of pretending the service was registered.

<details>
<summary><b>Windows, natively (PowerShell — no WSL)</b></summary>

```powershell
git clone https://github.com/w-partners/Wbrowser.git
cd Wbrowser
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
node launch.js          # log into your sites in the window that opens
node engine.js          # leave this running
node bin\wbrowser.js go https://github.com
```

`wb` is a bash script, so on Windows use `node bin\wbrowser.js` in its place.
Everything else is identical.

**WSL is the easier route** if you have it: `wsl --install` once, then run the
one-line command above inside Ubuntu. Either way it drives your Windows Chrome.
</details>

<details>
<summary><b>Or do it by hand (any platform)</b></summary>

```bash
git clone https://github.com/w-partners/Wbrowser.git
cd Wbrowser
# Wbrowser drives your *system* Chrome, so Playwright's own browser
# download is unnecessary — skip it and save ~400MB:
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

node launch.js       # 1. opens a dedicated Chrome window
                     # 2. log into your sites in that window (by hand!)
node engine.js       # 3. start the control engine
./wb go https://example.com
```

Step 2 is the only thing you ever do manually.
</details>

### If setup stops

It stops rather than half-finishing, and the message names the cause. Two come up
most often:

| It says | Do this |
|---|---|
| `several user folders` (WSL) | `ls /mnt/c/Users` to find yours, then<br>`WBROWSER_PROFILE_DIR=/mnt/c/Users/<you>/.wbrowser ./wb up` |
| Chrome not found | `WBROWSER_CHROME=/path/to/chrome ./wb up` |

> **If `./wb` says "Permission denied"** — the executable bit didn't survive the
> clone (some setups strip it). Fix it once:
> ```bash
> chmod +x wb install.sh autostart.sh sync-session.sh
> ```

> **Headless servers (no display):** Wbrowser detects a missing `$DISPLAY` and
> launches Chrome headless automatically. Force it either way with
> `WBROWSER_HEADLESS=1` or `=0`. Note you can't log in by hand without a screen —
> use `./sync-session.sh import` to bring sessions over from a desktop machine.
>
> To confirm it really is headless, check the **process arguments** —
> `ps -o args= -p <chrome-pid>` should show `--headless=new` and
> `--ozone-platform=headless`. That is how the Linux run above was verified.
> 🔵 Don't use the User-Agent for this: `--headless=new` may or may not put
> `HeadlessChrome` in the UA string, so the UA can't tell you either way.

> **Windows users:** run these inside WSL, or use `node` directly on Windows —
> both work. See [Platform notes](#platform-notes).

---

## Why a separate Chrome window?

Since **Chrome 136** (March 2025), `--remote-debugging-port` is **ignored** for
Chrome's default profile directory. Google made this change because attackers were
using remote debugging to steal cookies.

So a non-default `--user-data-dir` is now **mandatory**. Wbrowser creates one at
`~/.wbrowser` and launches Chrome there.

**This means your existing logins do not carry over.** You log in once in the new
window, and they persist there from then on.

> ⚠️ Copying your Chrome profile folder does **not** work. We tried: 685 cookies
> became 3, and every session cookie was dropped. Chrome invalidates profiles it
> doesn't recognize. Log in fresh — it takes a minute and it actually works.

---

## Commands

```bash
./wb go <url>              open a page, return its structure
./wb read                  summarize the current page
./wb click <selector>      click an element
./wb type <selector> <text>   type into a field, one keystroke at a time
./wb type --fast <sel> <text> set the value in one go (see below)
./wb press <key>           Enter, Tab, Escape, ArrowDown…
./wb eval '<js>'           run JavaScript in the page
./wb console [regex]       console logs + uncaught exceptions
./wb network               failed requests (4xx/5xx, CORS, timeouts)
./wb shot [file.png]       screenshot
./wb tabs                  numbered tab list — and who is driving each one
./wb take <#>              hand a tab you are on to the agent
./wb release               take that tab back
./wb close                 close only the tabs you opened
./wb status                is everything up? which profile?
./wb show                  bring the browser window to the front
```

### Don't guess selectors

`./wb read` returns the *actual* clickable elements on the page:

```
inputs(1):
  - #searchbox_input  (Search the web without being tracked)
buttons(3): Search, Sign in, Settings
```

Copy from there. (We once guessed `input[name=q]` for a search box — it was a
`textarea`. `read` had the right answer all along.)

---

## Just tell your assistant what to do

Once connected, you stop typing commands and start describing outcomes:

> *"Open my dashboard and summarise today's numbers."*
> *"What's in my cart on that shopping site?"*
> *"Check whether that booking actually went through."*

The connection uses the [Model Context Protocol](https://modelcontextprotocol.io) —
if your assistant supports MCP (Claude, Cursor, and others do), this is a few lines
of config and you're done.

**Local (stdio):**
```json
{
  "mcpServers": {
    "wbrowser": {
      "command": "node",
      "args": ["/path/to/Wbrowser/mcp-server.js"]
    }
  }
}
```

**Remote (HTTP):**
```bash
export WBROWSER_MCP_TOKEN=$(openssl rand -hex 32)
node mcp-server.js --http --port 7982 --host 127.0.0.1
```

Then just talk to your assistant:

> *"Open my dashboard and summarize today's numbers."*
> *"What's in my cart on that shopping site?"*

**Tools:** `browser_open` `browser_read` `browser_click` `browser_type` `browser_press`
`browser_eval` `browser_console` `browser_screenshot` `browser_tabs` `browser_status`

> 🔴 **The remote server refuses to start without a token.** This isn't optional —
> it drives a browser holding all your logins. Anyone who reaches that port becomes you.

---

### What an agent should know before driving

These came from actual mistakes made while building this. If you write your own
skill/prompt around Wbrowser, put them in it:

1. **Don't guess selectors.** `browser_read` returns the real ones on the page.
   We guessed `input[name=q]` for a search box; it was a `textarea`, and `read`
   had said so all along.
2. **Read the form back before submitting.** In one batch form, rows 2-10 had empty
   customer fields because the "keep" checkboxes didn't cover them. Reading every row
   before clicking caught it; clicking first would have created 9 broken records.
3. **Count as you repeat.** Sending 8 Enter presses in a row produced 40 rows — the
   page handled them faster than expected. Press once, count, stop at the target.
4. **Just use `type`.** It sends real keystrokes, so React and friends see the same
   events they would from a person and no native-setter trick is needed. This used to
   be the other way round — `type` set the value in one shot, which framework forms
   swallowed — and the workaround was `eval` with a native setter. That is no longer
   necessary. Reach for `--fast` only when the text is long and the field is plain.
5. **Check what you're attached to.** `browser_status` tells you whether the window
   actually holds logins. An empty profile answers every command successfully while
   doing nothing useful.

## Scheduled jobs (cron)

Create `jobs/morning-check.json`:

```json
{
  "schedule": "0 9 * * 1-5",
  "tab": "morning",
  "steps": [
    { "goto": "https://dashboard.example.com", "wait": 2000 },
    { "eval": "document.querySelector('.total').innerText" },
    { "shot": true }
  ]
}
```

```bash
node cron.js list      # what's registered
node cron.js next      # when each job runs next
node cron.js run <name>   # run once, now
node cron.js daemon    # run on schedule
```

`0 9 * * 1-5` = *minute 0, hour 9, weekdays.* Standard 5-field cron.

### Irreversible actions are blocked by default

Unattended automation means **nobody is watching when it goes wrong.** So steps that
look like submit / payment / delete are **refused**:

```
⛔ step 2 blocked — looks irreversible (click: #submit-payment)
   If you meant it, add "allowIrreversible": true to the job file.
```

You opt in per job, not globally.

---

## Who's driving? (visual indicator)

When an agent is controlling the browser, you see it:

- **A translucent border** around the page, with a label: `🤖 my-agent in control`
- **The tab title** gets prefixed: `[my-agent] Dashboard`

The border fades after 6 seconds of inactivity, so "in control" actually means
*right now*. Colors are derived from the agent name, so multiple agents are
distinguishable at a glance.

The tab prefix survives navigation — a `MutationObserver` re-applies it whenever
the page rewrites its own title (which SPAs do constantly).

🔵 **The label is never silently absent.** The agent name normally comes from the
working directory (`.../AGENT/<name>`); when that yields nothing — running from the
repo root, for instance — it falls back to `agent@<user>` rather than an empty name.
An unnamed agent would have produced a bare title and no banner, which looks exactly
like no agent being present. Set it explicitly with `WIN_AGENT=<name>`.

### Several agents, several tabs, at once

Each agent drives **its own tab**, keyed by `<agent>::<tab>`:

```bash
./wb go https://example.com                 # this agent's 'main' tab
WIN_AGENT=other ./wb go https://news.site   # a different agent, its own tab
```

```
./wb tabs
  #  driven by               title
  1  — (yours)               your own tab, untouched
  2  wbrowser-primary::main  [wbrowser-primary] Example Domain
  3  other::main             [other] News
```

Running another command as the same agent **reuses that tab** rather than opening a
second one, so an agent keeps working in one place instead of scattering pages behind
you. Agents never share a tab, so two working at once do not tangle — and neither
touches the tabs you opened yourself.

🔵 `main` is currently the only tab an agent drives directly; the `<agent>::<tab>`
key already supports more, and `./wb take <#> [tab-name]` uses it when you hand over
a second page. Driving several named tabs per agent from the CLI is not wired up yet.

🔵 If the engine restarts it re-adopts its tabs by asking the pages who owns them,
so work in progress is not abandoned in a tab nobody is watching.

---

## Hand a tab over mid-task

You are three pages into something — filtered a list, filled half a form, dug
into a dashboard. It is going to take another twenty minutes and you would
rather not do it. Point the agent at that tab and let it carry on:

```bash
./wb tabs
  #  driven by      title                                url
  1  — (yours)      Bookings — March                     https://…/bookings?from=03-01
  2  — (yours)      Invoice 4417                         https://…/invoices/4417
  3  my-agent       [my-agent] GitHub                    https://github.com/…

./wb take 1          # the agent picks up tab 1, exactly where you left it
./wb release         # you take it back
```

No re-login, no re-navigating, no explaining what you already did — the agent
gets the page in the state you built.

**An agent never takes a tab on its own.** It opens its own tabs and drives only
those; the only way it touches yours is if you hand it over by number. That is
not a policy, it is how the lookup works — an agent has no way to name a page it
did not open.

> This was not true before 0.2.0. The agent's default tab used to adopt whatever
> page was already open, which was usually the one *you* were reading — it would
> then click and type into your tab and relabel its title. Checking which tabs
> look "unused" cannot fix that: a tab you opened by hand is claimed by nobody
> and looks free by every test. So adoption was removed outright.

`./wb release` also strips the `[agent]` label, so the tab bar stops claiming
someone is driving a tab that is yours again.

---

## Multiple accounts

Open several Chrome profiles in the same window (Chrome's profile switcher), and
Wbrowser can target them individually:

```bash
./wb -a work@example.com go https://mail.example.com
./wb windows                    # list open profiles
```

Or map sites to accounts in `accounts.json`:

```json
{
  "sites": {
    "mail.example.com": { "account": "work@example.com" }
  }
}
```

> 🔴 If you name an account that isn't open, Wbrowser **fails** instead of guessing.
> Sending mail from the wrong account is worse than an error message.

---

## Platform notes

| OS | Chrome auto-detection |
|---|---|
| **Windows** | `Program Files`, `AppData`, Edge fallback |
| **macOS** | `/Applications/Google Chrome.app`, Chromium, Edge |
| **Linux** | `google-chrome`, `chromium`, snap, Edge |
| **WSL** | Windows Chrome first (the browser you actually use) |

Override with `WBROWSER_CHROME=/path/to/chrome` if detection fails.

> **Tested on real hardware** (2026-08-24):
>
> | Platform | Chrome | Verified by | What was measured there |
> |---|---|---|---|
> | macOS 15 | 151 | different machine & operator | launch · engine · CLI · state paths |
> | Linux (native, headless) | 148 | different machine & operator | the above **+ security review** |
> | WSL2 + Windows Chrome | 151 | maintainer (self-verified) | the above |
> | Windows 10 (native) | 151 | different machine & operator | the above **+ end-to-end** |
>
> Not every check ran on every platform. The **security review** (no-token MCP refusal
> confirmed with `ss`, engine unreachable off-loopback) was done on Linux. The
> **end-to-end run** (`/health` → `/act` → real page extraction) was done on Windows.
> UNC paths (`\\wsl.localhost\...`) also work — measured, contrary to our expectation.
>
> The security review was done on Linux, on a different machine: with no token the MCP HTTP server
> exits and **never opens a socket** (verified with `ss`); the engine binds to
> `127.0.0.1` only and is unreachable over the tailnet.

---

## Security

This tool drives a browser that holds **all your logins**. Treat it accordingly.

- 🔴 **`127.0.0.1` is not a fence — it is "any process running as you gets in."**
  The Chrome debugging port (9222) has **no authentication**. Any local process on that
  machine — another app, an npm postinstall hook, a stray script — can attach and drive
  every session you are logged into. Measured: an unrelated process reached
  `GET http://127.0.0.1:9222/json/list` and enumerated the open tabs with no credentials.
  Only run this on a machine where you trust everything that runs as your user.
- The engine binds to **`127.0.0.1` only**. Never expose it directly.
- 🔴 `mcp-server.js --host 0.0.0.0` exists and **will bind to every interface**. The code
  prints a warning, but by then the port is already open. Use `127.0.0.1` unless you are
  on a trusted private network (VPN/tailnet), and always with a token.
- The MCP HTTP server **requires a token** and refuses to start without one.
- `./wb type` does **not** log what was typed — it might be a password.
- Cookie values are **never** printed, logged, or returned by any command.
- **Do not** use this to enter passwords, card numbers, or government IDs.
  Log in by hand; Wbrowser reuses the session.

### Session backup

```bash
./sync-session.sh export   # cookies → encrypted store
./sync-session.sh import   # restore on another machine
./sync-session.sh status
```

> 🔴 **Cookies are as sensitive as passwords** — they *are* the login. The script
> refuses to write unless the destination is actually encrypted, and refuses to
> restore from ciphertext it can't decrypt.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WBROWSER_CHROME` | auto-detect | Chrome executable path |
| `WBROWSER_PROFILE_DIR` | `~/.wbrowser` | Profile directory |
| `WBROWSER_PROFILE` | `Default` | Profile name within it |
| `WBROWSER_CDP_PORT` | `9222` | Chrome debugging port |
| `WBROWSER_PORT` | `7981` | Control engine port |
| `WIN_AGENT` | derived | Name shown in banner and tab title |
| `WIN_TAB` | `main` | Which of that agent's tabs to drive |
| `WBROWSER_MCP_TOKEN` | — | **Required** for remote MCP |
| `WBROWSER_NOTES` | — | Directory for daily work logs (optional) |

---

## After a reboot

One command brings everything back:

```bash
cd /path/to/Wbrowser && ./wb up
```

It starts Chrome and the engine, and leaves either alone if it is already up.
Then `./wb status` tells you whether your logins survived — they live in the
profile on disk, so they normally do.

### Starting the engine automatically

```bash
# Linux / WSL — systemd user service
./install.sh
systemctl --user status wbrowser
```

This covers the **engine** only. The **browser** is a desktop process and stays a
deliberate choice — a tool that silently opens a browser window on login is not a
tool you want. So after a reboot it is still `./wb up`, or launch Chrome yourself
and let the already-running engine attach.

On **macOS and Windows** there is no equivalent installer yet: run `./wb up` when
you need it. (A launchd plist and a Startup-folder shortcut are both small; they
are not written because nobody has measured them on a real machine, and this
README does not claim what has not been run.)

> 🔴 **Do not write your own shortcut that launches Chrome with
> `--remote-debugging-port` on your normal profile.** Since Chrome 136 (March 2025)
> the flag is ignored there — Chrome starts, the port never opens, and nothing says
> why. `launch.js` passes a dedicated `--user-data-dir`, which is the only
> arrangement Chrome still honours. Let `./wb up` do it.

---

## Known limitations

- **No automated test suite.** CI checks syntax and a few invariants; everything that
  touches a real browser was measured by hand across four platforms. That does not
  scale, and it is the most useful thing a contributor could add.

- **No natural-language loop built in.** The agent picks selectors; `read` gives it
  the real ones, so it doesn't have to guess.
- **Chrome/Chromium only.** Firefox has no CDP.
- **One CDP port = one Chrome process.** Profiles opened from within that window are
  visible; a separately-launched Chrome is not.

---

## Using it from an AI assistant

Installing the binary is only half of it — your assistant also has to know the tool
exists, when to reach for it, and what it must never do. `setup.sh` copies a skill
file to `~/.claude/skills/wbrowser/SKILL.md` for that reason.

```bash
# if you installed by hand, or want to refresh it
cp skills/wbrowser/SKILL.md ~/.claude/skills/wbrowser/SKILL.md
```

It tells the agent to check `wb status` first, to read a page for real selectors
instead of guessing them, to show you every field before anything irreversible, and
that it must never type a password or print a cookie value.

🔵 Setup will not overwrite a `SKILL.md` you have edited — it leaves the new version
beside it as `SKILL.md.new` and says so.

🔵 For clients other than Claude, point them at the same file, or run the MCP server
(`npm run mcp`) and let the client discover the tools directly.

---

## Staying up to date

```bash
./wb version          # your version, and whether a newer release exists
```

```
wbrowser 0.4.0
🔵 A newer release is available: v0.5.0 (you have v0.4.0)
```

Updating:

```bash
git pull && npm install                                  # cloned it
git pull https://github.com/w-partners/Wbrowser main     # forked it
```

🔵 A fork does not follow this repo — GitHub never pushes our commits to your copy.
That second command is how you pull them in when you want them.

🔴 If the check can't reach GitHub it says so. It will not tell you that you are up
to date when it simply failed to ask. Skip the network call entirely with
`WBROWSER_NO_UPDATE_CHECK=1`; it never blocks the command either way.

To hear about releases without running anything, use **Watch → Releases only** on
the [repository page](https://github.com/w-partners/Wbrowser).

---

## Contributing & security

- [CHANGELOG.md](CHANGELOG.md) — what changed in each release, and what is still unverified
- [CONTRIBUTING.md](CONTRIBUTING.md) — the rules that shaped this code, and how to test it
- [SECURITY.md](SECURITY.md) — 🔴 the threat model. Read it before running this on a
  shared machine: the Chrome debugging port has **no authentication**, so any local
  process running as you can drive your sessions.

Found a security problem? Please open a
[private advisory](https://github.com/w-partners/Wbrowser/security/advisories/new)
rather than a public issue.

## License

MIT — see [LICENSE](LICENSE).
