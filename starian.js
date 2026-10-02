#!/usr/bin/env node
// starian.js — the Starian control surface for Wbrowser.
//
// 🔴 Why this is a SEPARATE process and not a few more routes on the engine:
//    the engine binds to 127.0.0.1 on purpose. Reaching that port means driving every
//    session the user is signed into — `docs/DESIGN-remote-handoff.md` calls this "the hard
//    constraint that shapes every option", and `README.md` says "never expose it directly".
//    Moving the engine to 0.0.0.0 to satisfy a spec would hand the user's logged-in Chrome
//    to anything on the tailnet. So this is the shim that design doc recommends (Option A):
//    it listens on the tailnet, and talks to the engine over loopback.
//
// 🔴 What that means for the capability table: a shim cannot be safer than what it exposes.
//    Everything here is READ-ONLY or narrowly scoped, and the destructive verbs the engine
//    offers (type, click, goto, credential unlock) are deliberately NOT exposed. Someone on
//    the tailnet can see what the browser is doing; they cannot drive it.
//
// Spec: 관제/dongdong/jarvis-canvas/스타리안-제어-규격.md
//   GET  /api/starian/health
//   GET  /api/starian/capabilities
//   GET  /api/starian/read/<name>
//   POST /api/starian/action/<name>
//   POST /api/starian/mcp            (JSON-RPC 2.0: initialize / tools/list / tools/call)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.WBROWSER_STARIAN_PORT || 7982);
const ENGINE = process.env.WBROWSER_ENGINE || `http://127.0.0.1:${process.env.WBROWSER_PORT || 7981}`;
const SITE = 'wbrowser';
const OWNER = 'wbrowser-primary';
const VERSION = (() => {
  try { return require('./package.json').version; } catch { return '0'; }
})();

// 🔵 Audit trail. The spec requires `by` to be recorded; a control surface with no record of
//    who pressed what is not controllable, it is just reachable.
const AUDIT = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'wbrowser', 'starian-audit.log',
);
function audit(kind, name, by, extra) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, `${JSON.stringify({
      at: new Date().toISOString(), kind, name, by: by || null, ...extra,
    })}\n`);
  } catch { /* the audit file must never break a request */ }
}

