#!/usr/bin/env node
// launch.js — starts Chrome with a remote debugging (CDP) port.
//
// Supports: Windows · macOS · Linux · WSL (driving the Windows Chrome)
//
// 🔴 Chrome 136+ **ignores remote debugging for the default profile directory.**
//    (2025-03 security change: countermeasure against cookie theft via remote debugging)
//    So a non-standard --user-data-dir is mandatory. There is no way to attach to the
//    default profile.
//
// Environment variables
//   WBROWSER_CHROME       path to the Chrome executable (set when auto-detection fails)
//   WBROWSER_PROFILE_DIR  profile folder (default: <home>/.wbrowser)
//   WBROWSER_PROFILE      profile name (default: Default)
//   WBROWSER_CDP_PORT     CDP port (default: 9222)

// 🔴 Refuse before doing anything if this checkout was never installed. Neither of
//    these files needs playwright itself, which is exactly the trap: they ran fine on a
//    clone with no node_modules and looked healthy. `cron.js list` printed the job list
//    as though the schedule were live, and `launch.js` reported ALREADY_UP after
//    attaching to a Chrome that belonged to somebody else. Measured 2026-08-31.
require('./preflight').requireInstalled();

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CDP_PORT = process.env.WBROWSER_CDP_PORT || 9222;
const PROFILE = process.env.WBROWSER_PROFILE || 'Default';

// ---------------------------------------------------------------- platform

// Is this WSL? — /proc/version contains "microsoft".
function isWSL() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch { return false; }
}

const WSL = isWSL();

// Candidate Chrome paths. Use the first one that exists.
function chromeCandidates() {
  const w = (p) => (WSL ? `/mnt/c${p.replace(/^C:/, '').replace(/\\/g, '/')}` : p);
  switch (process.platform) {
    case 'win32':
      return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ];
    default: {
      // Linux — under WSL prefer the Windows Chrome (the browser the user actually uses).
      const winFirst = WSL ? [
        w('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
        w('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'),
      ] : [];
      return [
        ...winFirst,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
      ];
    }
  }
}

function findChrome() {
  // 🔴 Verify the path the user gave us too. Trusting it blindly makes spawn fail
  //    silently, burning 20 seconds on "no CDP response" and ending with no cause
  //    (measured rc=124). Catch a non-existent path here and say right away what is wrong.
  if (process.env.WBROWSER_CHROME) {
    const p = process.env.WBROWSER_CHROME;
    if (!fs.existsSync(p)) {
      console.error(`❌ The file WBROWSER_CHROME points to does not exist: ${p}`);
      process.exit(1);
    }
    return p;
  }
  for (const c of chromeCandidates()) {
    try { if (fs.existsSync(c)) return c; } catch { /* next candidate */ }
  }
  return null;   // 🔴 null when not found. Do not paper over it with an arbitrary path.
}

const CHROME = findChrome();
// When using the Windows Chrome from WSL, Chrome must be given a Windows path.
const CHROME_IS_WINDOWS = process.platform === 'win32'
  || (WSL && !!CHROME && CHROME.startsWith('/mnt/'));

// ---------------------------------------------------------------- profile path

