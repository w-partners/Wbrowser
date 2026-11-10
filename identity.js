// What a tab says it is — mobile on mobile sites, and never "HeadlessChrome".
//
// 🔵 Mobile: a goto to a mobile host (m.example.com) makes the tab a phone BEFORE the request
//    leaves — UA, client hints, viewport, touch — so the site serves its mobile build instead of
//    redirecting a desktop browser back to www. Mobile sites usually score bots less strictly.
//    Going to any other host turns it back into the desktop it really is.
// 🔴 Headless: `--headless=new` puts "HeadlessChrome" in the UA and the client-hint brands,
//    which bot defences block on sight. On a headless browser every goto overrides both to the
//    plain Chrome they would otherwise be.
// 🔵 WBROWSER_MOBILE=0 turns off the mobile switch.

const sessions = new WeakMap();      // page → { cdp, mode }

// 🔴 Read every time, never cache: Chrome can be restarted (headed↔headless, upgraded) under a
//    running engine, and a stale answer would stamp the wrong identity on every tab. It is one
//    local HTTP call.
async function browserVersion(cdpBase) {
  const r = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(3000) });
  const v = await r.json();
  // 🔴 Read "headless" and the major version off the UA, not `Browser`: new headless reports
  //    Browser=Chrome/149… while its UA still says HeadlessChrome (measured, Chrome 149), and
  //    the UA carries Chrome/<n> on every Chromium build.
  const ua = v['User-Agent'] || '';
  const maj = /Chrome\/(\d+)/.exec(ua);
  if (!maj) throw new Error(`cannot read the Chrome version from /json/version (User-Agent=${ua})`);
  const full = (/\/(\d+\.\d+\.\d+\.\d+)/.exec(v.Browser || '') || [])[1] || `${maj[1]}.0.0.0`;
  return { full, major: maj[1], headless: /HeadlessChrome/.test(ua), ua };
}

const isMobileHost = (url) => {
  try { return /^m\./i.test(new URL(url).hostname); } catch { return false; }
};

// 🔴 The brand list must be the one this Chrome would send itself — a made-up "Not_A Brand"
//    differs from the real one and is a tell of its own. Chromium derives the GREASE brand, its
//    version and the list order from the major version (user_agent_utils.cc); reproduced here.
//    Checked against Chrome 149: [Google Chrome, Chromium, Not)A;Brand 24] (test/human.test.js).
function brands(major, full) {
  const seed = Number(major);
  const ch = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = [`Not${ch[seed % 11]}A${ch[(seed + 1) % 11]}Brand`, ['8', '99', '24'][seed % 3]];
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][seed % 6];
  const list = [];
  list[order[0]] = grease; list[order[1]] = ['Chromium', major]; list[order[2]] = ['Google Chrome', major];
  return {
    brands: list.map(([brand, version]) => ({ brand, version })),
    fullVersionList: list.map(([brand, v]) => ({ brand, version: v === major ? full : `${v}.0.0.0` })),
    fullVersion: full,
  };
}

function overrideFor(mode, v) {
  if (mode === 'mobile') {
    return {
      userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v.major}.0.0.0 Mobile Safari/537.36`,
      platform: 'Linux armv81',
      // The UA string is frozen at "Android 10; K" on real phones; the hints carry the truth.
      userAgentMetadata: {
        ...brands(v.major, v.full), platform: 'Android', platformVersion: '14.0.0', architecture: '', bitness: '',
        model: 'SM-S918N', mobile: true, wow64: false, formFactors: ['Mobile'],
      },
    };
  }
  // 'desktop' — a headless browser: its own UA with the one tell removed. 🔴 Overriding the UA
  //    empties every client hint unless metadata comes with it (measured: architecture, bitness,
  //    brands, fullVersionList all ""/[]), so the metadata must equal what this Chrome sends by
  //    itself. Measured on headless Chrome 149, Linux x86_64: architecture x86, bitness 64,
  //    platformVersion "", wow64 false, formFactors [Desktop]. Only Linux is reproduced — on
  //    other systems the true platformVersion is not knowable here, so desktopHints returns
  //    null: the UA is left as it is and the reply says why (no invented values).
  return { userAgent: v.ua.replace('HeadlessChrome/', 'Chrome/'), ...desktopHints(v) };
}

function desktopHints(v) {
  const arch = /Linux x86_64/.test(v.ua) ? ['x86', '64', 'Linux x86_64']
    : /Linux aarch64/.test(v.ua) ? ['arm', '64', 'Linux aarch64'] : null;
  if (!arch) return null;
  return {
    platform: arch[2],
    userAgentMetadata: {
      ...brands(v.major, v.full), platform: 'Linux', platformVersion: '', architecture: arch[0], bitness: arch[1],
      model: '', mobile: false, wow64: false, formFactors: ['Desktop'],
    },
  };
}

// Set the override over any CDP transport. `from` is the mode currently in force on that
// session (null = none). Returns { mode, note }: the mode now in force, and a line for the
// reply when something was deliberately left undone.
async function switchTo(send, url, cdpBase, from) {
  const v = await browserVersion(cdpBase);
  let want = (process.env.WBROWSER_MOBILE !== '0' && isMobileHost(url)) ? 'mobile'
    : (v.headless ? 'desktop' : null);
  let note = null;
  // 🔴 Not reproducible → treat as "no override" (null), NOT as an error: a throw here would
  //    also skip clearing a phone left on the tab by an earlier m. goto, and it would stay a
  //    phone forever. Leave the UA alone, still clear what needs clearing, and say so.
  if (want === 'desktop' && !desktopHints(v)) {
    want = null;
    note = 'UA still says HeadlessChrome: this system\'s client hints cannot be reproduced';
  }
  if (from === want) return { mode: want, note };
  if (want === 'mobile') {
    await send('Emulation.setUserAgentOverride', overrideFor('mobile', v));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    if (from !== null && from !== 'desktop') {      // 'mobile', or 'unknown' after a failure
      await send('Emulation.clearDeviceMetricsOverride', {});
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    // An empty userAgent clears the override (back to the browser's own).
    await send('Emulation.setUserAgentOverride', want ? overrideFor(want, v) : { userAgent: '' });
  }
  return { mode: want, note };
}

// Playwright path: call right before page.goto(url). Returns { mode, note } so the caller can
// say what the tab presented as. The CDP session is kept per page because an
// override lives only as long as the session that set it.
async function apply(page, url, cdpBase) {
  let s = sessions.get(page);
  if (!s) {
    const v = await browserVersion(cdpBase);
    const want = (process.env.WBROWSER_MOBILE !== '0' && isMobileHost(url)) || v.headless;
    if (!want) return { mode: null, note: null };   // nothing to override, no session needed
    s = { cdp: await page.context().newCDPSession(page), mode: null };
    sessions.set(page, s);
  }
  // 🔴 A switch that throws halfway (UA set, metrics not) leaves the tab in a state we no
  //    longer know. Mark it so, so the next goto re-applies everything instead of finding
  //    from === want and returning early with a stale override still on the tab.
  let r;
  try {
    r = await switchTo((m, p) => s.cdp.send(m, p), url, cdpBase, s.mode);
  } catch (e) { s.mode = 'unknown'; throw e; }
  s.mode = r.mode;
  return r;
}

module.exports = { apply, switchTo, isMobileHost, overrideFor, brands };
