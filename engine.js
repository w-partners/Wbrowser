// engine.js — a control engine that attaches over CDP to an already-running Chrome and drives it.
//
//   POST /act       { tab?, account?, agent?, goto?, click?, type?, press?,
//                     wait?, read?, shot?, eval?, console?, errors?, network? }
//   GET  /health    engine / browser status
//   GET  /tabs      open tabs
//   GET  /windows   windows per profile (account)
//   GET  /logins    cookie counts per domain (values are never returned)
//   GET  /session   export cookies   POST /session  restore cookies
//
// 🔴 This does not launch the browser — launch.js must already be running.
// 🔴 Bind to 127.0.0.1 only. This engine drives the browser the user is logged
//    into, so exposing it externally hands over every one of those sessions.
// 🔴 Cookie 'values' are never returned anywhere except /session.

const http = require('http');

// 🔴 Without playwright you only get a stack trace and never the words
//    "run npm install" (measured). preflight.js holds the single test and the single
//    message — see the note there for why this is not inlined.
require('./preflight').requireInstalled();

const { chromium } = require('playwright');
const { appendJournal } = require('./journal');
const vault = require('./vault');
const loginfields = require('./loginfields');
const credaudit = require('./credaudit');
const sitememory = require('./sitememory');
const os = require('os');
const path = require('path');

const PORT = process.env.WBROWSER_PORT || 7981;

// --- credential state (see docs/DESIGN-credential-vault.md) ---
// 🔴 The master passphrase is entered once per engine start; we hold only the passphrase in
//    memory (not the decrypted payload) and decrypt per-use, then drop the plaintext. The AI
//    driving wb never receives any of this — these live only in the engine process.
const CRED_VAULT_FILE = process.env.WBROWSER_CRED_FILE
  || path.join(os.homedir(), '.wbrowser', 'creds.enc');
const CRED_AUDIT_FILE = process.env.WBROWSER_CRED_AUDIT
  || path.join(os.homedir(), '.wbrowser', 'creds-audit.log');
let credPassphrase = null;          // set by /cred/unlock, held for the engine's lifetime
const credSubmitPolicy = new Map(); // origin -> 'always' | 'never' (remembered after first use)

// --- local site memory (which site an agent used for which task; local-only, never to an LLM)
const SITE_MEMORY_FILE = process.env.WBROWSER_MEMORY_FILE
  || path.join(os.homedir(), '.wbrowser', 'memory.json');
// 🔵 Which browser this engine drives, for the tab label. 1 is the Chrome you were
//    already in; 2, 3… are the named ones. A tab then reads `[1-2]` — browser 1,
//    tab 2 — which is how a person refers to it out loud.
const BROWSER_NUM = process.env.WBROWSER_BROWSER_NUM || '1';
// 🔵 A tab's permanent id, monotonic and never reused. A person points at a tab as
//    [browser-id] — [1-3] is always the same tab, even after tab 2 is closed and
//    others open. Order-based numbering could not do that (close one and the rest
//    renumber), which is why "[1-3], look at that one" was ambiguous. The counter is
//    seeded from tabs already open so ids stay unique across an engine restart.
let tabSeq = 0;
function nextTabId() { tabSeq += 1; return tabSeq; }
// 🔵 CDP address. Accepts both WBROWSER_CDP (full URL) and WBROWSER_CDP_PORT (port only).
//    launch.js uses _PORT, and if the engine ignores it then whenever the user changes
//    the port the engine silently attaches to the default 9222 (= someone else's
//    browser). This actually went wrong that way.
const CDP = process.env.WBROWSER_CDP
  || `http://127.0.0.1:${process.env.WBROWSER_CDP_PORT || 9222}`;

// 🔴 connectOverCDP's own `timeout` only covers opening the websocket. Once connected,
//    playwright replays one `executionContextCreated` per stale utility world before it
//    returns — and THAT phase is not bounded by the option. With enough worlds it never
//    returns, and because the engine calls connect() from inside /health, /health then
//    never answers: the port is held, the process is alive, and every probe times out with
//    no cause given (reported 2026-09-05, idifference: `wb up` hung >3min after a reconnect,
//    the log's last line was the reconnect attempt, then silence). A hang that says nothing
//    is worse than a failure that does. So bound the WHOLE call with a wall-clock race that
//    fires even when the built-in timeout does not, and turn the hang into a named error.
//    Tunable, defaulting to the 30s line we tell people to use as "hung, not slow".
const CONNECT_TIMEOUT = Number(process.env.WBROWSER_CONNECT_TIMEOUT || 30000);
async function connectOverCDPBounded() {
  let timer;
  const hardStop = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(
      `connectOverCDP did not return within ${CONNECT_TIMEOUT}ms — its own timeout does not `
      + `cover replaying stale execution contexts, so a large buildup hangs it here. This is `
      + `the "hung, not slow" case: only a Chrome restart clears the buildup (the worlds live `
      + `in Chrome's memory), and it may be the master's window, so get the master's OK first.`)),
      CONNECT_TIMEOUT);
  });
  try {
    // Keep playwright's own (shorter) timeout too — a clean "websocket won't open" still
    // fails fast with its own message; the race only backstops the unbounded replay phase.
    return await Promise.race([chromium.connectOverCDP(CDP, { timeout: 10000 }), hardStop]);
  } finally {
    clearTimeout(timer);
  }
}

let browser = null;
let ctx = null;
const tabs = new Map();          // name -> page

// 🔴 Remember, across requests, that the one-shot reconnect already failed. The flag that
//    guards the reconnect cannot be a function argument: each request calls connect()
//    fresh, so an argument resets every time and the "once" becomes once-per-request.
//    Measured 2026-09-04 (zalman): [reconnect] logged 68 times in one sitting because of
//    exactly that. This engine-lifetime flag makes the reconnect truly one-shot — after it
//    fails, every later request goes straight to the restart-Chrome message until a
//    successful connect clears it.
let reconnectFailed = false;
// 🔴 Also guard against CONCURRENT reconnects. Requests arrive back-to-back, and the
//    failure flag is only set AFTER the reconnect returns — so several requests can pass
//    the gate and each start their own reconnect before any of them fails. Measured
//    2026-09-04 (zalman): [reconnect] fired 6 times where it should have been 1, from
//    exactly this race. Setting a "reconnect in progress" flag at the START closes it: the
//    requests that pile in during the attempt see it and go straight to the wait/message
//    instead of launching their own.
let reconnecting = false;

