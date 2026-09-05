// The benchmark runner's step->command mapping. Pure and testable; the actual browser drive
// (main()) rides the same headless setup as scripts/e2e.sh.

const { test } = require('node:test');
const assert = require('node:assert');

const { stepToCmd } = require('../bench/run.js');

test('go maps to goto+read with the fixture base prepended', () => {
  const cmd = stepToCmd({ op: 'go', args: ['/basic'] });
  assert.equal(cmd.read, true);
  assert.match(cmd.goto, /\/basic$/);
  assert.match(cmd.goto, /^http:\/\/127\.0\.0\.1:/);
});

test('type maps to a type command carrying selector and text', () => {
  const cmd = stepToCmd({ op: 'type', args: ['#name', 'benchbot'] });
  assert.deepEqual(cmd.type, { selector: '#name', text: 'benchbot' });
});

test('click waits then reads', () => {
  const cmd = stepToCmd({ op: 'click', args: ['#go'] });
  assert.equal(cmd.click, '#go');
  assert.ok(cmd.wait > 0 && cmd.read === true);
});

test('shot maps to a screenshot request', () => {
  assert.deepEqual(stepToCmd({ op: 'shot', args: [] }), { shot: true });
});

test('an unknown op is refused, not silently dropped', () => {
  assert.throws(() => stepToCmd({ op: 'teleport', args: [] }));
});