// Convert to a path to hand to the Windows Chrome (/mnt/c/... → C:\...)
function toWindowsPath(p) {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

// Find the Windows home directory from WSL. Some environments do not have cmd.exe
// on PATH, so filesystem probing goes first (measured).
function windowsHomeFromWSL() {
  const SKIP = new Set(['public', 'default', 'default user', 'all users']);
  const drive = CHROME && CHROME.startsWith('/mnt/') ? CHROME.slice(0, 6) : '/mnt/c';
  const usersDir = `${drive}/Users`;
  try {
    if (fs.existsSync(usersDir)) {
      const cands = fs.readdirSync(usersDir)
        .filter((n) => !SKIP.has(n.toLowerCase()))
        .filter((n) => { try { return fs.statSync(`${usersDir}/${n}`).isDirectory(); } catch { return false; } });
      // A user who already has a profile created is the strongest clue
      const used = cands.filter((n) => fs.existsSync(`${usersDir}/${n}/.wbrowser`));
      if (used.length === 1) return `${usersDir}/${used[0]}`;
      const real = cands.filter((n) => fs.existsSync(`${usersDir}/${n}/NTUSER.DAT`));
      if (real.length === 1) return `${usersDir}/${real[0]}`;
      if (cands.length === 1) return `${usersDir}/${cands[0]}`;
      if (cands.length > 1) return { ambiguous: cands, dir: usersDir };
    }
  } catch { /* fall through */ }
  try {
    const out = execFileSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && !out.includes('%')) {
      return `/mnt/${out[0].toLowerCase()}/${out.slice(3).replace(/\\/g, '/')}`;
    }
  } catch { /* fall through */ }
  return null;
}

// 🔴 Runtime state must not default to living inside the repo — a user who runs
//    `git add -A` would commit it. Use the OS state directory instead.
//    (XDG_STATE_HOME on Linux, LOCALAPPDATA on Windows, ~/Library on macOS)
function stateDir() {
  if (process.env.WBROWSER_STATE_DIR) return process.env.WBROWSER_STATE_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'wbrowser');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'wbrowser');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
                   'wbrowser');
}

let ambiguity = null;

function profileDir() {
  if (process.env.WBROWSER_PROFILE_DIR) return process.env.WBROWSER_PROFILE_DIR;
  if (WSL && CHROME_IS_WINDOWS) {
    const h = windowsHomeFromWSL();
    if (h && h.ambiguous) { ambiguity = h; return null; }
    return h ? `${h}/.wbrowser` : null;
  }
  return path.join(os.homedir(), '.wbrowser');
}

const PROFILE_DIR = profileDir();

// ---------------------------------------------------------------- waiting for CDP

