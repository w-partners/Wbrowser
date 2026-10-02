// tabsave.js — remember what was open before Chrome goes down, and offer it back after.
//
// 🔴 Why: restarting Chrome is sometimes the only way to apply a flag, and the tabs do not
//    come back on their own. Reported 2026-10-02: a restart to pick up an autoplay flag left
//    1 tab of the 2 that had been open, and the person restored the other by hand from a note
//    they had made first. If they had not thought to write it down, it was gone.
//
// 🔵 Design: this NEVER closes or opens anything by itself. It writes a list, and prints a
//    list. Reopening is the caller's call — a tab the user closed deliberately before a
//    restart should not come back, and only a person knows which those are.
const fs = require('fs');
const path = require('path');
const http = require('http');

// Pages worth remembering. A blank tab carries no intent, and devtools windows are noise.
// 🔵 Exported so the test can drive the rule without a browser.
function worthSaving(t) {
  if (!t || t.type !== 'page') return false;
  const url = t.url || '';
  if (!/^https?:/i.test(url)) return false;          // about:blank, chrome://, file:// …
  if (/^https?:\/\/127\.0\.0\.1:\d+\/json/.test(url)) return false; // our own CDP endpoints
  return true;
}

// 🔴 Deduplicate by URL. Chrome reports one target per tab, and a user with the same page
//    open twice does not want it reopened twice — but keep the FIRST title seen, which is
//    the one that rendered.
function planSave(targets) {
  const seen = new Set();
  const out = [];
  for (const t of (targets || []).filter(worthSaving)) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    out.push({ url: t.url, title: (t.title || '').slice(0, 120) });
  }
  return out;
}

function savePath(stateDir, cdpPort) {
  return path.join(stateDir, `tabs-${cdpPort}.json`);
}

function getJSON(cdpBase, p, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const u = new URL(cdpBase + p);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs },
      (res) => {
        let b = ''; res.on('data', (d) => { b += d; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Write the list. Returns the entries saved, or null when there was nothing to ask Chrome.
async function save({ cdpBase, stateDir, cdpPort }) {
  const targets = await getJSON(cdpBase, '/json/list');
  if (!targets) return null;                       // Chrome not answering — nothing to save
  const entries = planSave(targets);
  // 🔴 Do not overwrite a good list with an empty one. If Chrome answered with no pages
  //    (already shutting down), the previous list is the better record of what was open.
  if (!entries.length) return [];
  const file = savePath(stateDir, cdpPort);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), tabs: entries }, null, 2));
  return entries;
}

// Read the list back. Returns [] when there is none — a missing file is a normal state.
function load({ stateDir, cdpPort }) {
  try {
    const d = JSON.parse(fs.readFileSync(savePath(stateDir, cdpPort), 'utf8'));
    return Array.isArray(d.tabs) ? d.tabs : [];
  } catch { return []; }
}

// Which saved tabs are NOT currently open. This is what a person actually wants to see after
// a restart: the gap, not the whole history.
function missing(saved, openNow) {
  const open = new Set((openNow || []).filter(worthSaving).map((t) => t.url));
  return (saved || []).filter((t) => !open.has(t.url));
}

module.exports = { worthSaving, planSave, savePath, save, load, missing };