// --- talking to the engine over loopback -----------------------------------
// 🔴 Generous by default, and tunable. Measured 2026-10-02 on a loaded host: the engine
//    answered /health in 35.9s while a 30s probe called it dead — the exact "slow is not
//    dead" mistake this project has already made twice. A control surface that reports a
//    healthy engine as down sends someone restarting a browser that was fine.
const ENGINE_TIMEOUT = Number(process.env.WBROWSER_STARIAN_ENGINE_TIMEOUT || 90000);
function engineCall(method, p, body, timeoutMs = ENGINE_TIMEOUT) {
  return new Promise((resolve) => {
    const u = new URL(ENGINE + p);
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout: timeoutMs,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: b.slice(0, 400) }); }
      });
    });
    // 🔴 Distinguish "engine is down" from "engine said no". Collapsing them is how a caller
    //    ends up restarting a healthy browser.
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: `engine did not answer within ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ status: 0, error: `engine unreachable: ${e.code || e.message}` }));
    if (data) req.write(data);
    req.end();
  });
}

// 🔴 Pass the engine's own words through. The engine answers 500 with a full diagnosis
//    ("restart the engine, not Chrome; the stale state is in the playwright connection"),
//    and the first version of this shim replaced all of that with "engine returned 500".
//    That is the censorship failure this project keeps hitting: the value existed and the
//    screen dropped it, sending the reader to the wrong layer.
function engineFail(r) {
  const why = (r.json && (r.json.error || r.json.hint)) || r.error || r.raw || null;
  const out = {
    ok: false,
    error: why || `engine returned ${r.status}`,
    engineStatus: r.status || null,
  };
  // 🔴 Pass the engine's words through, but do not pass through a prescription that cannot
  //    work. The engine's generic advice is "restart the engine" — and when playwright simply
  //    cannot attach to this Chrome version, no restart fixes it. Measured 2026-10-02: a remote
  //    caller was told to restart the engine three times for reads that could never succeed
  //    that way. A wrong instruction is worse than silence: it gets followed.
  if (/connectOverCDP|Timeout \d+ms exceeded|could not attach/i.test(String(why || ''))) {
    out.cause = 'the engine could not attach to Chrome (playwright ↔ Chrome version mismatch '
      + 'does this; measured 2026-10-02 with playwright 1.63 against Chrome 154)';
    out.restartWontHelp = true;
    out.whatWorks = 'reads that go through Chrome directly (status, autoplay, tabs) still work. '
      + 'This one needs playwright, so it needs a playwright that matches this Chrome — '
      + 'upgrade playwright, or run Chrome at the version it bundles.';
  }
  return out;
}

// Is the engine's socket accepting connections? Cheap, and it answers a different question
// from /health: "is the process alive" rather than "is the browser attached".
// 🔵 A TCP connect is the one probe that cannot be slowed down by what the engine is doing.
function enginePortOpen(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const net = require('net');
    const u = new URL(ENGINE);
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    const done = (v) => { try { sock.destroy(); } catch { /* already gone */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

// 🔴 health must be FAST, because it is polled by a caller with its own short timeout.
//    Measured 2026-10-02: the engine's /health attaches to Chrome and took 38.5s under load,
//    so our 8s probe always expired and health answered in 8.9s — and Starian, polling with a
//    shorter patience, showed this site red while every read worked. The fix is not a longer
//    timeout on either side; it is to stop making a liveness probe wait on an attach.
//
//    So: a TCP connect decides alive-or-dead (it cannot be slowed by what the engine is doing),
//    and the engine's own answer is refreshed in the BACKGROUND. health reports the last answer
//    with its age, never blocking on a new one.
//    🔵 An aged answer is reported AS aged. Serving a stale value as current is the censorship
//       failure — the reader is told something is true now when nobody checked.
let lastEngine = { at: 0, json: null, error: 'not probed yet' };
let probing = false;
function refreshEngine() {
  if (probing) return;                      // one prober, not one per poll
  probing = true;
  engineCall('GET', '/health', null, 60000)
    .then((r) => {
      if (r.status === 200 && r.json) lastEngine = { at: Date.now(), json: r.json, error: null };
      else lastEngine = { at: Date.now(), json: null, error: r.error || `status ${r.status}` };
    })
    .catch((e) => { lastEngine = { at: Date.now(), json: null, error: String(e.message || e) }; })
    .finally(() => { probing = false; });
}

// --- THE TABLE — one definition, used by REST and MCP alike ----------------
// 🔴 The spec's first principle: "표 하나, 문 둘" (one table, two doors). REST and MCP must
//    not drift, so neither owns the list — this does.
const READS = {
  tabs: {
    label: '열린 탭 목록 (누가 무엇을 보고 있나)',
    async run() {
      const r = await engineCall('GET', '/tabs');
      if (r.status !== 200 || !r.json) return engineFail(r);
      // 🔴 A tab's URL can carry a session token in its query string. Hand back the origin
      //    and path, never the query — this is read by voice and logged.
      const open = (r.json.open || []).map((t) => ({
        n: t.n, title: t.title || null, drivenBy: t.drivenBy || null,
        url: safeUrl(t.url),
      }));
      return { ok: true, count: open.length, tabs: open };
    },
  },
  status: {
    label: '엔진·브라우저 상태',
    async run() {
      const r = await engineCall('GET', '/health');
      if (r.status !== 200 || !r.json) return engineFail(r);
      return {
        ok: true, engine: true, browser: !!r.json.browser,
        build: r.json.build || null, openTabs: r.json.openTabs ?? null,
        startedAt: r.json.startedAt || null,
        note: r.json.browser ? null : 'Chrome is not attached — run `wb up` on that machine',
      };
    },
  },
  windows: {
    label: '브라우저 창·프로파일 목록',
    // 🔵 Say up front which reads need the attach. A caller that knows this can tell
    //    "the browser is broken" from "this one read needs something the others do not".
    needsAttach: true,
    async run() {
      const r = await engineCall('GET', '/windows');
      if (r.status !== 200 || !r.json) return engineFail(r);
      return { ok: true, ...r.json };
    },
  },
  logins: {
    label: '로그인된 사이트 (도메인만, 쿠키 값 없음)',
    needsAttach: true,          // cookies live in the playwright context, not in /json/list
    async run() {
      const r = await engineCall('GET', '/logins');
      if (r.status !== 200 || !r.json) return engineFail(r);
      // 🔵 /logins already returns domains only — no cookie values ever leave the engine.
      return { ok: true, ...r.json };
    },
  },
  autoplay: {
    label: '크롬이 소리를 낼 수 있나 (자동재생 인자)',
    async run() {
      // 🔵 Reuses the probe shipped in scripts/check-autoplay.js rather than a second copy.
      const { execFile } = require('child_process');
      return new Promise((resolve) => {
        execFile(process.execPath, [path.join(__dirname, 'scripts', 'check-autoplay.js')],
          { timeout: 120000 }, (err, stdout) => {
            const out = String(stdout || '');
            const allowed = /autoplay ALLOWED/.test(out);
            const blocked = /autoplay BLOCKED/.test(out);
            if (!allowed && !blocked) {
              resolve({ ok: false, error: 'could not measure autoplay', detail: out.slice(0, 200) });
              return;
            }
            resolve({
              ok: true, allowed,
              note: allowed ? null
                : 'Chrome was started without --autoplay-policy=no-user-gesture-required; '
                  + 'pages that speak stay silent after a reload until someone clicks',
            });
          });
      });
    },
  },
};

const ACTIONS = {
  'engine-restart': {
    label: '엔진 재시작 (브라우저는 건드리지 않음)',
    params: [],
    danger: true,   // 🔴 in-flight commands die with it, and other agents share this engine
    async run({ by }) {
      // 🔴 Restart the ENGINE, never Chrome. Chrome may be the user's own window with tabs
      //    other agents are driving; `wb down` has always refused to touch it, and a remote
      //    caller is the last place that rule should be relaxed.
      const { spawn } = require('child_process');
      const before = await engineCall('GET', '/health', null, 10000);
      spawn(process.execPath, [path.join(__dirname, 'wbrestart.js')], {
        detached: true, stdio: 'ignore', env: { ...process.env, WBROWSER_RESTART_BY: by || 'unknown' },
      }).unref();
      return { ok: true, result: { requested: true, previousBuild: before.json && before.json.build,
        note: 'restart requested; /api/starian/read/status will show the new build once it is up' } };
    },
  },
};

// 🔴 Never echo a full URL: a tab's query string can hold a session token, and these answers
//    are spoken aloud and written to an audit log.
function safeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    // 🔴 `origin` is the string "null" for file:, data: and blob: URLs, which produced
    //    "null/C:/Users/..." in the tab list (measured 2026-10-02). A reader cannot tell
    //    whether that means "no origin" or "the list is broken", so build from the protocol
    //    when there is no real origin.
    const base = x.origin && x.origin !== 'null' ? x.origin : `${x.protocol}//`;
    return `${base}${x.pathname}${x.search ? '?…' : ''}`;
  } catch { return String(u).slice(0, 80); }
}