// Is the RUNNING Chrome missing the autoplay flag? Returns true only when we positively
// measured that audio is blocked; a probe that cannot run returns false (say nothing rather
// than cry wolf).
// 🔵 Measures the capability instead of parsing a command line — that is what the flag is
//    for, and it works the same whoever started the browser. The full version of this lives
//    in scripts/check-autoplay.js; this is the cheap inline check for the launch path.
async function autoplayGap() {
  try {
    const ver = await cdpVersion(2500);
    if (!ver || !ver.webSocketDebuggerUrl) return false;
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const opened = await new Promise((res) => {
      ws.addEventListener('open', () => res(true), { once: true });
      ws.addEventListener('error', () => res(false), { once: true });
      setTimeout(() => res(false), 4000);
    });
    if (!opened) { try { ws.close(); } catch { /* already gone */ } return false; }
    let id = 0;
    const call = (method, params, sessionId) => new Promise((res) => {
      const myId = ++id;
      const msg = { id: myId, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const on = (ev) => {
        const x = JSON.parse(ev.data);
        if (x.id === myId) { ws.removeEventListener('message', on); res(x.result || null); }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify(msg));
      setTimeout(() => { ws.removeEventListener('message', on); res(null); }, 12000);
    });
    // 🔴 A fresh tab. An existing one may already hold a user gesture and would report
    //    "fine" on a Chrome that blocks every new page — the false pass this must avoid.
    const t = await call('Target.createTarget', { url: 'about:blank' });
    if (!t || !t.targetId) { ws.close(); return false; }
    const a = await call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    let blocked = false;
    if (a && a.sessionId) {
      await call('Runtime.enable', {}, a.sessionId);
      const r = await call('Runtime.evaluate', {
        expression: `(async () => {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          const ctx = new AC();
          try {
            await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 3000))]);
            const s = ctx.state; ctx.close();
            return s !== 'running';
          } catch { try { ctx.close(); } catch { /* gone */ } return null; }
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, a.sessionId);
      if (r && r.result && r.result.value === true) blocked = true;
    }
    await call('Target.closeTarget', { targetId: t.targetId });
    ws.close();
    return blocked;
  } catch { return false; }
}

// 🔴 Chrome does not bring the old tabs back, and the person who had to restart it is the
//    one who loses them. Reported 2026-10-02: a restart to apply a flag left 1 of 2 tabs, and
//    the other survived only because someone had written the URL down first.
// 🔵 Print, do not reopen: a tab closed on purpose before the restart should stay closed, and
//    only a person knows which those were. One line each, ready to paste.
// 🔵 Called on BOTH paths — after a fresh launch and on ALREADY_UP. Staying silent about a
//    tab that never came back is the same silence this exists to end.
// Take the open-tab list while Chrome is up. Safe to call often; the module throttles
// nothing, so callers pick their moments (launch, and the engine's /health).
// 🔵 In launch.js this runs on every invocation — the cheap moment when we KNOW Chrome is
//    answering, which is also the moment just before someone restarts it.
async function snapshotTabs() {
  try {
    await require('./tabsave').save({
      cdpBase: `http://127.0.0.1:${CDP_PORT}`,
      stateDir: stateDir(),
      cdpPort: CDP_PORT,
    });
  } catch { /* a convenience; never let it fail a launch */ }
}

async function reportMissingTabs() {
  try {
    const tabsave = require('./tabsave');
    const saved = tabsave.load({ stateDir: stateDir(), cdpPort: CDP_PORT });
    // 🔴 No record is not the same as nothing missing, and printing neither makes them
    //    identical. Reported 2026-10-02: on a machine with no snapshot file, "0 tabs lost"
    //    and "I have no idea what you had open" were both silence — on the machine that had
    //    just lost tabs. Say which one it is.
    if (!saved.length) {
      console.log('🔵 No tab record yet, so nothing can be compared after a restart.');
      console.log('   One is written each time this runs while Chrome is up — from now on.');
      return;
    }
    const openNow = await new Promise((res) => {
      const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/list', timeout: 4000 },
        (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res([]); } }); });
      req.on('error', () => res([]));
      req.on('timeout', () => { req.destroy(); res([]); });
    });
    const gone = tabsave.missing(saved, openNow);
    if (!gone.length) return;
    console.log('');
    console.log(`🔵 ${gone.length} tab(s) open before the last shutdown are not back:`);
    for (const t of gone.slice(0, 12)) console.log(`   ${t.title ? `${t.title}  ` : ''}${t.url}`);
    if (gone.length > 12) console.log(`   … and ${gone.length - 12} more`);
    console.log('   Reopen the ones you still want:  wb go <url>');
  } catch { /* a convenience; never let it fail a launch */ }
}