// The CDP connection can drop (Chrome quits / restarts). Check on every request
// whether it is still alive and reattach if it died — so we never fail silently
// on a dead handle.
async function connect(_reconnecting) {
  if (browser && browser.isConnected()) { reconnectFailed = false; return; }
  try {
    browser = await connectOverCDPBounded();
  } catch (e) {
    // 🔴 A connect timeout here usually is not a dead Chrome. Say what it actually is,
    //    because the raw message sends people to restart a browser that is working fine.
    //
    //    Every unclean engine exit leaves one playwright "utility world" per frame
    //    inside Chrome (see the shutdown handler at the bottom). They accumulate, and
    //    each one replays an executionContextCreated event on the next connect, so
    //    attaching gets slower until it cannot finish. Measured 2026-08-25: 723 stale
    //    worlds, connect impossible, while a raw CDP command still answered in 7ms.
    //
    //    Only restarting Chrome clears them — the worlds live in its memory. Playwright
    //    will not report them, so if we do not name it here nobody can find it: every
    //    other check (HTTP, websocket, /json/list, Chrome's own "Responding") passes.
    // Both the built-in "Timeout N ms exceeded" and our own wall-clock backstop ("did not
    // return within Nms") land here: Chrome may be answering raw CDP while the attach hangs,
    // and the response is the same — one reconnect to tell a half-dead socket from world
    // buildup. The recursive connect(true) below is bounded by the same backstop, so a second
    // hang now fails fast instead of hanging forever (the original bug: reported 2026-09-05).
    if (/Timeout .* exceeded/i.test(e.message || '') || /did not return within/.test(e.message || '')) {
      let reachable = false;
      try {
        const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
        reachable = r.ok;
      } catch { /* leave it false */ }
      if (reachable && !_reconnecting && !reconnectFailed && !reconnecting) {
        // 🔵 Two different faults look identical here — a connectOverCDP timeout while
        //    Chrome answers raw CDP — and they want opposite responses:
        //      • utility-world buildup: only a Chrome restart clears it; reconnecting
        //        just adds another world and fails again.
        //      • a half-dead browser websocket: the socket playwright holds went silently
        //        one-way (proxy recycle / idle timeout — common when the CDP link crosses
        //        a network boundary, e.g. Windows Chrome ↔ WSL2 over Tailscale). Reported
        //        2026-09-04: connectOverCDP timed out for hours while raw CDP stayed instant.
        //        A single fresh connectOverCDP on a NEW socket recovers it.
        //    So try to reconnect exactly ONCE: drop the stale browser and reconnect. If
        //    that succeeds it was half-dead (recovered); if it times out again it is world
        //    buildup, and only then do we tell the caller to restart Chrome. The one retry
        //    costs one extra world, which is the price of telling the two apart.
        // 🔴 Mark "in progress" BEFORE the await, so concurrent requests that arrive while
        //    this reconnect is running see it and do not each launch their own.
        reconnecting = true;
        console.error(`[reconnect] ${new Date().toISOString()} connectOverCDP timed out but raw CDP is up — dropping the browser handle and reconnecting once`);
        try {
          // 🔴 Closing a half-dead browser can hang forever waiting for a CDP reply that
          //    never comes (puppeteer #5331), and worse, playwright may reject the close in
          //    the BACKGROUND after we have moved on — an unhandled rejection that took the
          //    whole engine down mid-request (reported 2026-09-04: empty body, port dead,
          //    only [act-error] restart-Chrome in the log, no rawcdp error → it died before
          //    the fallback). So: attach a catch to the close promise so a late rejection is
          //    swallowed, and do not await it past a short timeout.
          if (browser) {
            const b = browser;
            const closed = b.close().catch(() => {});   // catch handles a late background reject
            await Promise.race([closed, new Promise((r) => { setTimeout(r, 2000); })]);
          }
          browser = null; ctx = null;
          return await connect(true);
        } finally {
          reconnecting = false;   // clear whether the reconnect succeeded or threw
        }
      }
      // 🔴 The reconnect ATTEMPT itself (_reconnecting) must fall through to the block
      //    below so it sets reconnectFailed and throws the restart message — it must NOT be
      //    treated as "a reconnect is in flight, retry". Only OTHER requests that arrived
      //    while a reconnect is running get the transient 503. Without excluding
      //    _reconnecting here, the retry's own failure returned 503 and never set the flag,
      //    so every later request reconnected again (measured: [reconnect] every ~12s).
      if (reachable && reconnecting && !_reconnecting) {
        // A reconnect is in flight (started by another request). Do NOT tell this caller to
        // restart Chrome — the attempt has not resolved yet. Ask them to retry shortly; if
        // the reconnect recovers, the retry sails through, and if it fails, the retry gets
        // the real restart-Chrome message below.
        const err = new Error('reconnecting — a fresh connection is being established; retry in a moment.');
        err.status = 503;
        throw err;
      }
      if (reachable) {
        // 🔴 Reached here only after the reconnect above already failed — so it is not a
        //    half-dead socket (a fresh one would have worked). Remember that, engine-wide,
        //    so the NEXT request does not reconnect again: without this the "once" is
        //    once-per-request and the log fills with [reconnect] (measured: 68 times).
        //    A later successful connect() clears it.
        reconnectFailed = true;
        // 🔴 Restart the ENGINE first, not Chrome. Reported 2026-09-04 (idifference): the
        //    stale state that blocks connectOverCDP can live in the engine's playwright
        //    client, not (only) in Chrome — restarting Chrome left the symptom while
        //    `wb down && wb up` cleared it. The old message said "restart Chrome" first,
        //    which is the heavy, tab-killing move (it closes a window that may be the
        //    master's or another agent's) — and when both Chrome and the engine are alive
        //    with just a stale link, `wb up` is a no-op that changes nothing. So: engine
        //    restart first (light, touches nobody else's tabs); Chrome restart only if that
        //    fails, and only with the master's OK.
        // 🔴 And do not retry the request — every reconnect attempt leaves another utility
        //    world behind. Measured 2026-08-25: 723 -> 911 in twenty minutes from diagnosing.
        throw new Error(
          'Do not retry. First restart the ENGINE — "wb down && wb up" — which is light and '
          + 'does not touch anyone else\'s tabs; the stale state is often in the engine\'s '
          + 'playwright connection, not Chrome. If that does not clear it, restart Chrome '
          + '(heavier — it closes open windows, which may be the master\'s or another '
          + 'agent\'s, so get the master\'s OK first): utility contexts from earlier '
          + 'connections can build up inside Chrome and only a Chrome restart clears those. '
          + `(original: ${e.message.split('\n')[0]})`,
        );
      }
    }
    throw e;
  }
  ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP has no context — Chrome is in a bad state.');
  tabs.clear();
  browser.on('disconnected', () => { browser = null; ctx = null; tabs.clear(); });
}

// 🔴 If the user has several profiles open, the same CDP shows windows for
//    multiple accounts at once. Grabbing "the first tab" means working under the
//    wrong account — which leads to real incidents like sending mail from the
//    wrong account. So we pick the account explicitly.
//
//    When attached over CDP, playwright gives a separate BrowserContext per
//    profile. contexts()[i] maps 1:1 to a profile, so we identify the account by
//    its context.
let ctxAccounts = new Map();      // BrowserContext -> account string (only once determined)

// 🔵 Console / network records. Kept per page in a ring buffer.
//    Records survive navigation (needed to see what broke things).
const RING = 300;                 // max entries kept per page
const pageLogs = new WeakMap();   // Page -> { console: [], errors: [], requests: [] }

function logsOf(page) {
  if (!pageLogs.has(page)) pageLogs.set(page, { console: [], errors: [], requests: [] });
  return pageLogs.get(page);
}

function push(arr, item) {
  arr.push(item);
  if (arr.length > RING) arr.shift();
}

// Attach listeners to a page only once. Attaching twice duplicates every log entry.
const wired = new WeakSet();
function wireLogging(page) {
  if (wired.has(page)) return;
  wired.add(page);
  const L = logsOf(page);

  page.on('console', (msg) => {
    push(L.console, {
      type: msg.type(),                    // log / warn / error / info …
      text: msg.text().slice(0, 2000),
      url: (msg.location() || {}).url || '',
      line: (msg.location() || {}).lineNumber,
      at: new Date().toISOString(),
    });
  });
  // Uncaught exceptions — the ones console.error never catches land here
  page.on('pageerror', (err) => {
    push(L.errors, {
      message: String(err && err.message ? err.message : err).slice(0, 2000),
      stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 5).join('\n'),
      at: new Date().toISOString(),
    });
  });
  // Failed requests — 404 / CORS / network errors
  page.on('requestfailed', (req) => {
    push(L.requests, {
      url: req.url().slice(0, 300),
      method: req.method(),
      failure: (req.failure() || {}).errorText || '',
      at: new Date().toISOString(),
    });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      push(L.requests, {
        url: res.url().slice(0, 300),
        method: res.request().method(),
        status: res.status(),
        at: new Date().toISOString(),
      });
    }
  });
}

async function accountOf(context) {
  if (ctxAccounts.has(context)) return ctxAccounts.get(context);
  // Open chrome://version in that context and read the profile path.
  // Do it once and cache it — doing it on every request is slow.
  let acc = null;
  let probe = null;
  try {
    // 🔵 If a chrome://version tab is already open, reuse it. Opening a new one
    //    every time piles up tabs.
    const reuse = context.pages().find((p) => !p.isClosed() && p.url().startsWith('chrome://version'));
    probe = reuse || await context.newPage();
    if (!reuse) {
      await probe.goto('chrome://version', { waitUntil: 'domcontentloaded', timeout: 8000 });
    }
    const text = await probe.evaluate(() => document.body.innerText);
    // 🔵 Match only the 'Profile Path' row. The Command Line row contains the same
    //    path, so matching too broadly drags in the whole flag list (measured 2026-08-23).
    //    (The Korean alternative in the regex below matches Chrome's Korean UI — do not remove it.)
    // 🔵 Paths contain spaces ("Profile 1", "User Data"). Cutting at whitespace
    //    truncates to 'Profile' and reports the wrong account (measured 2026-08-23).
    //    Capture to end of line and only trim trailing whitespace.
    const m = text.match(/(?:프로필 경로|Profile Path)\s*[:\s]\s*([A-Za-z]:\\[^\r\n]+)/);
    acc = m ? m[1].trim() : null;
  } catch { /* if unreadable leave it null — we do not guess */ } finally {
    // Close only the tab we opened. Never close a tab the user opened.
    if (probe && !probe.isClosed() && probe.url().startsWith('chrome://version')) {
      try { await probe.close(); } catch { /* noop */ }
    }
  }
  ctxAccounts.set(context, acc);
  return acc;
}

// Pick a context by account hint (part of an email / a profile name).
// strict=true throws when nothing matches (the user named the account explicitly).
// strict=false falls back to the default window (the account was inferred from the mapping).
async function pickContext(hint, strict) {
  const all = browser.contexts();
  if (!hint) return ctx || all[0];
  const wanted = String(hint).toLowerCase();
  for (const c of all) {
    const path = (await accountOf(c)) || '';
    if (path.toLowerCase().includes(wanted)) return c;
    // Also allow matching by profile folder name (Profile 3, Default)
    const prof = path.split('\\').pop() || '';
    if (prof.toLowerCase() === wanted) return c;
  }
  if (strict) {
    // 🔴 If the user named an account and that window is not open, fail —
    //    stopping is better than working under the wrong account.
    throw new Error(`No window is open for the '${hint}' account. `
      + `Open that profile in Chrome and try again (check with ./wb windows).`);
  }
  return ctx || all[0];
}

// Title of a page, capped. 🔴 `page.title()` waits for a ready document, so one tab that is
//    mid-navigation would otherwise stall the whole tab listing. A missing title is fine.
async function titleOf(page) {
  try {
    return await Promise.race([
      page.title(),
      new Promise((res) => { setTimeout(() => res(''), 800); }),
    ]);
  } catch { return ''; }
}