// --- access control --------------------------------------------------------
// 🔴 tailnet (100.64.0.0/10) and loopback only, per the spec. This shim fronts a browser that
//    is logged into everything the user is; "reachable from anywhere" is not an option.
// 🔵 The range is literal on purpose, not a missing setting: 100.64.0.0/10 is the fixed CGNAT
//    block (RFC 6598) that Tailscale assigns from, and the Starian spec names it as the
//    boundary. Making it configurable would let a wrong value quietly widen who can reach a
//    logged-in browser — the one thing this gate exists to prevent.
function allowed(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || v4 === '::1') return true;
  const m = v4.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  // 100.64.0.0/10 → first octet 100, second 64..127
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// --- MCP: the same table, as tools ----------------------------------------
function mcpTools() {
  const tools = [];
  for (const [name, r] of Object.entries(READS)) {
    tools.push({
      name: `read_${name.replace(/-/g, '_')}`,
      // 🔵 Same fact as capabilities.needsAttach, from the same table. An MCP client that only
      //    sees tool descriptions would otherwise not know which reads can fail for a reason
      //    that has nothing to do with the read itself.
      description: r.needsAttach
        ? `${r.label} — 엔진이 크롬에 attach 돼야 합니다(안 되면 실패합니다)`
        : r.label,
      inputSchema: { type: 'object', properties: {}, required: [] },
    });
  }
  for (const [name, a] of Object.entries(ACTIONS)) {
    const properties = {};
    const required = [];
    for (const p of a.params || []) {
      properties[p.name] = { type: 'string', description: p.label };
      required.push(p.name);
    }
    // 🔴 danger actions need confirm at the MCP door too, or the safety rule would hold only
    //    for REST callers — same table, same gate.
    if (a.danger) {
      properties.confirm = { type: 'boolean', description: '위험 동작 — true 가 없으면 거절합니다' };
      required.push('confirm');
    }
    tools.push({
      name: `do_${name.replace(/-/g, '_')}`,
      description: a.danger ? `${a.label} ⚠️ 위험` : a.label,
      inputSchema: { type: 'object', properties, required },
    });
  }
  return tools;
}