function cdpVersion(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: timeoutMs },
      (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// gaveUp(): optional function that returns true once Chrome has already died.
// 🔵 There is no reason to wait another 20 seconds on a dead process — the user must
//    see the cause immediately.
//    (measured: a missing file failed in 0s, but "launched then died" took 20s)
async function waitForCdp(maxMs = 20000, gaveUp = null) {
  for (let w = 0; w < maxMs; w += 400) {
    const v = await cdpVersion();
    if (v && v.Browser) return v;
    // 🔴 Check once more even after it died — Chrome sometimes ends the parent
    //    process first and has a child open CDP (launcher pattern). Treating exit as
    //    an immediate failure would judge a normal startup as failed.
    if (gaveUp && gaveUp()) {
      await new Promise((r) => setTimeout(r, 600));
      const again = await cdpVersion();
      if (again && again.Browser) return again;
      return null;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ---------------------------------------------------------------- startup

// 🔵 Exported so the path and platform helpers can be unit-tested without
//    launching a browser. Everything below the guard still runs as before when
//    this file is executed directly (`node launch.js`).
module.exports = {
  isWSL, chromeCandidates, toWindowsPath, windowsHomeFromWSL, stateDir, profileDir,
};

// 🔴 Without this guard, `require('./launch.js')` starts Chrome. A test importing
//    one pure function would launch a real browser on the developer's desktop.
if (require.main !== module) return;

(async () => {
  // If it is already up, do not start it again. Starting twice makes the second one
  // die silently, leaving only a "started" log and no way to find the cause.
  const existing = await cdpVersion();
  if (existing && existing.Browser) {
    console.log(`ALREADY_UP  ${existing.Browser}  cdp=http://127.0.0.1:${CDP_PORT}`);
    // 🔴 "Already up" is not "already correct". Chrome reads its command line only at
    //    startup, so a browser that was running before a flag was added keeps the old
    //    behaviour — and this line used to be the whole answer. Reported 2026-10-02 by
    //    someone told to run `node launch.js` to pick up a new flag: it printed ALREADY_UP
    //    and exited, the flag never applied, and the only reason they noticed was that they
    //    went looking. "It said already up" reads as success.
    // 🔵 Measure the capability rather than parse a command line: the running browser either
    //    allows audio without a gesture or it does not, and that is the thing people care
    //    about. Never fatal — a probe that cannot run must not stop anyone from working.
    const gap = await autoplayGap();
    if (gap) {
      console.log('');
      console.log('🔴 This Chrome was started WITHOUT --autoplay-policy=no-user-gesture-required,');
      console.log('   so pages that speak (a voice UI, an alert chime) stay silent after every');
      console.log('   reload until a human clicks. Chrome only reads flags at startup, so this');
      console.log('   command cannot fix it — the running browser has to be stopped first:');
      console.log('');
      console.log('     wb down            # stops the engine (not Chrome)');
      console.log('     # then close Chrome yourself, or:');
      console.log(`     curl -s http://127.0.0.1:${CDP_PORT}/json/version   # find webSocketDebuggerUrl`);
      console.log('     # …and send {"id":1,"method":"Browser.close"} on that socket');
      console.log('     node launch.js     # now the flag applies');
      console.log('');
      console.log('   🔴 Browser.close shuts the WHOLE browser, including tabs other agents or');
      console.log('      the user opened. Check `wb tabs` first; note what is open, as reopening');
      console.log('      is not automatic.');
      console.log('   Verify after: node scripts/check-autoplay.js');
    } else {
      // 🔵 Say the good case out loud. Reported 2026-10-02: with only the bad path printing,
      //    "checked and fine" and "never checked" looked identical from the outside — both
      //    were a single ALREADY_UP line. One line buys that distinction.
      console.log('autoplay    ✅ allowed (pages can speak without a click)');
    }
    // 🔴 Write the snapshot HERE too, not only from the engine. Reported 2026-10-02: on the
    //    very machine that lost its tabs, `tabs-*.json` never existed — the only writer was
    //    the engine's /health, and that machine runs Chrome without the engine. A recovery
    //    aid that only exists where the accident does not happen is no aid at all.
    //    Chrome is up right now, which is exactly when the list is worth taking.
    // 🔴 Report BEFORE snapshotting. Writing first makes "no record yet" impossible to
    //    observe — the fresh write satisfies the check that was meant to warn about its
    //    absence, so the one machine that needed the warning never saw it. Measured here
    //    by deleting the file: with the old order the warning never printed.
    await reportMissingTabs();
    await snapshotTabs();
    return;
  }

  const problems = [];
  if (!CHROME) {
    problems.push('Could not find Chrome.\n'
      + '   → Set the executable path with the WBROWSER_CHROME environment variable.\n'
      + `   Places checked: ${chromeCandidates().slice(0, 3).join(', ')} …`);
  }
  if (WSL && CHROME_IS_WINDOWS && !fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    problems.push('WSL interop is off, so Windows executables cannot be launched.');
  }
  if (!PROFILE_DIR) {
    // 🔴 No arbitrary fallback. If the profile location cannot be determined, do not launch.
    if (ambiguity) {
      problems.push(`There are several user folders and we cannot tell which one: ${ambiguity.ambiguous.join(', ')}\n`
        + '   → Specify it with WBROWSER_PROFILE_DIR.');
    } else {
      problems.push('Could not determine the profile folder.\n'
        + '   → Specify it with WBROWSER_PROFILE_DIR.');
    }
  }
  if (problems.length) {
    problems.forEach((p) => console.error(`❌ ${p}`));
    process.exit(1);
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // 🔵 Seed the logins from the user's REAL Chrome profile. Chrome 136+ won't let us drive the
  //    default profile, so we run a copy in PROFILE_DIR — but an empty copy means "log in again",
  //    which is exactly what wbrowser exists to avoid. When a source Chrome "User Data" is present
  //    (Windows install), copy the login-bearing files of the chosen inner profile in. 🔴 A running
  //    Chrome holds Cookies exclusively (measured: cp/PowerShell both fail with a lock), so with
  //    Chrome open only the saved PASSWORDS come (auto-fill can then sign in); the live SESSION
  //    (cookies) needs that Chrome profile closed during the copy. And it is same-machine only —
  //    Chrome encrypts these with the OS key (DPAPI), so a copy is undecryptable on another box.
  //    Seed-only: never overwrites files a session built up, safe every start.
  //    WBROWSER_NO_PROFILE_SEED=1 opts out (an intentionally empty window).
  if (!process.env.WBROWSER_NO_PROFILE_SEED) {
    try {
      const { seedProfile } = require('./copyprofile');
      // The source User Data root: an explicit override, else the Windows Chrome install.
      let srcRoot = process.env.WBROWSER_SEED_FROM || '';
      if (!srcRoot) {
        for (const home of (fs.existsSync('/mnt/c/Users') ? fs.readdirSync('/mnt/c/Users') : [])) {
          const cand = `/mnt/c/Users/${home}/AppData/Local/Google/Chrome/User Data`;
          if (fs.existsSync(cand)) { srcRoot = cand; break; }
        }
      }
      if (srcRoot && fs.existsSync(srcRoot)) {
        const r = seedProfile(srcRoot, PROFILE_DIR, PROFILE);
        if (r.copied.length) {
          // 🔴 Do not claim "signed in": that is only true if the COOKIES came along. Saved
          //    passwords let auto-fill sign you in; cookies are the live session. Say which we got.
          const gotCookies = r.copied.some((f) => /cookies/i.test(f));
          console.log(gotCookies
            ? `🔵 Seeded ${r.copied.length} file(s) incl. cookies from Chrome profile "${PROFILE}" — the live session came along, you should be signed in.`
            : `🔵 Seeded ${r.copied.length} file(s) (saved passwords) from Chrome profile "${PROFILE}". The login session (cookies) did NOT come — see below — so you may hit a login page where auto-fill signs in.`);
        }
        if (r.skipped.length) {
          const cookieLocked = r.skipped.some((s) => /cookies/i.test(s.to));
          console.log(cookieLocked
            ? `🔴 Cookies are LOCKED (Chrome is running on that profile) so the login SESSION was not copied — only Chrome can release it. To bring the session, close that Chrome profile, then re-run. (Measured: a running Chrome holds Cookies exclusively; no copy method bypasses it.)`
            : `🔵 ${r.skipped.length} file(s) were locked (Chrome is using that profile). Close it and re-run for a complete seed.`);
        }
      }
    } catch (e) {
      // Seeding is a convenience; never let it stop the launch.
      console.error(`[seed] skipped: ${(e && e.message) || e}`);
    }
  }

  // The path to hand to Chrome (Windows notation when it is the Windows Chrome)
  const udd = CHROME_IS_WINDOWS && PROFILE_DIR.startsWith('/mnt/')
    ? toWindowsPath(PROFILE_DIR) : PROFILE_DIR;

  // Startup landing page — the user must be able to tell what this window is.
  let startUrl = 'about:blank';
  try {
    const src = path.join(__dirname, 'home.html');
    if (fs.existsSync(src)) {
      const dst = path.join(PROFILE_DIR, 'home.html');
      // 🔵 Stamp the running version into the page so its update check knows what
      //    "you have" is. Copying verbatim would leave the placeholder and the check
      //    would skip — which is the safe default if this ever fails.
      let ver = '0.0.0';
      try { ver = require('./package.json').version || ver; } catch { /* keep default */ }
      const html = fs.readFileSync(src, 'utf8').replace(/__WBROWSER_VERSION__/g, ver);
      fs.writeFileSync(dst, html);
      const p = CHROME_IS_WINDOWS && dst.startsWith('/mnt/') ? toWindowsPath(dst) : dst;
      startUrl = `file:///${p.replace(/\\/g, '/')}`;
    }
  } catch { /* the browser must come up even if the landing page cannot */ }

  // Headless or not: an explicit setting wins over auto-detection.
  // 🔴 On a Linux server with no DISPLAY, Chrome dies instantly with "Missing X server".
  //    (measured on a headless Linux server) Detect that up front and launch with --headless.
  const wantHeadless = process.env.WBROWSER_HEADLESS === '1'
    || (process.env.WBROWSER_HEADLESS !== '0'
        && process.platform === 'linux' && !WSL
        && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${udd}`,
    `--profile-directory=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 🔴 Block Chrome's on-device AI model (Gemini Nano) download — it is ~4GB.
    //    Real incident (2026-09-13, reported by seoul): a duns profile pulled
    //    OptGuideOnDeviceModel/weights.bin 2730MB + cache.bin 1344MB and ate 4.2GB
    //    of that host's disk. An automation profile never needs the on-device model.
    // 🔵 Why the flag and not chrome://flags: the Chrome team states the model is
    //    fetched whenever a page calls any `*.create()` (Summarizer, etc.), and that
    //    the UI toggles do not prevent it. The command line is the reliable lever.
    //    https://groups.google.com/a/chromium.org/g/chrome-ai-dev-preview-discuss/c/t6fqOnTzA_g
    // 🔴 One --disable-features wins over another, so every name must live in ONE
    //    comma-separated list. Adding a second flag would silently drop Translate.
    '--disable-features=Translate,OptimizationGuideModelDownloading,OptimizationHints,'
      + 'OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationGuideOnDeviceModel',
    // 🔴 Let pages play audio without a click. Chrome blocks autoplay until the user has
    //    interacted with the page, and a reload resets that — so any page that talks (a
    //    voice assistant, an alert chime, a read-aloud UI) goes silent after every refresh
    //    until a human clicks. Reported 2026-10-02: a voice canvas lost its audio on all 10
    //    of that day's reloads; `JarvisVoice.audioBlocked()` was true right after
    //    `Page.reload`, and the only way back was a synthetic keypress injected over CDP.
    //    An agent cannot click for the user, so without this the silence is permanent from
    //    the agent's side — and silent, which is worse: the page looks fine.
    // 🔵 Safe here specifically because this is a dedicated automation profile that the
    //    user opens deliberately, not their everyday browser. The flag only removes the
    //    gesture requirement; it grants no other capability.
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (wantHeadless) {
    // 🔵 For servers with no display. Existing login sessions still work, but a person
    //    cannot log in interactively — in that case move sessions over with the session
    //    backup (sync-session.sh).
    args.push('--headless=new');
    if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
    console.log('🔵 No display (DISPLAY) found, launching headless.');
    console.log('   If this happens even though you have a display, turn it off with WBROWSER_HEADLESS=0.');
  } else {
    args.push('--window-name=🤖 Wbrowser');
    args.push(`--window-size=${process.env.WBROWSER_WINDOW_SIZE || '1280,900'}`);
  }
  args.push(startUrl);

  // 🔴 With stdio:'ignore' you never learn why Chrome died.
  //    You only see the symptom "no CDP response" and the cause (missing X server etc.)
  //    disappears.
  //    → Collect stderr and show it only when things fail.
  const child = spawn(CHROME, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => { chromeErr += d.toString(); });
    child.stderr.on('error', () => {});
    // 🔴 child.unref() does not release the stderr pipe. unref() lets go of the process
    //    only; the open stream keeps holding the event loop → launch.js never exits.
    //    (measured on macOS and WSL: rc=124)
    //    Our only use for stderr is "why did it fail to start", so we let it go once the
    //    verdict is in.
    child.stderr.unref();
  }
  // 🔴 If spawn fails outright (no such file, no permission) there is no reason to wait
  //    for CDP. Instead of burning 20 seconds and then reporting the wrong cause, say
  //    the real reason immediately.
  let spawnFailed = null;
  child.on('error', (e) => {
    spawnFailed = e;
    chromeErr += `spawn failed: ${e.message}\n`;
  });

  // 🔵 Record it when Chrome exits on its own — waitForCdp watches this and shows the
  //    cause quickly instead of waiting out the full 20 seconds.
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    if (code) chromeErr += `Chrome exited with code ${code}.\n`;
  });

  child.unref();

  // spawn errors arrive on the next tick — yield once before waiting.
  await new Promise((r) => setImmediate(r));
  if (spawnFailed) {
    console.error(`❌ Could not launch Chrome: ${spawnFailed.message}`);
    console.error(`   path: ${CHROME}`);
    console.error('   → Set the correct path with WBROWSER_CHROME.');
    process.exit(1);
  }

  const v = await waitForCdp(20000, () => exited !== null);

  // The verdict is in, so close the pipe. Success or failure, there is nothing left to read.
  if (child.stderr) {
    try { child.stderr.removeAllListeners(); child.stderr.destroy(); } catch { /* noop */ }
  }
  if (!v) {
    // 🔴 No silent failures — write enough to tell the causes apart.
    console.error(`❌ CDP is not responding on ${CDP_PORT}.`);

    // If Chrome actually said something, that is the most accurate evidence.
    const lines = chromeErr.split('\n').filter((l) => /ERROR|FATAL|error|failed/i.test(l));
    if (lines.length) {
      console.error('\n   Errors Chrome reported:');
      lines.slice(0, 6).forEach((l) => console.error(`     ${l.trim()}`));
      if (/Missing X server|\$DISPLAY|platform failed to initialize/i.test(chromeErr)) {
        console.error('\n   → This environment has no display. Launch headless:');
        console.error('        WBROWSER_HEADLESS=1 node launch.js');
      }
      console.error('');
    }

    console.error('   Other common causes:');
    console.error('   ① Another Chrome process may already be running —');
    console.error('      when Chrome is already running it does not create a new process but');
    console.error('      just attaches a window, and --remote-debugging-port is silently ignored.');
    console.error('      Close all Chrome windows and try again.');
    console.error(`   ② Another process may be holding port ${CDP_PORT}.`);
    process.exit(1);
  }
  // 🔵 Write down what we know — so status does not have to ask Chrome back.
  //    Chrome 151 does not include userDataDir in /json/version, so asking yields 'unknown'
  //    (measured on macOS, Chrome 151). Here it is a value we know for certain.
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'runtime.json'), JSON.stringify({
      profileDir: udd,
      profile: PROFILE,
      cdpPort: Number(CDP_PORT),
      headless: wantHeadless,
      chrome: CHROME,
      browser: v.Browser,
      startedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* failing to write does not affect operation — only the status display goes blank */ }

  console.log(`BROWSER_UP  ${v.Browser}  cdp=http://127.0.0.1:${CDP_PORT}`);
  console.log(`profile     ${udd}  (${PROFILE})`);

  await reportMissingTabs();
  // 🔵 AFTER reporting, not before: right now the browser holds only the start page, and
  //    writing that over the previous list would erase the very thing the next restart needs.
  //    (tabsave also refuses to overwrite with an empty list, but order is the real guard.)
  //    From here on each launch leaves a record, so a machine that never runs the engine
  //    still accumulates one.
  await snapshotTabs();
})();
