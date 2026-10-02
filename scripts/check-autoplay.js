#!/usr/bin/env node
// Does this Chrome allow audio without a click?
//
// 🔴 Why this exists: Chrome blocks autoplay until the user has interacted with the page,
//    and a reload resets that. Any page that talks — a voice assistant, an alert chime, a
//    read-aloud UI — goes silent after every refresh until a human clicks. An agent cannot
//    click for the user, so from the agent's side the silence is permanent AND silent: the
//    page renders fine and reports no error. Reported 2026-10-02 on a voice canvas that lost
//    its audio on all 10 of that day's reloads.
//
// 🔵 The fix is `--autoplay-policy=no-user-gesture-required` on the Chrome command line
//    (launch.js sets it). This script is how you tell whether the Chrome you are talking to
//    actually has it — a flag in the source is not a flag in the running process.
//
// Usage:  node scripts/check-autoplay.js [cdpUrl]
//         node scripts/check-autoplay.js http://127.0.0.1:9222
//
// Exit 0 = autoplay allowed, 1 = blocked, 2 = could not measure.
const http = require('http');

const CDP = process.argv[2] || process.env.WBROWSER_CDP
  || `http://127.0.0.1:${process.env.WBROWSER_CDP_PORT || 9222}`;

function getJSON(path, ms = 10000) {
  return new Promise((res) => {
    const u = new URL(CDP + path);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: ms }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    req.on('timeout', () => { req.destroy(); res(null); });
    req.on('error', () => res(null));
  });
}

function send(ws, id, method, params, sessionId, ms = 45000) {
  return new Promise((resolve, reject) => {
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const on = (ev) => {
      const x = JSON.parse(ev.data);
      if (x.id === id) {
        ws.removeEventListener('message', on);
        if (x.error) reject(new Error(JSON.stringify(x.error).slice(0, 160)));
        else resolve(x.result);
      }
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify(msg));
    setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(`timeout ${method}`)); }, ms);
  });
}

// 🔵 Measure the thing itself, not a proxy for it. An AudioContext that will not leave
//    `suspended` without a gesture IS the block users hear as silence. The oscillator is
//    kept effectively inaudible (gain 0.0001) so running this does not make a noise.
const PROBE = `(async () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { error: 'no AudioContext in this page' };
  const ctx = new AC();
  const initial = ctx.state;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain); gain.connect(ctx.destination);
  let after = 'n/a';
  try {
    osc.start();
    // 🔴 resume() can hang rather than reject when the gesture is missing, which would
    //    read as "could not measure" instead of "blocked". Race it: not-running by the
    //    deadline IS the blocked answer.
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 4000))]);
    after = ctx.state;
  } catch (e) { after = 'throw:' + e.name; }
  try { osc.stop(); ctx.close(); } catch (e) { /* already gone */ }
  return { initial, after, allowed: after === 'running' };
})()`;

(async () => {
  const ver = await getJSON('/json/version');
  if (!ver || !ver.webSocketDebuggerUrl) {
    console.log(`❌ no Chrome answering CDP at ${CDP}`);
    process.exit(2);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('websocket would not open')), { once: true });
  });
  let id = 0;
  // 🔴 Measure in a FRESH tab. An existing tab may already have a user gesture recorded,
  //    which would report "allowed" on a Chrome that blocks every new page — the exact
  //    false pass this check exists to prevent.
  const { targetId } = await send(ws, ++id, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, ++id, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, ++id, 'Runtime.enable', {}, sessionId);
  // 🔵 Generous: this runs on hosts under load, and a slow answer is not a blocked one.
  //    Overridable so a CI box can keep it tight.
  const evalMs = Number(process.env.WBROWSER_PROBE_TIMEOUT || 90000);
  const r = await send(ws, ++id, 'Runtime.evaluate',
    { expression: PROBE, returnByValue: true, awaitPromise: true }, sessionId, evalMs);
  const v = (r.result && r.result.value) || {};
  await send(ws, ++id, 'Target.closeTarget', { targetId }).catch(() => {});
  ws.close();

  console.log(`chrome : ${ver.Browser}`);
  console.log(`probe  : AudioContext ${v.initial} → ${v.after}`);
  if (v.allowed) {
    console.log('✅ autoplay ALLOWED — a page can speak straight after a reload');
    process.exit(0);
  }
  console.log('🔴 autoplay BLOCKED — a page stays silent until someone clicks it');
  console.log('   Fix: launch Chrome with --autoplay-policy=no-user-gesture-required');
  console.log('   (launch.js adds it; an already-running Chrome must be restarted to pick it up)');
  process.exit(1);
})().catch((e) => { console.log('❌ could not measure:', e.message); process.exit(2); });