async function handleMcp(body, by) {
  const { id, method, params } = body || {};
  const reply = (result) => ({ jsonrpc: '2.0', id: id ?? null, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (method === 'initialize') {
    return reply({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: `starian-${SITE}`, version: VERSION },
    });
  }
  if (method === 'tools/list') return reply({ tools: mcpTools() });
  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    const caller = args.by || by;
    if (typeof toolName === 'string' && toolName.startsWith('read_')) {
      const key = Object.keys(READS).find((k) => `read_${k.replace(/-/g, '_')}` === toolName);
      if (!key) return fail(-32601, `unknown tool: ${toolName}`);
      const out = await READS[key].run();
      audit('read', key, caller, { via: 'mcp' });
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], isError: !out.ok });
    }
    if (typeof toolName === 'string' && toolName.startsWith('do_')) {
      const key = Object.keys(ACTIONS).find((k) => `do_${k.replace(/-/g, '_')}` === toolName);
      if (!key) return fail(-32601, `unknown tool: ${toolName}`);
      const a = ACTIONS[key];
      if (a.danger && args.confirm !== true) {
        audit('action-refused', key, caller, { via: 'mcp', why: 'confirm missing' });
        return reply({
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `${key} is a danger action — resend with confirm:true` }) }],
          isError: true,
        });
      }
      const out = await a.run({ params: args, by: caller });
      audit('action', key, caller, { via: 'mcp', ok: !!out.ok });
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], isError: !out.ok });
    }
    return fail(-32601, `unknown tool: ${toolName}`);
  }
  return fail(-32601, `unsupported method: ${method}`);
}

