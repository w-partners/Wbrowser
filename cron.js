#!/usr/bin/env node
// cron.js — runs browser jobs automatically at scheduled times.
//
//   node cron.js list                    show registered jobs
//   node cron.js run <name>              run once right now (for testing)
//   node cron.js daemon                  keep the scheduler running
//   node cron.js next                    when each job fires next
//
// Job definition: jobs/<name>.json
//   {
//     "schedule": "0 9 * * 1-5",        // min hour dom month dow (standard 5 fields)
//     "account":  "work@example.com",   // optional — which profile window
//     "tab":      "report",             // optional — tab name (keeps jobs apart)
//     "allowIrreversible": false,       // 🔴 see below
//     "steps": [
//       { "goto": "https://example.com/report" },
//       { "click": "#refresh" },
//       { "wait": 2000 },
//       { "eval": "document.querySelector('.total').innerText" },
//       { "shot": true }
//     ]
//   }
//
//   Pacing (0.35.0 — on by default):
//     "jitterMinutes": 10,      // start 0–10 min after the scheduled minute, never on the dot (0 = off)
//     "dwellSeconds": [30, 60], // after each goto, stay this long before the next step (0 = off)
//     "dailyMax": 3,            // at most this many runs a day; more are skipped and logged
//     "verifyUrl": "https://example.com/p/1",  // after the run, fetch this with NO login …
//     "verifyText": "my title", //   … and require this text in it (optional)
//   🔵 Jobs never run at the same time: the daemon runs them one after another.
//
// 🔴 About irreversible actions
//    Unattended execution means "nobody is watching when it goes wrong". So clicks that
//    look like submit/pay/delete are **blocked by default**. If you really need one, the
//    job file must say "allowIrreversible": true — per job, so it never gets on by accident.

// 🔴 Refuse before doing anything if this checkout was never installed. Neither of
//    these files needs playwright itself, which is exactly the trap: they ran fine on a
//    clone with no node_modules and looked healthy. `cron.js list` printed the job list
//    as though the schedule were live, and `launch.js` reported ALREADY_UP after
//    attaching to a Chrome that belonged to somebody else. Measured 2026-08-31.
require('./preflight').requireInstalled();

const fs = require('fs');
const path = require('path');
const http = require('http');
const { classify } = require('./sensitiveaction');

const ENGINE = process.env.WBROWSER_ENGINE || 'http://127.0.0.1:7981';
const JOBS_DIR = process.env.WBROWSER_JOBS || path.join(__dirname, 'jobs');
const AGENT = process.env.WBROWSER_AGENT || 'cron';
const RUNS_FILE = process.env.WBROWSER_CRON_RUNS || path.join(require('os').homedir(), '.wbrowser', 'cron-runs.json');
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const today = () => new Date().toLocaleDateString('sv');      // YYYY-MM-DD, local

