// The benchmark scorer. Pure — a benchmark whose scoring you cannot rerun is not a benchmark.

const { test } = require('node:test');
const assert = require('node:assert');

const { TASKS, score } = require('../bench/tasks.js');

test('score counts passing checks into a rate', () => {
  const r = score([{ id: 'a', ok: true }, { id: 'b', ok: false }, { id: 'c', ok: true }]);
  assert.deepEqual(r, { passed: 2, total: 3, rate: 2 / 3 });
});

test('an all-pass run scores 1.0, an all-fail run scores 0', () => {
  assert.equal(score([{ ok: true }, { ok: true }]).rate, 1);
  assert.equal(score([{ ok: false }, { ok: false }]).rate, 0);
});

test('an empty run is 0, not NaN', () => {
  assert.equal(score([]).rate, 0);
});

test('every task has an id, steps and a check — the set is well-formed', () => {
  assert.ok(TASKS.length >= 5, 'the task set is too small to be meaningful');
  const ids = new Set();
  for (const t of TASKS) {
    assert.ok(t.id && !ids.has(t.id), `duplicate or missing task id: ${t.id}`);
    ids.add(t.id);
    assert.ok(Array.isArray(t.steps) && t.steps.length, `${t.id}: no steps`);
    assert.equal(typeof t.check, 'function', `${t.id}: no check`);
  }
});

test('non-array results are refused', () => {
  assert.throws(() => score('nope'));
});
