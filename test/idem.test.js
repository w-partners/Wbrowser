const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.WBROWSER_IDEM_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idem-')), 'idem.json');
const idem = require('../idem');

test('a key runs once; the second ask gets the stored reply without running', () => {
  assert.equal(idem.begin('post-1').state, 'new');
  assert.equal(idem.begin('post-1').state, 'running');
  idem.finish('post-1', { done: ['click'], screenshot_b64: 'big' });
  const r = idem.begin('post-1');
  assert.equal(r.state, 'done');
  assert.deepEqual(r.result, { done: ['click'] });
});

test('a failed run frees the key', () => {
  assert.equal(idem.begin('post-2').state, 'new');
  idem.fail('post-2');
  assert.equal(idem.begin('post-2').state, 'new');
});

test('a run left by a dead engine is unknown, not new', () => {
  const db = JSON.parse(fs.readFileSync(idem.FILE, 'utf8'));
  db['post-3'] = { state: 'running', at: Date.now(), boot: 'dead-engine' };
  fs.writeFileSync(idem.FILE, JSON.stringify(db));
  assert.equal(idem.begin('post-3').state, 'unknown');
});

test('bad keys are refused', () => {
  assert.throws(() => idem.begin(''), /non-empty/);
  assert.throws(() => idem.begin('x'.repeat(201)), /200/);
});

test('a run that acted and then stopped stays unknown until a person forgets it', () => {
  idem.begin('post-u');
  idem.unsure('post-u');
  assert.equal(idem.begin('post-u').state, 'unknown');
  assert.equal(idem.begin('post-u').state, 'unknown');
  idem.forget('post-u');
  assert.equal(idem.begin('post-u').state, 'new');
});

test('the record file is owner-only, and a corrupt one is refused rather than read as empty', () => {
  idem.begin('post-m');
  assert.equal(fs.statSync(idem.FILE).mode & 0o777, 0o600);
  const keep = fs.readFileSync(idem.FILE, 'utf8');
  fs.writeFileSync(idem.FILE, '{broken');
  assert.throws(() => idem.begin('post-m'), (e) => e.status === 500);
  fs.writeFileSync(idem.FILE, keep);
});

test('forget checks the key and will not clear a run that is still going', () => {
  assert.throws(() => idem.forget(undefined), (e) => e.status === 400);
  assert.equal(idem.forget('never-seen').forgotten, false);
  idem.begin('post-r');
  assert.throws(() => idem.forget('post-r'), (e) => e.status === 409);
  idem.finish('post-r', {});
  assert.equal(idem.forget('post-r').forgotten, true);
});

test('a record older than 7 days is forgotten even if nothing pruned the file', () => {
  const db = JSON.parse(fs.readFileSync(idem.FILE, 'utf8'));
  db['weekly'] = { state: 'done', at: Date.now() - 8 * 86400000, result: { done: ['old'] } };
  fs.writeFileSync(idem.FILE, JSON.stringify(db));
  assert.equal(idem.begin('weekly').state, 'new');
});
