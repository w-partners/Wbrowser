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
  return {
    ok: false,
    error: why || `engine returned ${r.status}`,
    engineStatus: r.status || null,
  };
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
    async run() {
      const r = await engineCall('GET', '/windows');
      if (r.status !== 200 || !r.json) return engineFail(r);
      return { ok: true, ...r.json };
    },
  },
  logins: {
    label: '로그인된 사이트 (도메인만, 쿠키 값 없음)',
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
    return `${x.origin}${x.pathname}${x.search ? '?…' : ''}`;
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
      description: r.label,
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
      const eng = await engineCall('GET', '/health');
      const engineOk = eng.status === 200 && eng.json && eng.json.ok === true;
      const browserOk = engineOk && !!eng.json.browser;
      send(res, 200, {
        ok: engineOk, site: SITE, owner: OWNER, version: VERSION,
        checks: [
          { name: '엔진(7981)', ok: engineOk, detail: engineOk ? (eng.json.build || null) : (eng.error || `status ${eng.status}`) },
          { name: '크롬 연결', ok: browserOk, detail: browserOk ? null : 'Chrome not attached (wb up)' },
        ],
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/starian/capabilities') {
      send(res, 200, {
        reads: Object.entries(READS).map(([name, r]) => ({ name, label: r.label })),
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