// --- HTTP ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (!allowed(req)) { send(res, 404, { ok: false, error: 'not found' }); return; }
  const by = req.headers['x-starian-by'] || null;
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/starian/health') {
      // 🔴 health must answer FAST. It is a liveness probe that callers poll with their own
      //    short timeout — Starian marked this site red because our 90s patience outlasted
      //    its patience, so "engine is slow" was reported to the user as "site is down".
      //    A slow engine is a finding to report, not a reason to stop answering.
      // 🔵 Fast path only: a TCP connect, plus whatever the background prober last learned.
      const up = await enginePortOpen(2000);
      refreshEngine();                       // kick the slow probe; do NOT await it
      const ageMs = lastEngine.at ? Date.now() - lastEngine.at : null;
      const FRESH_MS = 60000;
      const fresh = lastEngine.json && ageMs !== null && ageMs < FRESH_MS;
      const eng = { status: fresh ? 200 : 0, json: fresh ? lastEngine.json : null,
        error: fresh ? null : (lastEngine.error || 'engine /health not yet observed') };
      // 🔴 Three states, not two. `answered` means the engine replied; `up` means it is alive.
      //    They differ exactly when the host is loaded: the engine's /health attaches to Chrome,
      //    which takes 30s+ here, so it does not answer in 8s — but its socket accepts
      //    connections, and every read still works. Calling that "down" told the user to
      //    restart a browser that was fine.
      //    🔴 Keep them in SEPARATE variables. Folding "up" back into "answered" is what broke
      //       this endpoint: the line below reads eng.json, which only exists if it ANSWERED.
      const answered = fresh && eng.json.ok === true;
      const slowButUp = !answered && up;
      const engineOk = answered || slowButUp;
      const browserOk = answered && !!eng.json.browser;
      send(res, 200, {
        ok: engineOk, site: SITE, owner: OWNER, version: VERSION,
        checks: [
          { name: '엔진(7981)', ok: engineOk,
            // 🔵 Say WHICH failure it is. "did not answer in 8s" and "refused the connection"
            //    send a reader to opposite places; collapsing them into one red dot is how a
            //    healthy-but-busy engine gets restarted.
            detail: slowButUp
              ? `listening; its own /health has not answered within ${FRESH_MS / 1000}s `
                + `(it attaches to Chrome, which is slow under load) — reads still work`
                + (ageMs !== null ? `; last answered ${Math.round(ageMs / 1000)}s ago` : '')
              : answered ? (eng.json.build || null)
              : (eng.error ? `${eng.error} — may be slow rather than down; read/status waits longer`
                : `status ${eng.status}`) },
          // 🔵 Unmeasured is not the same as attached-nothing. If the engine never answered we
          //    do not know about Chrome, and saying "run wb up" would be a guess.
          { name: '크롬 연결', ok: browserOk,
            detail: browserOk ? null
              : answered ? 'Chrome not attached (wb up)'
              : 'not measured — only the engine can see Chrome, and it has not answered yet' },
        ],
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/starian/capabilities') {
      send(res, 200, {
        // 🔵 needsAttach travels with the capability, so a caller learns which reads depend on
        //    playwright attaching BEFORE one of them fails. Knowing it afterwards, from a 502,
        //    is what made a remote caller read "the browser is broken" from "this read needs
        //    something the others do not" (javis, 2026-10-02).
        reads: Object.entries(READS).map(([name, r]) => ({
          name, label: r.label, needsAttach: !!r.needsAttach,
        })),
        actions: Object.entries(ACTIONS).map(([name, a]) => ({
          name, label: a.label, params: a.params || [], danger: !!a.danger,
        })),
      });
      return;
    }

    if (req.method === 'GET' && p.startsWith('/api/starian/read/')) {
      const name = decodeURIComponent(p.slice('/api/starian/read/'.length));
      const r = READS[name];
      // 🔴 Name what is available. "unknown read" alone sends the caller guessing.
      if (!r) { send(res, 404, { ok: false, error: `unknown read: ${name}`, available: Object.keys(READS) }); return; }
      const out = await r.run(url.searchParams);
      audit('read', name, by, { via: 'rest' });
      send(res, out.ok === false ? 502 : 200, out);
      return;
    }

    if (req.method === 'POST' && p.startsWith('/api/starian/action/')) {
      const name = decodeURIComponent(p.slice('/api/starian/action/'.length));
      const a = ACTIONS[name];
      if (!a) { send(res, 404, { ok: false, error: `unknown action: ${name}`, available: Object.keys(ACTIONS) }); return; }
      const body = await readBody(req);
      const caller = body.by || by;
      if (a.danger && body.confirm !== true) {
        audit('action-refused', name, caller, { via: 'rest', why: 'confirm missing' });
        send(res, 400, { ok: false, error: `${name} is a danger action — resend with confirm:true` });
        return;
      }
      const out = await a.run({ params: body.params || {}, by: caller });
      audit('action', name, caller, { via: 'rest', ok: !!out.ok });
      send(res, out.ok === false ? 502 : 200, out);
      return;
    }

    if (req.method === 'POST' && p === '/api/starian/mcp') {
      const body = await readBody(req);
      send(res, 200, await handleMcp(body, by));
      return;
    }

    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    // 🔴 Never answer 200 with an empty body on a crash — the spec's "no silent failure".
    send(res, 500, { ok: false, error: (e && e.message) || String(e) });
  }
});

server.on('error', (e) => {
  console.error(`WBROWSER_STARIAN_LISTEN_FAILED :${PORT} — ${(e && e.message) || e}`);
  process.exit(1);
});
// 🔵 0.0.0.0 with an allowlist, not because everything may reach it, but because the tailnet
//    address is assigned by Tailscale and binding to it directly fails when it is not up yet.
//    `allowed()` is the gate; this is just the socket.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WBROWSER_STARIAN_UP http://0.0.0.0:${PORT}  → engine ${ENGINE}  (tailnet/loopback only)`);
});

module.exports = { READS, ACTIONS, mcpTools, allowed, safeUrl };
