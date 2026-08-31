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

  // The path to hand to Chrome (Windows notation when it is the Windows Chrome)
  const udd = CHROME_IS_WINDOWS && PROFILE_DIR.startsWith('/mnt/')
    ? toWindowsPath(PROFILE_DIR) : PROFILE_DIR;

  // Startup landing page — the user must be able to tell what this window is.
  let startUrl = 'about:blank';
  try {
    const src = path.join(__dirname, 'home.html');
    if (fs.existsSync(src)) {
      const dst = path.join(PROFILE_DIR, 'home.html');
      fs.copyFileSync(src, dst);
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
    '--disable-features=Translate',
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
})();
