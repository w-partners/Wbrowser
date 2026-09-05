#!/usr/bin/env node
// bench/run.js — run the reproducible benchmark and print a score.
//
// Serves the fixed fixtures on 127.0.0.1, drives each task through a RUNNING engine's /act,
// checks the reply, and prints passed/total and the rate. Deterministic and offline.
//
// Usage: node bench/run.js            (expects an engine already up, e.g. via scripts/e2e.sh's
//                                      setup, or a headless one on WBROWSER_PORT)
// Env:   WBROWSER_PORT (engine, default 7981), BENCH_PORT (fixture server, default 38210),
//        WB_BENCH_AGENT (agent name to stamp, default 'bench').
//
// 🔴 The score is only as honest as the framing: this measures our tool against a FIXED LOCAL
//    set, which anyone can rerun — not live logged-in sites. It is a floor of capability, not a
//    claim of parity with benchmarks run on the open web. run.js prints that caveat with the score.

const http = require('http');
const { PAGES } = require('./fixtures');
const { TASKS, score } = require('./tasks');

const ENGINE_PORT = Number(process.env.WBROWSER_PORT || 7981);
const BENCH_PORT = Number(process.env.BENCH_PORT || 38210);
const AGENT = process.env.WB_BENCH_AGENT || 'bench';
const BASE = `http://127.0.0.1:${BENCH_PORT}`;

function serveFixtures() {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url];
    if (body === undefined) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(BENCH_PORT, '127.0.0.1', () => resolve(server)));
}

function act(cmd) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ ...cmd, agent: AGENT }));
    const req = http.request({ host: '127.0.0.1', port: ENGINE_PORT, path: '/act', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => {
        try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// Turn one task step into an /act command. Mirrors what `wb` builds.
function stepToCmd(step) {
  const [a0, a1] = step.args;
  switch (step.op) {
    case 'go': return { goto: BASE + a0, read: true };
    case 'read': return { read: true };
    case 'click': return { click: a0, wait: 400, read: true };
    case 'type': return { type: { selector: a0, text: a1 }, read: true };
    case 'shot': return { shot: true };
    default: throw new Error(`bench: unknown step op ${step.op}`);
  }
}

async function runTask(task) {
  let last = {};
  for (const step of task.steps) last = await act(stepToCmd(step));
  let ok = false;
  try { ok = !!task.check(last); } catch { ok = false; }
  return { id: task.id, ok };
}

async function main() {
  const server = await serveFixtures();
  try {
    const results = [];
    for (const task of TASKS) {
      const r = await runTask(task);
      results.push(r);
      process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id}\n`);
    }
    const s = score(results);
    process.stdout.write(`\nscore: ${s.passed}/${s.total}  (${(s.rate * 100).toFixed(1)}%)\n`);
    process.stdout.write('note: a FIXED local task set anyone can rerun — a capability floor, '
      + 'not a live-web benchmark claim.\n');
    process.exit(s.passed === s.total ? 0 : 1);
  } finally {
    server.close();
  }
}

if (require.main === module) main().catch((e) => { console.error('bench:', e.message); process.exit(2); });

module.exports = { stepToCmd };
