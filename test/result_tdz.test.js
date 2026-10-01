// `result` must be declared before any handler writes to it.
//
// 🔴 Why this test exists (2026-10-01): collect, video (page form) and google-login were ALL
//    returning 500 "Cannot access 'result' before initialization" on the main path, while
//    `read` passed. Three shipped features were completely dead and three releases went out
//    on top of them, because:
//      · the fallback path has its own `result` on line 1 of its function, so the same
//        handler code worked there — which made the failure look site-specific;
//      · every test we had was a PURE test (fake DOMs, no engine), and this bug lives in the
//        engine's variable ordering, which no pure test can see;
//      · `read` kept working, so `/health` and a casual probe both looked fine.
//    It took a user reporting "the engine is hung" to surface it.
//
// This test reads engine.js as TEXT and checks the ordering. No Chrome, no engine process —
// it must stay runnable in CI and on a laptop, because the whole point is to catch this
// before a release rather than after one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
const LINES = SRC.split('\n');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// Find a function body by its declaration line, up to the next top-level `}`.
function bodyOf(declPrefix) {
  const start = LINES.findIndex((l) => l.startsWith(declPrefix));
  assert.ok(start >= 0, `${declPrefix} not found in engine.js`);
  let end = LINES.length - 1;
  for (let i = start + 1; i < LINES.length; i += 1) {
    if (LINES[i] === '}') { end = i; break; }
  }
  return { start, end, lines: LINES.slice(start, end + 1), offset: start };
}

// 🔴 Comments mention `result.<x>` while explaining this very bug, and counting them makes
//    the test fail on a correct file — a false alarm that gets the test deleted rather than
//    the bug fixed. Strip comment lines before looking for uses.
function isCode(line) {
  const t = line.trim();
  return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}

// First line index (absolute) matching a predicate inside a body, code lines only.
function firstIn(body, re) {
  const i = body.lines.findIndex((l) => isCode(l) && re.test(l));
  return i < 0 ? -1 : i + body.offset;
}

console.log('result TDZ (engine.js structure):');

for (const fnName of ['async function act(', 'async function actViaRawCDP(']) {
  check(`${fnName.replace('async function ', '').replace('(', '')}: result is declared before first use`, () => {
    const body = bodyOf(fnName);
    const declared = firstIn(body, /^\s*(const|let)\s+result\s*=/);
    assert.ok(declared >= 0, 'no `result` declaration found');

    // First *use* that is not the declaration itself.
    let used = -1;
    for (let i = 0; i < body.lines.length; i += 1) {
      const line = body.lines[i];
      if (!isCode(line)) continue;
      if (/^\s*(const|let)\s+result\s*=/.test(line)) continue;
      if (/\bresult\s*\./.test(line) || /\bObject\.assign\(result\b/.test(line)) {
        used = i + body.offset; break;
      }
    }
    if (used < 0) return; // nothing writes to it in this function
    assert.ok(declared < used,
      `declared at line ${declared + 1} but first used at line ${used + 1} — `
      + 'const has a temporal dead zone, so every request hitting that handler throws '
      + '"Cannot access \'result\' before initialization"');
  });
}

check('act(): result is declared exactly once (a second `const` would drop handler output)', () => {
  const body = bodyOf('async function act(');
  const decls = body.lines.filter((l) => /^\s*(const|let)\s+result\s*=/.test(l));
  assert.strictEqual(decls.length, 1,
    `found ${decls.length} declarations — a re-declaration replaces the object that `
    + 'collect/video/googleLogin already wrote into, silently discarding their output. '
    + 'Merge with Object.assign instead.');
});

check('act(): the reply assembly merges rather than replaces', () => {
  const body = bodyOf('async function act(');
  const hasMerge = body.lines.some((l) => /Object\.assign\(result,\s*\{\s*tab/.test(l));
  assert.ok(hasMerge,
    'expected `Object.assign(result, { tab, ... })` where the reply is assembled; '
    + 'a fresh `const result = { tab, ... }` there would discard handler output');
});

// 🔵 The handlers this actually protects. Named so a future edit that moves one of them
//    above the declaration fails here with a useful message instead of in production.
check('handlers that write result.* all sit after the declaration', () => {
  const body = bodyOf('async function act(');
  const declared = firstIn(body, /^\s*(const|let)\s+result\s*=/);
  for (const prop of ['result.collect', 'result.video', 'result.googleLogin']) {
    const at = firstIn(body, new RegExp(prop.replace('.', '\\.')));
    if (at < 0) continue;
    assert.ok(at > declared, `${prop} at line ${at + 1} is before the declaration at ${declared + 1}`);
  }
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