async function getTab(name, accountHint, strict, agent) {
  await connect();
  const tabName = name || 'main';
  // 🔵 Partition tabs per agent — if I overwrite a tab another agent was using,
  //    the two pieces of work tangle (agents run in parallel).
  //
  // 🔴 The account is deliberately NOT part of the key. It used to be, and that was a bug:
  //    `act()` only resolves an account when the command carries a URL, so `goto` produced
  //    the key `a::work@x::main` while the very next `read` produced `a::::main`. Same tab,
  //    two keys — the second lookup missed, opened a fresh page, and the caller found
  //    about:blank where its page had been. Measured 2026-08-24.
  const key = `${agent || ''}::${tabName}`;
  const existing = tabs.get(key);
  if (existing && !existing.isClosed()) {
    // 🔴 Open is not the same as alive. `isClosed()` only catches tabs that went away;
    //    a tab can stay in the list and answer nothing at all. Measured 2026-08-31:
    //    navigating to a large text/plain file left the tab with an empty URL and a
    //    renderer that never replied — every later command, including `eval 1+1`,
    //    timed out with no explanation, and raw CDP hung on that tab too. The engine
    //    was healthy and said so; it was holding a dead tab.
    //    So knock before reusing. One cheap round trip beats an unexplained hang.
    const alive = await Promise.race([
      existing.evaluate(() => true).catch(() => false),
      new Promise((res) => { setTimeout(() => res(false), 1500); }),
    ]);
    if (alive) return existing;
    tabs.delete(key);
    try { await existing.close({ runBeforeUnload: false }); } catch { /* already gone */ }
  }

  const targetCtx = await pickContext(accountHint, strict);

  // 🔴 The map above is memory only, so an engine restart forgets every tab it was driving —
  //    while those tabs are still sitting open in Chrome. Without this the agent opens a
  //    fresh tab and abandons the one holding its work. Measured 2026-08-24: after a restart
  //    a tab named 'research' was left on a GitHub page and a blank one took its place.
  //
  //    So before opening anything, ask the pages themselves. stampTitle wrote the agent and
  //    tab name into each page it drove, and that survives the engine dying.
  for (const p of targetCtx.pages()) {
    if (p.isClosed()) continue;
    try {
      // 🔴 Cap every probe. `evaluate` waits for the page to be ready, and a tab that is
      //    mid-navigation or hung never answers — one such tab in the window and the whole
      //    scan blocks forever. Measured 2026-08-24: the request never returned at all.
      //    A probe that misses is fine (we just open a new tab); a probe that hangs is not.
      const owner = await Promise.race([
        p.evaluate(() => ({
          agent: window.__wbrowserAgent, tab: window.__wbrowserTab, mark: window.__wbrowserMark,
        })),
        new Promise((res) => { setTimeout(() => res(null), 800); }),
      ]);
      // 🔵 Restore the tab's permanent id from the page itself, so an engine restart
      //    does not renumber it. The mark reads "1-3"; the id is the part after the dash.
      if (owner && owner.mark && !tabIds.has(p)) {
        const prev = parseInt(String(owner.mark).split('-')[1], 10);
        if (Number.isInteger(prev)) {
          tabIds.set(p, prev);
          if (prev > tabSeq) tabSeq = prev;      // never hand out an id already in use
        }
      }
      if (owner && owner.agent === (agent || '') && owner.tab === tabName) {
        tabs.set(key, p);
        wireLogging(p);
        return p;
      }
    } catch { /* chrome:// and cross-origin pages cannot be asked — skip them */ }
  }
  // 🔴 Every tab an agent drives is a tab the agent opened. Including 'main'.
  //
  //    'main' used to inherit whatever page was already open, on the reasoning that the
  //    agent should land on a logged-in screen instead of a blank one. That reasoning was
  //    wrong, and the bug it caused is the one this whole design exists to prevent:
  //    the page it inherited was usually the one the human was reading. The agent then
  //    clicked and typed into the human's tab and relabelled its title.
  //
  //    Measured 2026-08-24: the human was reading Naver's newsstand; an agent issued a
  //    plain `read` with no tab name and got that page back, retitled [agentMain].
  //
  //    Inheriting cannot be made safe by checking which pages are "taken", because a tab
  //    the human opened by hand is claimed by nobody — it looks free by every test we can
  //    run. So we stop guessing: an agent gets its own page and never adopts one.
  //
  // 🔴 Before opening another, clear out tabs agents left behind. Without this they pile
  //    up — a session that keeps naming new tabs (or reopens after one dies) can reach
  //    30-40 open tabs in a short sitting, which wastes memory and, via the per-tab
  //    utility world, slows every later connect. Requested by the master 2026-09-04
  //    ("it keeps opening tabs").
  await reapAgentTabs(targetCtx);
  // 🔵 The session is shared, so a new tab is already logged in — that was the real point
  //    of inheriting, and opening a tab keeps it. What is lost is only that the agent
  //    starts on about:blank instead of a page, which every caller follows with a goto.
  const page = await targetCtx.newPage();
  tabs.set(key, page);
  wireLogging(page);       // start recording console / errors / failed requests from here on
  return page;
}

// Close tabs that agents opened and no longer need. Two rules, both conservative:
//   1. an agent tab that has gone to about:blank is dead — close it (this is exactly the
//      abandoned-tab state a failed operation leaves behind).
//   2. if more than MAX_AGENT_TABS agent tabs are still alive, close the oldest first
//      (by permanent id — the lowest id is the oldest) until we are back under the cap.
// 🔴 A tab is "an agent's" ONLY if it carries the __wbrowserMark stamp. A tab the human
//    opened, or a login tab, carries no mark and is never counted and never closed.
const MAX_AGENT_TABS = 8;
async function reapAgentTabs(ctx) {
  const marked = [];
  for (const p of ctx.pages()) {
    if (p.isClosed()) continue;
    let info = null;
    try {
      info = await Promise.race([
        p.evaluate(() => ({ mark: window.__wbrowserMark, url: location.href })),
        new Promise((res) => { setTimeout(() => res(null), 600); }),
      ]);
    } catch { /* chrome:// / cross-origin — cannot ask, so treat as not-ours */ }
    if (!info || !info.mark) continue;           // 🔴 no mark → not an agent tab → leave it
    marked.push({ page: p, id: tabIds.get(p) || 0, blank: (info.url || '') === 'about:blank' });
  }
  // rule 1: dead (about:blank) agent tabs
  for (const t of marked.filter((t) => t.blank)) {
    try { await t.page.close({ runBeforeUnload: false }); } catch { /* already gone */ }
  }
  // rule 2: cap the survivors, oldest id first
  const alive = marked.filter((t) => !t.blank).sort((a, b) => a.id - b.id);
  const over = alive.length - MAX_AGENT_TABS;
  for (let i = 0; i < over; i += 1) {
    try { await alive[i].page.close({ runBeforeUnload: false }); } catch { /* already gone */ }
  }
}

// Summarize the page structure — so we drive by selector, not by coordinates.
// Coordinate-based driving silently clicks the wrong place when the window size
// or scroll position changes.
async function summarize(page) {
  return page.evaluate(() => {
    const txt = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const links = [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 20)
      .map((a) => ({ text: txt(a.innerText), href: a.href })).filter((x) => x.text);
    const buttons = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
      .filter(vis).slice(0, 15)
      .map((b) => txt(b.innerText || b.value)).filter(Boolean);
    // 🔴 contenteditable counts as an input. Rich composers — X, Slack, Notion, most
    //    comment boxes — are divs, so a list of input/textarea/select shows the page as
    //    having nowhere to type. Measured 2026-08-25: X's composer never appeared here,
    //    and the agent went hunting for a selector that `read` should have handed it.
    //
    //    🔴 And report what each field currently holds. Without it there is no way to
    //    check that typing landed except to evaluate against the element yourself — and
    //    picking the wrong element is exactly the mistake this is meant to prevent.
    const editable = [...document.querySelectorAll('[contenteditable=""], [contenteditable=true]')]
      // 🔵 Skip the aria-hidden duplicate: rich editors mount a second, inert copy of the
      //    field with the same attributes. It is empty, it is *not* what the user sees,
      //    and reading it reports an empty box while the real one holds text.
      .filter((n) => !n.closest('[aria-hidden=true]'));
    const inputs = [...document.querySelectorAll('input, textarea, select'), ...editable]
      .filter(vis).slice(0, 15)
      .map((i) => {
        const isEditable = i.isContentEditable;
        const val = isEditable ? (i.innerText || '') : (i.value || '');
        return {
          tag: isEditable ? 'editable' : i.tagName.toLowerCase(),
          type: i.type || '', name: i.name || '',
          id: i.id || '',
          placeholder: i.placeholder || i.getAttribute('aria-label')
            || i.getAttribute('data-testid') || '',
          value: val.length > 80 ? `${val.slice(0, 80)}…` : val,
          length: val.length,
        };
      })
      .filter((x) => x.name || x.id || x.placeholder || x.tag === 'editable');
    // 🔴 Never return document.cookie (session-hijacking vector).
    return {
      title: document.title,
      url: location.href,
      h1: txt((document.querySelector('h1') || {}).innerText),
      // 🔴 Do not use txt() here — that helper truncates at 60 chars (it is for labels).
      //    Clean up the body text separately. Otherwise text is always 60 chars
      //    (measured 2026-08-23).
      text: (document.body ? document.body.innerText : '')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000),
      links,
      buttons,
      inputs,
    };
  });
}

// accounts.json — site↔account mapping. Read on every request (the file is small,
// and edits by the user must take effect without a restart).
function accountForUrl(url) {
  if (!url) return null;
  try {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(`${__dirname}/accounts.json`, 'utf8'));
    const host = new URL(url).hostname.replace(/^www\./, '');
    const sites = cfg.sites || {};
    // Exact match first, then walk up the parent domains (for a.b.com also check b.com)
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts.slice(i).join('.');
      if (sites[key]) return sites[key].account || sites[key];
    }
    return cfg.defaultAccount || null;
  } catch {
    return null;   // A broken config must not stop operation. Use the default window.
  }
}

