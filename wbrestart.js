#!/usr/bin/env node
// wbrestart.js — stop the engine on this machine's port and start a fresh one.
//
// 🔴 The ENGINE only. Never Chrome: it may be the user's own window, with tabs other agents
//    are driving. `wb down` has refused to touch Chrome since the day a pattern-kill took out
//    the master's browser (2026-08-25), and a remote caller is the last place to relax that.
//
// 🔴 Kill by PORT, never by name. `pkill -f engine.js` matches every engine on the host —
//    including other projects' — and once took down an unrelated agent's browser session
//    (2026-10-01). The port is the one unambiguous handle: it is the engine this machine's
//    `wb` talks to.
//
// Run detached by starian.js so the restart survives the HTTP response that requested it.
const { execFileSync, spawn } = require('child_process');
const path = require('path');

const PORT = String(process.env.WBROWSER_PORT || 7981);
const BY = process.env.WBROWSER_RESTART_BY || 'unknown';

function pidsOnPort(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 10000 });
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (!line.includes(`:${port} `)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) pids.add(Number(m[1]));
    }
    return [...pids];
  } catch { return []; }
}

(async () => {
  const log = (m) => console.log(`[wbrestart ${new Date().toISOString()}] ${m}`);
  log(`requested by ${BY}`);

  for (const pid of pidsOnPort(PORT)) {
    if (pid === process.pid) continue;
    try {
      // 🔴 SIGTERM, not SIGKILL. A hard kill leaves playwright's utility worlds behind inside
      //    Chrome; they accumulate per connection and eventually make connectOverCDP time out
      //    entirely — measured at 723 of them after a few `kill -9` (2026-08-25). Only a
      //    Chrome restart clears those, and we are specifically not restarting Chrome.
      process.kill(pid, 'SIGTERM');
      log(`SIGTERM -> ${pid}`);
    } catch (e) { log(`could not signal ${pid}: ${e.code || e.message}`); }
  }

  // Give it time to let go of the port before the new one binds, or the replacement exits
  // with EADDRINUSE and the only thing still answering is the engine we meant to replace.
  await new Promise((r) => { setTimeout(r, 6000); });
  const still = pidsOnPort(PORT);
  if (still.length) {
    log(`port ${PORT} still held by ${still.join(',')} — not starting a second engine`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(__dirname, 'engine.js')], {
    detached: true, stdio: 'ignore', cwd: __dirname, env: process.env,
  });
  child.unref();
  log(`engine started (pid ${child.pid})`);
  process.exit(0);
})();
