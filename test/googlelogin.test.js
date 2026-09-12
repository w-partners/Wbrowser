// Finding a "Sign in with Google" button across sites. Pure patterns — no browser.
const test = require('node:test');
const assert = require('node:assert');
const { textMatches, candidateStrategies, ATTR_SELECTORS } = require('../googlelogin.js');

test('matches common English Google sign-in labels', () => {
  for (const t of ['Sign in with Google', 'Continue with Google', 'Log in with Google']) {
    assert.ok(textMatches(t.toLowerCase()), `should match: ${t}`);
  }
});

test('matches Korean labels', () => {
  assert.ok(textMatches('google 계정으로 로그인'));
  assert.ok(textMatches('구글로 로그인'));
});

test('does NOT match unrelated text that merely contains "google"', () => {
  assert.ok(!textMatches('this site uses google analytics'));
  assert.ok(!textMatches('google is a search engine'));
});

test('structural selectors are tried before text (more precise first)', () => {
  const strat = candidateStrategies();
  const firstText = strat.findIndex((s) => s.kind === 'text');
  const lastSel = strat.map((s) => s.kind).lastIndexOf('selector');
  assert.ok(lastSel < firstText, 'all selector strategies must come before any text strategy');
});

test('the GSI official-widget container is among the selectors', () => {
  assert.ok(ATTR_SELECTORS.some((s) => s.includes('g_id_signin')));
});

test('empty text never matches', () => {
  assert.ok(!textMatches(''));
  assert.ok(!textMatches('   '));
});