// 🔵 Show on screen that the browser is under control — a translucent border band
//    plus the agent name. It must be immediately visible on screen that we are driving.
//
//    Design principles:
//    · pointer-events:none — if the band intercepted clicks the user could not click there
//    · top z-index + position:fixed — shows up regardless of the site's layout
//    · self-expiring — it must disappear when work ends, or "currently controlled" means nothing
//    · reattaches after navigation (it is called on every act)
const BANNER_TTL_MS = 6000;
const titleScripted = new WeakSet();

// 🔵 Stamp the agent name into the tab label and **keep it there**.
//
//    Problem: the stamp disappears on navigation, because the site overwrites
//    document.title with its own value. SPAs especially refresh the title on every
//    route change, so stamping once does not survive.
//
//    Solution: watch <title> with a MutationObserver and re-apply the prefix the
//    moment it goes missing.
//    · Registering via addInitScript applies it automatically to **every subsequent
//      navigation** as well.
//    · Re-entrancy guard: the observer fires even while we are writing, so a flag blocks it.
// 🔵 The coordinate for a tab: "<browser>-<id>", e.g. "1-3". The id is the permanent
//    per-tab counter (tabIds), NOT the tab's current position — position renumbers
//    when a tab closes, which is exactly what made "[1-3]" ambiguous. A tab keeps its
//    id from when it was opened until it is closed, and the number is never reused.
const tabIds = new WeakMap();     // Page -> its permanent id
function idOf(page) {
  if (!tabIds.has(page)) tabIds.set(page, nextTabId());
  return tabIds.get(page);
}
function coordOf(page) {
  try { return `${BROWSER_NUM}-${idOf(page)}`; }
  catch { return `${BROWSER_NUM}-?`; }
}

async function stampTitle(page, agent, tabName, coord) {
  const install = ({ tag, tab, mark }) => {
    const KEY = '__wbrowserTitleGuard';
    window.__wbrowserAgent = tag;
    // 🔵 The tab key lives in the page, not only in the engine's memory. The engine's map
    //    is lost when it restarts; this is not, so the tab can be adopted back afterwards.
    window.__wbrowserTab = tab;
    window.__wbrowserMark = mark;              // e.g. "1-2": browser 1, tab 2
    const apply = () => {
      if (window[KEY]) return;                 // we are writing right now — prevent recursion
      // 🔵 `[1-2] agent` — browser number, tab number, then who is driving. The
      //    coordinate is how a person points at one tab among several browsers; the
      //    agent name is who to blame if it moves. Both, because they answer different
      //    questions.
      const want = `[${window.__wbrowserMark}] ${window.__wbrowserAgent} `;
      const cur = document.title || '';
      if (cur.startsWith(want)) return;
      window[KEY] = true;
      try {
        document.title = want + cur.replace(/^\[[^\]]*\]\s*\S*\s*/, '').replace(/^\[[^\]]*\]\s*/, '');
      } finally {
        window[KEY] = false;
      }
    };
    apply();
    if (window.__wbrowserTitleObs) return;      // already observing
    const head = document.head || document.documentElement;
    if (!head) return;
    window.__wbrowserTitleObs = new MutationObserver(apply);
    window.__wbrowserTitleObs.observe(head, {
      subtree: true, childList: true, characterData: true,
    });
  };

  const arg = { tag: agent, tab: tabName, mark: coord || `${BROWSER_NUM}-?` };
  try {
    // Apply immediately to the current page
    await page.evaluate(install, arg);
  } catch { /* blocked on chrome:// and similar pages */ }

  try {
    // Also apply to every document opened from now on (register once per tab)
    if (!titleScripted.has(page)) {
      titleScripted.add(page);
      await page.addInitScript(install, arg);
    }
  } catch { /* even if registration fails, the immediate apply above still holds */ }
}

async function showBanner(page, agent) {
  try {
    await page.evaluate(({ tag, ttl }) => {
      const ID = '__wbrowser_ctrl_banner';
      let el = document.getElementById(ID);
      if (!el) {
        el = document.createElement('div');
        el.id = ID;
        document.documentElement.appendChild(el);
      }
      // Derive the color from the agent name — several agents attached at once stay distinguishable.
      let h = 0;
      for (let i = 0; i < tag.length; i += 1) h = (h * 31 + tag.charCodeAt(i)) % 360;

      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'pointer-events:none',                       // 🔴 must not intercept clicks
        `border:6px solid hsla(${h},85%,55%,0.55)`,
        'box-sizing:border-box',
        `box-shadow:inset 0 0 22px hsla(${h},85%,55%,0.28)`,
        'transition:opacity .25s',
      ].join(';');

      // Name badge (top-left)
      let lab = el.firstElementChild;
      if (!lab) { lab = document.createElement('div'); el.appendChild(lab); }
      lab.textContent = `🤖 ${tag} in control`;
      lab.style.cssText = [
        'position:absolute', 'top:0', 'left:14px',
        `background:hsla(${h},85%,45%,0.88)`, 'color:#fff',
        'font:600 12px/1 system-ui,"Malgun Gothic",sans-serif',
        'padding:5px 11px', 'border-radius:0 0 7px 7px',
        'letter-spacing:.2px', 'white-space:nowrap',
      ].join(';');

      // Disappears on its own once work stops. The next act refreshes the timer.
      if (window.__wbrowserBannerTimer) clearTimeout(window.__wbrowserBannerTimer);
      el.style.opacity = '1';
      window.__wbrowserBannerTimer = setTimeout(() => {
        const n = document.getElementById(ID);
        if (!n) return;
        n.style.opacity = '0';
        setTimeout(() => { const m = document.getElementById(ID); if (m) m.remove(); }, 300);
      }, ttl);
    }, { tag: agent, ttl: BANNER_TTL_MS });
  } catch {
    // Scripts are blocked on chrome:// pages and the like. A failed banner must not block the work.
  }
}

// 🔴 Say "nothing matches that selector" instead of letting the first real action
//    time out. Both click and type start with scrollIntoViewIfNeeded, so a selector
//    that matches nothing surfaces as `locator.scrollIntoViewIfNeeded: Timeout
//    10000ms exceeded` — which reads as a slow page, not a typo, and sends whoever
//    is debugging to look at load times.
//    Measured 2026-08-28 against a headless run: `input[name=q]` on DuckDuckGo,
//    whose search box is a *textarea*. `textarea[name=q]` and `[name=q]` both work.
//    The old message named neither the selector nor the fact that it found nothing.
// 🔵 Cheap on purpose — count() resolves immediately when there is no match, so this
//    adds a millisecond to the working path and turns a 10s dead end into an answer.
async function requireMatch(page, selector, verb) {
  let n = 0;
  try {
    n = await page.locator(selector).count();
  } catch (e) {
    // An unparseable selector is its own kind of typo — say so rather than
    // re-throwing playwright's internal wording.
    throw new Error(`${verb}: "${selector}" is not a valid selector — ${e.message.split('\n')[0]}`);
  }
  if (n === 0) {
    throw new Error(
      `${verb}: nothing on this page matches "${selector}". `
      + 'Run read first — it lists the actual selectors, and the element you want may be '
      + 'a different tag than you assumed (a search box is often a textarea, not an input).');
  }
}

// 🔴 Every key this command understands. A key that is not here is a mistake, and the
//    only safe thing to do with a mistake is say so. Reported 2026-08-31: someone read
//    the docs, sent {"action":"read"}, and got back 200 with `done: []`. Nothing ran,
//    nothing complained, and it took three attempts to work out why the page never
//    changed. A typo that returns success is worse than one that returns an error.
const KNOWN_KEYS = new Set([
  'goto', 'click', 'type', 'press', 'read', 'shot', 'eval', 'wait',
  'console', 'errors', 'network', 'tab', 'account', 'agent', 'selector',
  'newtab', 'newwindow', 'fullPage', 'limit', 'filter',
]);

