// idem.js — one key, one run. A command sent with `idem: "<key>"` runs at most once.
//
// 🔴 Why: a client that times out cannot tell "it failed" from "it is still going" or "it
//    worked and the reply got lost". Retrying blind submits twice — two posts, two orders.
//    With a key the engine answers instead:
//      done    → the stored reply of the run that finished (nothing runs again)
//      running → 409, the first run is still going; ask again later
//      unknown → 409, a run started and the engine stopped before it finished, so nobody knows
//                whether it took effect. A person checks the site; `forget` clears the key.
//      failed  → not stored, but only when it failed before clicking or typing anything; one that
//                failed or stopped for a person after input started is marked unknown (above).
// 🔵 Records live in a file so an engine restart does not forget them; kept for KEEP_DAYS.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = process.env.WBROWSER_IDEM_FILE || path.join(os.homedir(), '.wbrowser', 'idem.json');
const KEEP_DAYS = 7;
const BOOT = `${process.pid}-${Date.now()}`;      // tells this engine's runs from a dead one's

// 🔴 A missing file is an empty record; an unreadable one is an error — treating it as empty
//    would forget every key and run them all again.
function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  try { return JSON.parse(raw); } catch {
    const err = new Error(`idem: ${FILE} is not valid JSON — refusing to run keyed commands rather than forget every key. Fix or remove the file.`);
    err.status = 500;
    throw err;
  }
}
function save(db) {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const k of Object.keys(db)) if ((db[k].at || 0) < cutoff) delete db[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 🔴 Owner-only: a stored reply can hold what the page showed (eval results, page text).
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}

function check(key) {
  // __proto__ and friends are not keys a plain object can hold — they would silently not be recorded.
  if (typeof key !== 'string' || !key || key.length > 200 || key in Object.prototype) {
    const err = new Error('idem: the key must be a non-empty string of at most 200 characters, and not a name like __proto__');
    err.status = 400;
    throw err;
  }
}

// Returns { state: 'new' } (and records the run as started) or the existing record.
function begin(key) {
  check(key);
  const db = load();
  const r = db[key];
  const fresh = r && (r.at || 0) >= Date.now() - KEEP_DAYS * 86400000;   // older is forgotten, as promised
  if (fresh && (r.state === 'done' || r.state === 'unknown')) return r;
  if (fresh && r.state === 'running') return r.boot === BOOT ? r : { ...r, state: 'unknown' };
  db[key] = { state: 'running', at: Date.now(), boot: BOOT };
  save(db);
  return { state: 'new' };
}

function finish(key, result) {
  const db = load();
  const { screenshot_b64: _drop, ...kept } = result || {};   // a screenshot is not worth keeping a week
  db[key] = { state: 'done', at: Date.now(), result: kept };
  save(db);
}

function fail(key) {
  const db = load();
  delete db[key];
  save(db);
}

function unsure(key) {
  const db = load();
  db[key] = { state: 'unknown', at: Date.now() };
  save(db);
}

// 🔴 For a person who checked the site. Refuses a run that is still going in this engine —
//    clearing it would let the same key start a second run alongside the first.
function forget(key) {
  check(key);
  const db = load();
  const r = db[key];
  if (!r) return { forgotten: false, why: 'no such key' };
  if (r.state === 'running' && r.boot === BOOT) {
    const err = new Error(`idem "${key}": a run with this key is still going — wait for it to finish`);
    err.status = 409;
    throw err;
  }
  delete db[key];
  save(db);
  return { forgotten: true, was: r.state };
}

module.exports = { begin, finish, fail, unsure, forget, FILE };
