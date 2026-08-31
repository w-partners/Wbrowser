# Changelog

Notable changes per release. Dates are the release date; the repository history
has the detail.

---

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