// 🔴 What is actually running here. Reported 2026-08-31: a fix was released, pulled,
//    and still did not work — an engine started before the pull was holding the port,
//    so old code answered every request. It took someone comparing process start times
//    by hand to see it, because nothing the tool printed said which build was live.
//    `/health` now says. "Fixed but not working" should be one request to answer.
const STARTED_AT = new Date().toISOString();
const BUILD = (() => {
  try {
    // eslint-disable-next-line global-require
    const { version } = require('./package.json');
    let commit = null;
    try {
      commit = require('child_process')
        .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { /* not a git checkout — the version alone still helps */ }
    return commit ? `${version} (${commit})` : version;
  } catch { return 'unknown'; }
})();

// The raw-CDP fallback lane (see the note where it is invoked in act()). Opens a fresh
// websocket to the page target for this tab, runs the command, and closes it. Deliberately
// minimal — it exists so a half-dead playwright connection does not force a Chrome restart
// mid-task. Anything it cannot do (a zero-size click target, newtab) fails loudly.
// eslint-disable-next-line global-require
const { RawCDP } = require('./rawcdp');
async function actViaRawCDP(cmd, tab) {
  const result = { tab, agent: cmd.agent, via: 'rawcdp' };
  const done = [];
  const raw = new RawCDP(CDP);
  try {
    // Match the page by the tab stamp the engine wrote into its title ("[b-id] agent ...").
    await raw.attach(cmd.agent ? `${cmd.agent}` : null);
    if (cmd.goto) { const u = await raw.goto(cmd.goto); done.push(`goto ${cmd.goto}`); result.url = u; }
    if (cmd.click) { await raw.click(cmd.click); done.push(`click ${cmd.click}`); }
    if (cmd.press) { await raw.press(cmd.press); done.push(`press ${cmd.press}`); }
    if (cmd.eval) { result.result = await raw.evaluate(cmd.eval); done.push('eval'); }
    if (cmd.read || cmd.goto || cmd.click) {
      // A minimal read: title/url/text and a few links/buttons — not the full summarize
      // (that walks the DOM via playwright helpers). Enough to see where you are.
      result.page = await raw.evaluate(`(function(){
        var txt=(document.body?document.body.innerText:'').slice(0,4000);
        var links=[].slice.call(document.querySelectorAll('a[href]')).slice(0,20)
          .map(function(a){return {text:(a.innerText||'').trim().slice(0,60),href:a.href}}).filter(function(x){return x.text});
        var buttons=[].slice.call(document.querySelectorAll('button,[role=button],input[type=submit]')).slice(0,15)
          .map(function(b){return (b.innerText||b.value||'').trim().slice(0,40)}).filter(Boolean);
        return {url:location.href,title:document.title,text:txt,links:links,buttons:buttons};
      })()`);
    }
    if (cmd.shot) { result.screenshot_b64 = await raw.screenshot(!!cmd.fullPage); done.push('shot'); }
    result.done = done;
    // 🔵 Tell the caller they are on the fallback lane, so a person knows why some things
    //    (rich click, newtab) are limited and that a Chrome restart returns the full engine.
    result.note = 'playwright connection is down; served over raw CDP. Restart Chrome to restore full features.';
    return result;
  } finally {
    raw.close();
  }
}

async function act(cmd) {
  const unknown = Object.keys(cmd || {}).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) {
    const err = new Error(
      `unknown ${unknown.length > 1 ? 'keys' : 'key'}: ${unknown.map((k) => `"${k}"`).join(', ')}. `
      + 'Verbs go in as keys, not as a value — {"read":true}, not {"action":"read"}. '
      + `Known keys: ${[...KNOWN_KEYS].join(', ')}.`);
    err.status = 400;
    throw err;
  }
  const tab = cmd.tab || 'main';
  // 🔴 Emergency lane. If playwright's connectOverCDP has gone half-dead (reconnectFailed,
  //    set by connect() after its one reconnect could not recover), do NOT call getTab —
  //    it would call connect() and hang again. Instead drive the page over a fresh raw-CDP
  //    websocket, which stays responsive when playwright's does not (measured 2026-09-04,
  //    zalman). This is the thin fallback: goto/eval/shot/press/read map 1:1; click is
  //    best-effort by coordinate. A newtab/newwindow needs playwright, so those still error.
  if (reconnectFailed && !cmd.newtab && !cmd.newwindow) {
    return actViaRawCDP(cmd, tab);
  }
  // If account is given explicitly use it, otherwise look the URL up in the mapping.
  const explicit = !!cmd.account;
  const acct = cmd.account || (cmd.goto ? accountForUrl(cmd.goto) : null);
  // 🔴 Do NOT call getTab when newtab/newwindow is set — those open their own page, and
  //    getTab would open ANOTHER one first (for an unknown tab name it creates a page),
  //    leaving an orphan about:blank behind on every call. Measured 2026-09-04: {newtab,
  //    goto} added TWO tabs per call, one of them a mark-less blank the reaper could not
  //    see, which is how a session reached 30+ open tabs. Let the block below make the page.
  let page = (cmd.newtab || cmd.newwindow) ? null : await getTab(tab, acct, explicit, cmd.agent);
  const done = [];

  if (cmd.newtab) {
    const c = await pickContext(acct, explicit);
    // 🔴 Reap before opening — newtab bypasses getTab, so without this it is the main way
    //    tabs pile up (every {newtab:true} adds one, none are ever removed). The page we
    //    are about to create has no mark yet, so the reaper cannot touch it.
    await reapAgentTabs(c);
    page = await c.newPage();
    // Same key shape as getTab — see the note there on why the account is not part of it.
    tabs.set(`${cmd.agent || ''}::${tab}`, page);
    done.push('newtab');
  }
  if (cmd.newwindow) {
    // Like newtab, but the tab opens in its own OS window — same Chrome, same CDP, so
    // control is unchanged; only the layout differs, letting one agent watch two tabs
    // side by side. newPage() always makes a tab in the current window; only CDP's
    // Target.createTarget({newWindow:true}) splits it off. We wait on the context's
    // 'page' event to adopt the playwright Page it produces, so the rest of the tab
    // machinery is unchanged.
    const c = await pickContext(acct, explicit);
    const anchor = c.pages().find((p) => !p.isClosed()) || await c.newPage();
    const cdp = await c.newCDPSession(anchor);
    const appeared = c.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    await cdp.detach().catch(() => {});
    const opened = await appeared;
    if (!opened) throw new Error('newwindow: opened a window but could not attach to it');
    page = opened;
    tabs.set(`${cmd.agent || ''}::${tab}`, page);
    done.push('newwindow');
  }
  if (cmd.goto) {
    // 🔴 A goto timeout does not mean the page failed to load. Heavy SPAs keep requests
    //    in flight long past the point where the page is usable, and Playwright rejects
    //    on the clock even though the document is there and interactive.
    //    Measured 2026-08-25: x.com/compose/post timed out at 30s every time, while
    //    navigating via location.href and waiting landed on a complete, working page —
    //    so the command reported failure for something that had actually worked.
    //    Rejecting here also threw away the rest of the command (click, type, read).
    //
    //    So: on timeout, ask the page where it actually is. If it reached the target
    //    origin and the document is parsed, carry on and say the wait was cut short.
    //    Any other failure — DNS, refused, cert — still throws, because those really
    //    did fail and pretending otherwise would be the silent success we avoid.
    try {
      const resp = await page.goto(cmd.goto, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 🔵 Surface the HTTP status. Suggested 2026-09-04 (idifference): a goto to a page
      //    that 404s still "succeeds" — the tab loads the server's 404 body — and the caller
      //    has no way to see it without opening the console. We do NOT throw on a 4xx/5xx
      //    (visiting an error page on purpose is legitimate), but we report it so "a 200
      //    pretending to be a 404" is visible. `null` means a same-document navigation with
      //    no response object, which is normal.
      if (resp) { const s = resp.status(); if (s >= 400) result.httpStatus = s; }
      // 🔴 goto can RESOLVE (no error, no timeout) and still leave the tab on about:blank —
      //    playwright reports the navigation as done while the page never actually left.
      //    Reported 2026-09-04: `goto http://<ip>:3100/ko/home` returned success every time
      //    but `location.href` stayed about:blank, and it took 20 minutes to find because
      //    nothing failed. A goto that lands nowhere is the silent success this tool must
      //    not produce — so check where we actually are and throw if it is not the target.
      const where = await page.evaluate(() => location.href).catch(() => '');
      const arrived = where && where !== 'about:blank' && (() => {
        try { return new URL(where).origin === new URL(cmd.goto).origin; } catch { return false; }
      })();
      if (!arrived) {
        const err = new Error(
          `goto reported success but the tab is at ${where || 'an unknown url'}, not ${cmd.goto}. `
          + 'The navigation resolved without leaving the page (seen with http / IP-literal / '
          + 'non-standard-port targets). This is not a silent success — the page did not load.');
        err.status = 502;
        throw err;
      }
      done.push(`goto ${cmd.goto}`);
    } catch (e) {
      if (!/Timeout .* exceeded/i.test(e.message || '')) throw e;
      // 🔴 Ask whether the page WORKS, not what phase it says it is in. `readyState`
      //    is about bytes still arriving, not about whether you can use what arrived:
      //    measured 2026-08-31 on a response that streams its body and stops — the
      //    document reads `loading` forever, and a button appended to it still gets
      //    created, clicked and fires its handler. Gating on `readyState !== 'loading'`
      //    rejected pages that were fully operable.
      //    The 3s race matters for the opposite case: when nothing at all came back,
      //    `evaluate` never resolves, `landed` stays null, and we rethrow — correctly.
      const landed = await Promise.race([
        page.evaluate(() => ({
          href: location.href,
          ready: document.readyState,
          usable: !!(document.body && document.body.childElementCount > 0),
        })),
        new Promise((res) => { setTimeout(() => res(null), 3000); }),
      ]).catch(() => null);
      const sameOrigin = landed && (() => {
        try { return new URL(landed.href).origin === new URL(cmd.goto).origin; } catch { return false; }
      })();
      if (sameOrigin && landed.usable) {
        done.push(`goto ${cmd.goto} (still loading after 30s; page is usable)`);
      } else {
        throw e;
      }
    }
  }
  if (cmd.click) {
    // 🔴 Say what was actually clicked, not what was asked for. A selector that matches
    //    the wrong element still "succeeds", and the caller carries on believing the
    //    cursor is somewhere it is not. Measured 2026-08-25: someone aimed at a composer,
    //    hit the search box, and typed a character into the middle of a URL — the log
    //    said `click <selector>` either way.
    const el = page.locator(cmd.click).first();
    await requireMatch(page, cmd.click, 'click');
    // 🔵 Bring it into view first. A person scrolls to what they are clicking; playwright
    //    will too, but only within its own timeout — doing it as a separate step means a
    //    long page does not eat the click budget and fail on something perfectly usable.
    // 🔴 But do NOT let scrolling fail the whole click. Some elements never satisfy
    //    scrollIntoViewIfNeeded — a fixed/sticky node, a zero-size hit target, a first
    //    match that is an off-screen skip-link — and it then burns its full timeout and
    //    throws, turning a clickable element into a 500. Measured 2026-09-04: click 'a'
    //    on toonkit hit an off-screen link and threw `scrollIntoViewIfNeeded: Timeout
    //    9989ms`. click() does its own scrolling, so a shorter, non-fatal pre-scroll is
    //    a nicety, not a gate — swallow its failure and let click() try.
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await el.click({ timeout: 10000 });
    let what = cmd.click;
    try {
      const d = await Promise.race([
        el.evaluate((n) => {
          const label = n.getAttribute('aria-label') || n.getAttribute('data-testid')
            || n.getAttribute('placeholder') || n.getAttribute('name') || '';
          const text = (n.innerText || n.value || '').trim().slice(0, 40);
          return `${n.tagName.toLowerCase()}${label ? ` [${label}]` : ''}${text ? ` "${text}"` : ''}`;
        }),
        new Promise((res) => { setTimeout(() => res(null), 2000); }),
      ]);
      if (d) what = `${cmd.click} -> ${d}`;
    } catch { /* describing it is a nicety; the click already happened */ }
    done.push(`click ${what}`);
  }
  if (cmd.type) {
    // 🔴 Type like a person by default: focus the field, then send real keystrokes.
    //
    //    This used to be page.fill, which sets the value in one shot — something no
    //    human does, in a tool whose whole point is driving a browser the way a person
    //    would. It breaks on any site that re-renders while you type. Measured
    //    2026-08-25 on X's composer: the same 92-character string arrived complete
    //    without a link, and truncated to 55 with one, losing everything before the URL
    //    as the site rebuilt the field around a link preview. The command reported
    //    success both times.
    //
    //    🔵 fill is still available as {"fast": true} for large text in stable fields,
    //    where keystroke-by-keystroke is slow and nothing is listening. It is opt-in on
    //    purpose: a fast default that quietly drops text is worse than a slow one.
    const { selector, text, fast, delay } = cmd.type;
    await requireMatch(page, selector, 'type');
    if (fast) {
      await page.fill(selector, text, { timeout: 10000 });
    } else {
      const field = page.locator(selector).first();
      // 🔴 Scroll it into view and focus it — do not click. A field below the fold is
      //    perfectly typeable but not clickable, and click() then times out on something
      //    that was never broken. Measured 2026-08-25: an input at y=972 in an 805px
      //    viewport failed this way.
      await field.scrollIntoViewIfNeeded({ timeout: 10000 });
      await field.focus({ timeout: 10000 });
      // 🔵 Clear what is there first — fill's one useful habit, which typing lacks.
      //    Skip it for contenteditable, where selectAll+delete is the working idiom.
      try {
        await field.fill('', { timeout: 3000 });
      } catch { /* contenteditable and friends refuse fill; carry on and append */ }
      await field.pressSequentially(text, { delay: Number(delay) || 25, timeout: 30000 });
    }
    // 🔵 Never log what was typed — it may be a password.
    done.push(`type -> ${selector}${fast ? ' (fast)' : ''}`);
  }
  if (cmd.press) {
    // 🔴 Accept Control+a as well as Control+A. Playwright wants the exact key name, so
    //    a lowercase letter in a chord silently presses something else — measured
    //    2026-08-25: `Control+a` did not select all, and the Backspace after it deleted
    //    a single character instead of the field.
    const keys = String(cmd.press).split('+');
    const norm = keys.map((k, i) => (i === keys.length - 1 && k.length === 1 ? k.toUpperCase() : k)).join('+');
    await page.keyboard.press(norm);
    done.push(`press ${norm}`);
  }

  // 🔵 Make it visible who is in control.
  //    ① tab title    — tells them apart in the tab bar
  //    ② border band  — shows on screen right away who is touching this window
  //
  // 🔴 Do not narrow this condition to goto/click/newtab. Work done only through
  //    eval/type/press would get no indicator — a tab that submitted 20 entries
  //    actually ended up with no indicator at all.
  if (cmd.agent) {
    // 🔴 Cap these. They are cosmetic — a title and a banner — and neither is worth
    //    hanging the command. A tab that dies between the liveness check above and
    //    this line leaves them waiting forever, which is how a `goto` to a large
    //    text/plain file used to swallow every command that followed it.
    //    Losing the label on a dying tab is fine. Losing the command is not.
    await Promise.race([
      (async () => { await stampTitle(page, cmd.agent, tab, coordOf(page)); await showBanner(page, cmd.agent); })(),
      new Promise((res) => { setTimeout(res, 5000); }),
    ]).catch(() => {});
  }
  if (cmd.wait) { await page.waitForTimeout(Math.min(cmd.wait, 15000)); done.push(`wait ${cmd.wait}ms`); }

  // Run JS — equivalent to typing straight into the console.
  // 🔴 This runs arbitrary code in the page context, which is another reason this
  //    engine must stay bound to 127.0.0.1 only.
  let evalResult;
  let evalError;
  if (cmd.eval) {
    try {
      const out = await page.evaluate((src) => {
        // eslint-disable-next-line no-new-func
        const v = (0, eval)(src);
        // Non-serializable values such as DOM nodes fall back to a string
        try { JSON.stringify(v); return v; } catch { return String(v); }
      }, cmd.eval);
      evalResult = out;
      done.push('eval');
    } catch (e) {
      evalError = e.message.split('\n')[0];
      done.push('eval(failed)');
    }
  }

  // 🔴 Always return which account window this ran in. Without it you can work under
  //    the wrong account and never know — that is where incidents like mail sent from
  //    the wrong account start.
  let usedProfile = null;
  try {
    const p = await accountOf(page.context());
    usedProfile = p ? (p.split('\\').pop() || p) : null;
  } catch { /* keep going even if it cannot be read */ }

  // 🔴 Say whose tab this was, not just which name it had. Tabs are keyed by
  //    (agent, tab), so two callers using the default `main` are on two different
  //    pages — and the reply said `tab: "main"` to both. Reported 2026-08-31: someone
  //    compared `curl {"read":true}` against `wb read`, got different pages, and spent
  //    the afternoon hunting a client-side parser bug. There was no bug. `wb` attaches
  //    an agent name and the bare curl does not, so they were reading different tabs
  //    and nothing in either answer said so.
  const result = { tab, agent: cmd.agent || null, account: usedProfile, done };
  if (evalResult !== undefined) result.result = evalResult;
  if (evalError) result.evalError = evalError;

  // Query console / errors / failed requests. Can be narrowed with filter (a regex).
  if (cmd.console || cmd.errors || cmd.network) {
    const L = logsOf(page);
    const rx = cmd.filter ? new RegExp(cmd.filter, 'i') : null;
    const take = (arr, n) => (rx ? arr.filter((x) => rx.test(JSON.stringify(x))) : arr)
      .slice(-(n || 50));
    if (cmd.console) result.console = take(L.console, cmd.limit);
    if (cmd.errors) result.errors = take(L.errors, cmd.limit);
    if (cmd.network) result.network = take(L.requests, cmd.limit);
  }
  // 🔴 Read first, and never let one part take the others down with it. Reported
  //    2026-08-31: `{read:true, shot:true}` on a heavy feed returned
  //    `{"error":"page.screenshot: Timeout"}` and nothing else — the page summary was
  //    already gathered and got thrown away with the exception. A collector reading
  //    three platforms got zero characters from all of them, and the reply blamed the
  //    screenshot, which is not what the caller wanted.
  //    Partial results beat none: say what failed, keep what worked.
  if (cmd.read || cmd.goto || cmd.click || cmd.press || cmd.newtab) {
    // 🔴 Cap it. `summarize` walks the DOM, and on an infinite-scroll feed the DOM
    //    keeps growing while it walks — x.com/home never returned, not even at 180s.
    //    goto has a 30s guard; this had none, so the guard on one step was undone by
    //    the next.
    const TIMED_OUT = Symbol('read-timeout');
    const summary = await Promise.race([
      summarize(page).catch((e) => ({ _failed: e.message.split('\n')[0] })),
      new Promise((res) => { setTimeout(() => res(TIMED_OUT), 30000); }),
    ]);
    if (summary === TIMED_OUT) {
      // 🔴 Do not blame the page. `summarize` not returning in 30s has two very different
      //    causes and the message must not assert one it did not observe. Reported
      //    2026-09-04: read timed out on a small, static page (measured 1ms of actual
      //    DOM work), and the old wording — "the page kept changing" — sent the reporter
      //    hunting for an infinite re-render in their own code that was not there.
      //    The other cause is playwright's execution-context path being stalled by
      //    accumulated utility worlds, which we can detect WITHOUT adding one: if the raw
      //    CDP endpoint answers instantly while page.evaluate hangs, Chrome is fine and
      //    the fault is the connection. Restarting Chrome is the only thing that clears it.
      let cdpFast = false;
      try {
        const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
        cdpFast = r.ok;
      } catch { /* leave false */ }
      result.readError = cdpFast
        ? 'read: timed out after 30s. Chrome answers raw CDP instantly, so the page is '
          + 'fine — playwright cannot reach its execution context. First restart the ENGINE '
          + '("wb down && wb up") — the stale state is often in the engine\'s connection, and '
          + 'this touches nobody else\'s tabs. If that does not clear it, restart Chrome (get '
          + 'the master\'s OK — it closes open windows): utility worlds from earlier '
          + 'connections can build up inside Chrome. Do not retry, each attempt adds more. '
          + '(Not an endless feed.)'
        : 'read: timed out after 30s — the page may still be changing as it is read (an '
          + 'endless feed does this), or the read did not return. The page was not '
          + 'confirmed to be changing; this is what timed out, not what was observed.';
    } else if (summary && summary._failed) {
      result.readError = summary._failed;
    } else {
      result.page = summary;
    }
  }
  if (cmd.shot) {
    try {
      const buf = await Promise.race([
        page.screenshot({ fullPage: !!cmd.fullPage, timeout: 20000 }),
        new Promise((_, rej) => { setTimeout(() => rej(new Error('screenshot: timed out after 20s')), 21000); }),
      ]);
      result.screenshot_b64 = buf.toString('base64');
    } catch (e) {
      // The screenshot is evidence, not the answer. Losing it must not lose the rest.
      result.shotError = e.message.split('\n')[0];
    }
  }

  // Work journal (optional). Only recorded when WBROWSER_NOTES is set.
  // 🔴 Report journal failures in the response too — never allow a state where
  //    nothing gets recorded silently.
  const j = appendJournal(cmd, result, { agent: cmd.agent });
  if (!j.ok) result.journalError = j.why;
  else if (j.file) result.journal = j.file;

  return result;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (req.method === 'GET' && req.url === '/health') {
      // 🔵 /health asks "is the engine alive". The browser not being up yet is not an
      //    engine error but a normal state — answer 200 and report it via browser:false.
      //    🔴 Returning 500 makes systemd / monitoring restart a perfectly healthy engine
      //    over and over (measured: 500 + ECONNREFUSED when no CDP).
      try {
        await connect();
        const v = ctx.pages();
        return res.end(JSON.stringify({
          ok: true, browser: true, cdp: CDP, openTabs: v.length,
          build: BUILD, startedAt: STARTED_AT,
        }, null, 2));
      } catch (e) {
        // 🔴 Do not always say "the browser is not running". When Chrome is answering
        //    but we still cannot attach, that sentence sends people to start a browser
        //    that is already up, and the real cause goes unnamed. connect() distinguishes
        //    the two; carry its wording through instead of overwriting it.
        //    Measured 2026-08-25: the generic hint was on screen dozens of times while
        //    the actual problem was stale playwright contexts, and it never pointed there.
        const stale = /stale playwright contexts/i.test(e.message || '');
        return res.end(JSON.stringify({
          ok: true,               // the engine is alive
          browser: false,         // we could not attach
          cdp: CDP,
          build: BUILD, startedAt: STARTED_AT,
          hint: stale
            ? 'Do not retry — close Chrome fully and run "wb up". Chrome answers but '
              + 'cannot be attached to, and each further attempt makes it worse.'
            : 'The browser is not running — start it with node launch.js.',
          detail: e.message.split('\n')[0],
        }, null, 2));
      }
    }
    // 🔴 Session backup / restore. This is the only path where cookie 'values' travel.
    //    This endpoint is another reason the 127.0.0.1 binding is mandatory.
    if (req.method === 'GET' && req.url === '/session') {
      await connect();
      const c = ctx || browser.contexts()[0];
      const cookies = await c.cookies();
      return res.end(JSON.stringify({
        savedAt: new Date().toISOString(),
        profile: (await accountOf(c) || '').split('\\').pop() || null,
        cookies,
      }, null, 2));
    }
    if (req.method === 'POST' && req.url === '/session') {
      await connect();
      const c = ctx || browser.contexts()[0];
      const body = JSON.parse((await readBody(req)) || '{}');
      const cookies = body.cookies || [];
      if (!Array.isArray(cookies) || !cookies.length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'cookies are empty' }));
      }
      // Do not add expired cookies — the browser would discard them anyway.
      const nowSec = Date.now() / 1000;
      const fresh = cookies.filter((k) => !k.expires || k.expires < 0 || k.expires > nowSec);
      await c.addCookies(fresh);
      return res.end(JSON.stringify({
        ok: true, added: fresh.length, skippedExpired: cookies.length - fresh.length,
      }, null, 2));
    }
    // --- credential vault endpoints (docs/DESIGN-credential-vault.md) ---
    // 🔴 These requests carry secrets in their bodies. They are NEVER journaled and NEVER
    //    echo a secret back. The AI driving wb does not call these — the wb CLI does, reading
    //    the user's own keystrokes. The engine binds to 127.0.0.1 only (mandatory here).
    if (req.method === 'POST' && req.url === '/cred/unlock') {
      // Hold the master passphrase for the engine's lifetime. Verify it by attempting a
      // decrypt of the existing vault (if any) so a wrong passphrase is caught now, not later.
      const body = JSON.parse((await readBody(req)) || '{}');
      const pass = body.passphrase;
      if (typeof pass !== 'string' || !pass) {
        res.statusCode = 400; return res.end(JSON.stringify({ error: 'passphrase required' }));
      }
      try {
        vault.loadPayload(CRED_VAULT_FILE, pass);   // throws on wrong passphrase / tamper
      } catch (e) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'could not unlock the vault with that passphrase' }));
      }
      credPassphrase = pass;
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && req.url === '/cred/enroll') {
      // Store a credential. Body: { origin, username, password, submitPolicy? }. Never logged.
      if (!credPassphrase) {
        res.statusCode = 409; return res.end(JSON.stringify({ error: 'vault is locked — unlock first' }));
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { origin, username, password } = body;
      if (!origin || typeof password !== 'string' || !password) {
        res.statusCode = 400; return res.end(JSON.stringify({ error: 'origin and password are required' }));
      }
      const payload = vault.loadPayload(CRED_VAULT_FILE, credPassphrase);
      payload.sites[origin] = {
        username: username || '',
        password,
        submitPolicy: body.submitPolicy || 'confirm',   // confirm on first use per site
      };
      vault.savePayload(CRED_VAULT_FILE, payload, credPassphrase);
      credaudit.append(CRED_AUDIT_FILE, {
        ts: new Date().toISOString(), action: 'enroll', origin, user: username,
      });
      // 🔴 Echo nothing back but success — no username, no policy, certainly no password.
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && req.url === '/cred/login') {
      // Autologin. Body: { origin, agent, tab?, confirmSubmit? }. Fills fields over CDP; the
      // secret goes value->field and never back to the caller.
      if (!credPassphrase) {
        res.statusCode = 409; return res.end(JSON.stringify({ error: 'vault is locked — unlock first' }));
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { origin, agent } = body;
      if (!origin) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'origin required' })); }
      const payload = vault.loadPayload(CRED_VAULT_FILE, credPassphrase);
      const entry = payload.sites[origin];
      if (!entry) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `no credential stored for ${origin} — enroll it first` }));
      }
      const page = await getTab(body.tab || 'main', null, false, agent);
      // Gather visible field descriptors (identity only — never values) and choose the fields.
      const candidates = await page.evaluate(() => {
        const out = []; let n = 0;
        const push = (el, tag) => {
          const r = el.getBoundingClientRect();
          const visible = !!(r.width && r.height) && el.offsetParent !== null && !el.disabled;
          out.push({
            ref: 'f' + (n++), tag, type: (el.type || '').toLowerCase(),
            name: (el.name || '').toLowerCase(), id: (el.id || '').toLowerCase(),
            autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
            placeholder: (el.placeholder || '').toLowerCase(),
            ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
            text: (el.innerText || el.value || '').slice(0, 40),
            visible,
          });
          el.setAttribute('data-wb-ref', out[out.length - 1].ref);
        };
        document.querySelectorAll('input').forEach((el) => push(el, 'input'));
        document.querySelectorAll('button,[role=button],input[type=submit]').forEach((el) => push(el, 'button'));
        return out;
      });
      let picked;
      try {
        picked = loginfields.choose(candidates);
      } catch (e) {
        credaudit.append(CRED_AUDIT_FILE, {
          ts: new Date().toISOString(), action: 'refused', origin, note: e.message,
        });
        res.statusCode = 422;
        return res.end(JSON.stringify({ error: e.message }));
      }
      // Type the values straight into the fields by their marker. The secret never leaves here.
      const typeInto = async (ref, value) => {
        if (!ref) return;
        const sel = `[data-wb-ref="${ref}"]`;
        await page.fill(sel, value);
      };
      if (picked.username && entry.username) await typeInto(picked.username, entry.username);
      await typeInto(picked.password, entry.password);
      credaudit.append(CRED_AUDIT_FILE, {
        ts: new Date().toISOString(), action: 'autologin', origin,
        user: entry.username, field: 'password',
      });
      // Submit gating: confirm on first use per site, then remember.
      const remembered = credSubmitPolicy.get(origin);
      const shouldSubmit = remembered === 'always'
        || (remembered === undefined && body.confirmSubmit === true);
      if (body.confirmSubmit === true && remembered === undefined) {
        credSubmitPolicy.set(origin, 'always');   // the user approved — remember it
      }
      let submitted = false;
      if (shouldSubmit && picked.submit) {
        await page.click(`[data-wb-ref="${picked.submit}"]`).catch(() => {});
        submitted = true;
        credaudit.append(CRED_AUDIT_FILE, {
          ts: new Date().toISOString(), action: 'submit', origin,
        });
      }
      return res.end(JSON.stringify({
        ok: true, filled: true, submitted,
        needsConfirm: !shouldSubmit && !!picked.submit,
      }));
    }
    // --- local site memory (which site for which task). Local file only; never sent to an LLM.
    if (req.method === 'POST' && req.url === '/memory/remember') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { tag, origin } = body;
      if (!tag || !origin) {
        res.statusCode = 400; return res.end(JSON.stringify({ error: 'tag and origin are required' }));
      }
      const mem = sitememory.remember(sitememory.load(SITE_MEMORY_FILE),
        { tag, origin, ts: new Date().toISOString() });
      sitememory.save(SITE_MEMORY_FILE, mem);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && req.url === '/memory/recall') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.tag) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'tag required' })); }
      const hits = sitememory.recall(sitememory.load(SITE_MEMORY_FILE), body.tag);
      // 🔵 Empty is a valid, honest answer — the caller then asks or guesses, never gets a
      //    wrong site silently.
      return res.end(JSON.stringify({ ok: true, tag: body.tag, sites: hits }));
    }
    if (req.method === 'GET' && req.url === '/logins') {
      // What we are logged into. 🔴 Never return cookie 'values' — that is a
      // session-hijacking vector. Only count domain names and quantities.
      await connect();
      const out = [];
      for (const c of browser.contexts()) {
        const path = await accountOf(c);
        const cookies = await c.cookies();
        const roots = new Map();
        for (const ck of cookies) {
          const h = (ck.domain || '').replace(/^\./, '');
          const parts = h.split('.');
          const two = ['co', 'com', 'or', 'ne', 'go', 'ac'].includes(parts[parts.length - 2])
            ? parts.slice(-3) : parts.slice(-2);
          const root = two.join('.');
          if (root) roots.set(root, (roots.get(root) || 0) + 1);
        }
        out.push({
          profile: path ? (path.split('\\').pop() || path) : null,
          totalCookies: cookies.length,
          domains: [...roots.entries()].sort((a, b) => b[1] - a[1])
            .map(([d, n]) => ({ domain: d, count: n })),
        });
      }
      return res.end(JSON.stringify({ contexts: out }, null, 2));
    }
    if (req.method === 'GET' && req.url === '/windows') {
      // Show open windows per account. When the user adds a profile it shows up here.
      await connect();
      const out = [];
      for (const c of browser.contexts()) {
        const path = await accountOf(c);
        const prof = path ? (path.split('\\').pop() || '') : null;
        out.push({
          profilePath: path,
          profile: prof,
          isAgentOnly: !!(path && path.includes('.wbrowser')),
          tabs: c.pages().filter((p) => !p.isClosed())
            .map((p) => ({ url: p.url(), title: undefined })),
        });
      }
      return res.end(JSON.stringify({ windows: out }, null, 2));
    }
    if (req.method === 'GET' && req.url === '/tabs') {
      await connect();
      // 🔵 Number the tabs. The number is what you hand to /take — it is how a person
      //    points at the screen they were on and says "carry on from here".
      const pages = ctx.pages().filter((p) => !p.isClosed());
      const driven = new Map();
      for (const [k, p] of tabs.entries()) if (!p.isClosed()) driven.set(p, k);
      const list = await Promise.all(pages.map(async (p, i) => ({
        n: i + 1,                          // position, for /take (which counts from the list)
        id: idOf(p),                       // 🔵 the permanent id — this is what [1-<id>] shows
        url: p.url(),
        title: await titleOf(p),
        drivenBy: driven.get(p) || null,   // null = nobody is driving it, i.e. it is yours
      })));
      const named = [...tabs.entries()].filter(([, p]) => !p.isClosed())
        .map(([name, p]) => ({ name, url: p.url() }));
      return res.end(JSON.stringify({ open: list, named }, null, 2));
    }
    if (req.method === 'POST' && req.url === '/take') {
      // Hand a tab you are on over to an agent, by its number from /tabs.
      //
      // 🔴 Only ever takes the tab that was named. Agents must not adopt a page on their
      //    own — see the note in getTab. This endpoint is the one exception, and it exists
      //    because the person asked for it explicitly.
      const body = JSON.parse((await readBody(req)) || '{}');
      await connect();
      const pages = ctx.pages().filter((p) => !p.isClosed());
      const idx = Number(body.n);
      if (!Number.isInteger(idx) || idx < 1 || idx > pages.length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({
          error: `No tab ${body.n}. Run ./wb tabs — there are ${pages.length}.`,
        }, null, 2));
      }
      const page = pages[idx - 1];
      const agent = body.agent || '';
      const tabName = body.tab || 'main';
      tabs.set(`${agent}::${tabName}`, page);
      wireLogging(page);
      await stampTitle(page, agent, tabName, coordOf(page));
      return res.end(JSON.stringify({
        taken: { n: idx, url: page.url(), title: await titleOf(page) },
        as: { agent, tab: tabName },
      }, null, 2));
    }
    if (req.method === 'POST' && req.url === '/release') {
      // Give the tab back. The agent stops driving it; the tab itself is left alone.
      const body = JSON.parse((await readBody(req)) || '{}');
      const key = `${body.agent || ''}::${body.tab || 'main'}`;
      const page = tabs.get(key);
      if (!page) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `Nothing held as '${key}'.` }, null, 2));
      }
      tabs.delete(key);
      // 🔵 Drop the label too, so the tab bar stops claiming an agent is on it.
      try {
        await page.evaluate(() => {
          if (window.__wbrowserTitleObs) { window.__wbrowserTitleObs.disconnect(); }
          delete window.__wbrowserTitleObs;
          delete window.__wbrowserAgent;
          delete window.__wbrowserTab;
          document.title = (document.title || '').replace(/^\[[^\]]*\]\s*/, '');
        });
      } catch { /* the page may be gone or unreachable — the handle is released either way */ }
      return res.end(JSON.stringify({ released: key, url: page.isClosed() ? null : page.url() }, null, 2));
    }
    if (req.method === 'POST' && req.url === '/act') {
      const cmd = JSON.parse((await readBody(req)) || '{}');
      return res.end(JSON.stringify(await act(cmd), null, 2));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    // 🔵 400 and 500 tell the caller different things: one means "fix your request",
    //    the other means "something here broke". Sending 500 for both makes a typo
    //    look like an outage, and the caller goes looking at the engine.
    const status = e.status || 500;
    // 🔴 Leave a trace in the log for anything that is not a plain bad-request (400).
    //    Reported 2026-09-04: a tab stopped answering CDP entirely — every act on it
    //    timed out — and the engine log did not gain a single line, so there was no
    //    trail to follow. A failure that returns 500 to the caller but writes nothing is
    //    the silent failure this project keeps guarding against. Timeouts especially:
    //    they are the signature of a tab or connection that has died, and they must be
    //    findable after the fact. 400s are the caller's typo and would only be noise.
    // 🔵 503 is the transient "reconnecting, retry shortly" state — a normal moment, not a
    //    failure, so it does not get a log line (it would only be noise).
    if (status >= 500 && status !== 503) {
      const line = e.message.split('\n')[0];
      const url = (req.url || '').split('?')[0];
      console.error(`[act-error] ${new Date().toISOString()} ${status} ${url}: ${line}`);
    }
    res.statusCode = status;
    res.end(JSON.stringify({ error: e.message.split('\n')[0] }, null, 2));
  }
});