// How many times each job ran per day — for dailyMax. Old days are dropped.
// 🔴 A missing file is "no runs yet"; an unreadable one stops the job — reading it as 0
//    would quietly lift every dailyMax.
function loadRuns() {
  let raw;
  try { raw = fs.readFileSync(RUNS_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  try { return JSON.parse(raw); } catch {
    throw new Error(`${RUNS_FILE} is not valid JSON — not running jobs with dailyMax until it is fixed or removed`);
  }
}
function runsToday(name) {
  return (loadRuns()[today()] || {})[name] || 0;
}
function countRun(name) {
  let db = loadRuns();
  const d = today();
  db = { [d]: { ...(db[d] || {}), [name]: ((db[d] || {})[name] || 0) + 1 } };
  fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(db));
}
const dwellRange = (job) => {
  const d = job.dwellSeconds == null ? [30, 60] : job.dwellSeconds;
  if (!d) return null;
  return Array.isArray(d) ? d : [d, d];
};

// 🔴 Judge the result from outside, not from the screen we just drove: fetch with no cookies
//    and no login. A post that "succeeded" on our screen but is not public fails here.
async function verifyOutside(job) {
  if (!job.verifyUrl) return null;
  try {
    const r = await fetch(job.verifyUrl, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    if (!r.ok) return `external check: ${job.verifyUrl} answered ${r.status} without a login`;
    if (job.verifyText && !body.includes(job.verifyText)) return `external check: "${job.verifyText}" is not on ${job.verifyUrl} without a login`;
    return 'ok';
  } catch (e) { return `external check: could not fetch ${job.verifyUrl}: ${e.message}`; }
}

// 🔵 click/selector risk is now judged by the shared classifier (sensitiveaction.js) — see
//    riskyReason(). This regex remains ONLY for scanning eval CODE, which is not a button the
//    classifier understands. Kept in sync with the classifier's word groups; the classifier's
//    test locks in that it still catches every term here (no unattended gate weakening).
const RISKY = /submit|purchase|checkout|pay(ment)?|delete|remove|withdraw|transfer|confirm|결제|구매|결제하기|삭제|제출|확정|송금|출금|주문|支付|付款|购买|删除|提交|确认|转账|提现|下单|pagar|comprar|eliminar|borrar|enviar|confirmar|transferir|retirar|pedido/i;

// ---------------------------------------------------------------- utils

function post(p, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(ENGINE + p);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('failed to parse engine response')); }
      });
    });
    req.on('error', (e) => reject(new Error(`cannot reach engine (${ENGINE}) — ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('engine response timed out')); });
    req.end(data);
  });
}

function loadJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = path.join(JOBS_DIR, f);
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { name: path.basename(f, '.json'), file: p, ...j };
      } catch (e) {
        // 🔴 Never skip a broken job file silently. You have to know why it isn't running.
        console.error(`❌ ${f}: cannot read — ${e.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------- cron parsing

// Standard 5 fields. Supports */n, a-b, a,b,c and *. (Seconds and @macros are not
// supported — better to reject them clearly than to pretend and silently never run.)
function parseField(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1;
    const range = part.split('/')[0];
    if (!Number.isFinite(step) || step < 1) throw new Error(`invalid step: ${part}`);
    let lo = min;
    let hi = max;
    if (range !== '*') {
      if (range.includes('-')) {
        [lo, hi] = range.split('-').map(Number);
      } else {
        lo = Number(range);
        hi = lo;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`out of range: ${part} (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) {
    throw new Error(`cron needs 5 fields (min hour dom month dow): "${expr}"`);
  }
  return {
    min: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    mon: parseField(f[3], 1, 12),
    dow: parseField(f[4], 0, 6),
  };
}

function matches(c, d) {
  return c.min.has(d.getMinutes())
    && c.hour.has(d.getHours())
    && c.dom.has(d.getDate())
    && c.mon.has(d.getMonth() + 1)
    && c.dow.has(d.getDay());
}

function nextRun(c, from) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Look ahead one year only. Past that, the expression simply never fires.
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ---------------------------------------------------------------- execution

function riskyReason(step) {
  // 🔵 One classifier, shared with the engine's per-click gate (sensitiveaction.js), so
  //    "what counts as pay/send/delete" is defined in ONE place instead of drifting between a
  //    cron regex and an engine list. A click/selector goes through classify(); it also names
  //    the KIND (pay/send/delete/…), which we surface so the refusal says what it refused.
  for (const k of ['click', 'selector']) {
    if (!step[k]) continue;
    const v = classify(k === 'click' ? { text: step[k], selector: step[k] } : { selector: step[k] });
    if (v.sensitive) return `${k}: ${step[k]} (${v.kind})`;
  }
  // eval is JS code, not a button — keep scanning it for the same keywords by regex.
  if (step.eval && RISKY.test(step.eval)) return 'risky keyword in eval code';
  return null;
}

// 🔴 A run counts toward dailyMax once a step has gone through. One stopped at its first step
//    (a captcha, an error) did nothing on the site, so the person who fixes it can run it again.
async function runJob(job, opts = {}) {
  const out = await runSteps(job, opts);
  if (!opts.dryRun && job.dailyMax && !out.skipped && (out.ok || out.acted)) countRun(job.name);
  return out;
}

async function runSteps(job, { dryRun = false } = {}) {
  const started = new Date();
  const results = [];
  console.log(`▶ ${job.name} — ${started.toLocaleString()}`);

  if (!Array.isArray(job.steps) || !job.steps.length) {
    console.error('  ❌ steps is empty');
    return { ok: false, why: 'no steps' };
  }
  if (!dryRun && job.dailyMax && runsToday(job.name) >= job.dailyMax) {
    // 🔴 Skipped, and said so — a cap that silently swallows runs looks like a broken schedule.
    console.error(`  ⏭ skipped — already ran ${runsToday(job.name)} time(s) today (dailyMax ${job.dailyMax})`);
    return { ok: false, why: 'dailyMax reached', skipped: true };
  }

  // 🔴 Once an input step has been sent the site may have changed, however the step ended
  //    (an error after its click, a 422 on its typing, no reply) — that run counts.
  let acted = false;
  for (let i = 0; i < job.steps.length; i += 1) {
    const step = job.steps[i];
    const inputStep = ['click', 'type', 'press', 'eval', 'googleLogin'].some((k) => step[k] != null);
    const risk = riskyReason(step);
    if (risk && !job.allowIrreversible) {
      // 🔴 Don't skip it silently. Record why we stopped and abort the whole job.
      console.error(`  ⛔ step ${i + 1} blocked — looks irreversible (${risk})`);
      console.error('     If this is intended, add "allowIrreversible": true to the job file.');
      return { ok: false, why: `risky action blocked: ${risk}`, acted, stopped: i + 1, results };
    }
    if (dryRun) {
      console.log(`  · step ${i + 1} (dry run): ${JSON.stringify(step).slice(0, 90)}`);
      continue;
    }
    try {
      // 🔴 Never vary `agent` between steps — the engine identifies a tab by
      //    (agent, account, tab), so if the name wobbles every call opens a new tab.
      //    Measured (2026-08-24): tabs grew to 8 and the second step timed out.
      const r = await post('/act', {
        agent: AGENT,
        account: job.account,
        tab: job.tab || job.name,
        ...step,
      });
      if (r.error) {
        console.error(`  ❌ step ${i + 1} failed: ${r.error}`);
        return { ok: false, why: r.error, acted: acted || inputStep, stopped: i + 1, results };
      }
      // 🔴 The page wants a person — stop the whole job; never push on or retry.
      if (r.reconnect) {
        const c = r.challenge || {};
        console.error(`  🔴 step ${i + 1}: needs a person (${c.kind}): ${c.reason} — ${c.url || ''}`);
        console.error('     reconnect: true — the job stopped here. Finish it by hand, then run the job again.');
        // A click or keystroke may already have gone through before the page asked — count it.
        acted = acted || (r.done || []).some((s) => (/^(click|type|press|google-login) /.test(s) || s === 'eval' || s === 'eval(failed)'));
        return { ok: false, why: `needs a person: ${c.reason}`, reconnect: true, acted, stopped: i + 1, results };
      }
      // Drop the base64 screenshot from the result — it would make logs several MB
      const { screenshot_b64: shot, ...rest } = r;
      if (shot) rest.screenshot = `(${Math.round(shot.length * 0.75 / 1024)}KB)`;
      results.push(rest);
      acted = acted || inputStep;
      const done = (r.done || []).join(', ');
      const val = r.result !== undefined ? ` → ${JSON.stringify(r.result).slice(0, 80)}` : '';
      console.log(`  ✅ step ${i + 1}: ${done}${val}`);
      const dw = step.goto && i < job.steps.length - 1 ? dwellRange(job) : null;
      if (dw) await sleep(rand(dw[0], dw[1]) * 1000);
    } catch (e) {
      console.error(`  ❌ step ${i + 1} error: ${e.message}`);
      return { ok: false, why: e.message, acted: acted || inputStep, stopped: i + 1, results };
    }
  }

  const secs = ((Date.now() - started.getTime()) / 1000).toFixed(1);
  const v = dryRun ? null : await verifyOutside(job);
  if (v && v !== 'ok') {
    console.error(`  ❌ ${v} (${secs}s)`);
    return { ok: false, why: v, acted, results };
  }
  console.log(`  done (${secs}s)${v ? ' · checked from outside' : ''}`);
  return { ok: true, results };
}

// ---------------------------------------------------------------- commands

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'list' || !cmd) {
    const jobs = loadJobs();
    if (!jobs.length) {
      console.log(`No jobs registered. Create ${JOBS_DIR}/<name>.json.`);
      return 0;
    }
    for (const j of jobs) {
      let sched = j.schedule || '(no schedule — manual runs only)';
      try { if (j.schedule) parseCron(j.schedule); } catch (e) { sched = `🔴 ${e.message}`; }
      console.log(`  ${j.name.padEnd(20)} ${sched}`);
      console.log(`  ${''.padEnd(20)} ${(j.steps || []).length} step(s)`
        + (j.account ? ` · account ${j.account}` : '')
        + (j.allowIrreversible ? ' · 🔴 irreversible actions allowed' : ''));
    }
    return 0;
  }

  if (cmd === 'next') {
    const now = new Date();
    for (const j of loadJobs()) {
      if (!j.schedule) { console.log(`  ${j.name.padEnd(20)} (manual)`); continue; }
      try {
        const n = nextRun(parseCron(j.schedule), now);
        console.log(`  ${j.name.padEnd(20)} ${n ? n.toLocaleString() : 'never fires'}`);
      } catch (e) {
        console.log(`  ${j.name.padEnd(20)} 🔴 ${e.message}`);
      }
    }
    return 0;
  }

  if (cmd === 'run' || cmd === 'dry') {
    const job = loadJobs().find((j) => j.name === arg);
    if (!job) { console.error(`❌ no job named '${arg}'`); return 1; }
    const r = await runJob(job, { dryRun: cmd === 'dry' });
    return r.ok ? 0 : 1;
  }

  if (cmd === 'daemon') {
    const jobs = loadJobs().filter((j) => j.schedule);
    if (!jobs.length) { console.error('no jobs have a schedule'); return 1; }
    for (const j of jobs) {
      try { j._cron = parseCron(j.schedule); } catch (e) {
        console.error(`🔴 ${j.name}: ${e.message} — this job will not run`);
      }
    }
    console.log(`wbrowser cron — watching ${jobs.filter((j) => j._cron).length} job(s)`);

    let lastMinute = -1;
    // 🔵 One queue: a job never starts while another is running (no two accounts at once).
    let queue = Promise.resolve();
    setInterval(() => {
      const now = new Date();
      // Never fire twice within the same minute (safe even if several ticks land)
      if (now.getMinutes() === lastMinute) return;
      lastMinute = now.getMinutes();
      for (const j of jobs) {
        if (!j._cron || !matches(j._cron, now)) continue;
        // 🔵 Not on the dot: a random 0–jitterMinutes delay before it joins the queue.
        const jit = (j.jitterMinutes == null ? 10 : Number(j.jitterMinutes) || 0) * 60000 * Math.random();
        console.log(`· ${j.name} due — starts in ${Math.round(jit / 1000)}s (jitter)`);
        setTimeout(() => {
          queue = queue.then(() => runJob(j)).catch((e) => { console.error(`❌ ${j.name}: ${e.message}`); });
        }, jit);
      }
    }, 20000);   // check every 20s — so a minute boundary is never missed
    return new Promise(() => {});   // stay alive
  }

  // 🔴 Don't slice by line number — that silently truncates (or leaks code into)
  //    the help text the moment someone edits the header block. Read until the
  //    comment block ends instead, so the coupling is explicit and self-correcting.
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  const header = [];
  for (let i = 1; i < src.length; i += 1) {
    if (!src[i].startsWith('//')) break;
    header.push(src[i]);
  }
  console.log(header
    .map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  return 0;
}

main().then((c) => { if (typeof c === 'number') process.exit(c); })
  .catch((e) => { console.error('FATAL', e.message); process.exit(1); });