// 🔴 Bind to 127.0.0.1 only. This engine drives the browser the user is logged into,
//    so leaving it open hands over every one of those sessions.
//    If external exposure is needed, put gate.js (PIN) in front of it.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`WBROWSER_ENGINE_UP http://127.0.0.1:${PORT}  → cdp ${CDP}`);
});

// 🔴 Let go of the browser on the way out.
//
//    Playwright creates an isolated "utility world" per frame when it attaches over CDP.
//    🔴 Chrome keeps those for the life of the browser: measured 2026-08-25, close()
//    does NOT remove them, so every fresh connectOverCDP leaves one per open tab behind
//    however it ends. They cost nothing sitting there, but the *next* connect receives
//    one executionContextCreated event for each — connect time grows with every
//    reconnect until it exceeds the timeout and the browser is effectively unusable.
//
//    🔵 So this handler is not the cure it first looks like. Normal operation attaches
//    once and reuses it (verified: running wb commands leaves the count flat), so the
//    cost lands on engine *restarts* — and closing cleanly does not reduce it. What this
//    does buy: Chrome stops treating us as an attached client the moment we exit, rather
//    than holding that state until it notices the socket died.
//
//    Measured 2026-08-25: after a handful of kill -9 during development, 723 stale
//    worlds had accumulated and connectOverCDP could not finish inside 25s. Chrome
//    itself was fine — a raw CDP command answered in 7ms — which is what makes this
//    so hard to diagnose from the symptom: every layer looks healthy except the one
//    doing the counting.
//
//    Only Chrome exiting clears them, so the fix has to be here: close the connection
//    on the way out. See also the stale-world check in connect().
let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  try {
    if (browser && browser.isConnected()) await browser.close();
  } catch { /* going away regardless — never block exit on cleanup */ }
  process.exit(sig === 'SIGINT' ? 130 : 0);
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { shutdown(sig); });
}
// 🔵 beforeExit covers a normal end-of-work exit; 'exit' itself is too late to await.
process.on('beforeExit', () => { shutdown('beforeExit'); });

// 🔴 Never let a stray rejection or exception take the whole engine down. Reported
//    2026-09-04: a few requests into the raw-CDP fallback the engine crashed — the caller
//    got an empty body (not even a 500), and the port went dead. A half-closed websocket
//    firing 'error' after its awaiters were gone is the likely path. The engine drives the
//    browser a whole session depends on; one bad request must fail that request, not the
//    process. Log it (so it is findable) and stay up.
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? reason.message.split('\n')[0] : String(reason);
  console.error(`[unhandledRejection] ${new Date().toISOString()} ${msg}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[uncaughtException] ${new Date().toISOString()} ${(err && err.message || err)}`);
});
