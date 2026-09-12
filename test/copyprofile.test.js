// Seeding the wbrowser profile from the user's real Chrome profile (logins/passwords come along).
// planCopy is pure — we drive it with a fake exists() so it runs with no filesystem or browser.
const test = require('node:test');
const assert = require('node:assert');
const { planCopy, SEED_FILES } = require('../copyprofile.js');

// a fake filesystem: a Set of paths that "exist"
const fsOf = (paths) => (p) => paths.has(p);

test('copies a login file that exists in src and is missing in dst', () => {
  const src = '/orig', dst = '/wb';
  const present = new Set([`${src}/Default/Cookies`, `${src}/Default/Login Data`]);
  const { plan } = planCopy(src, dst, 'Default', fsOf(present));
  const tos = plan.map((p) => p.to);
  assert.ok(tos.includes(`${dst}/Default/Cookies`));
  assert.ok(tos.includes(`${dst}/Default/Login Data`));
});

test('seed-only: never overwrites a file already in dst (live session preserved)', () => {
  const src = '/orig', dst = '/wb';
  const present = new Set([`${src}/Default/Cookies`, `${dst}/Default/Cookies`]);  // dst already has it
  const { plan } = planCopy(src, dst, 'Default', fsOf(present));
  assert.ok(!plan.some((p) => p.to === `${dst}/Default/Cookies`),
    'must not overwrite an existing dst file');
});

test('reports source files that are absent (no logins to bring)', () => {
  const src = '/orig', dst = '/wb';
  const { plan, missingSrc } = planCopy(src, dst, 'Default', fsOf(new Set()));  // nothing exists
  assert.strictEqual(plan.length, 0);
  assert.ok(missingSrc.includes('Cookies') && missingSrc.includes('Login Data'));
});

test('honours a non-Default inner profile folder (Profile 1 etc.)', () => {
  const src = '/orig', dst = '/wb';
  const present = new Set([`${src}/Profile 1/Login Data`]);
  const { plan } = planCopy(src, dst, 'Profile 1', fsOf(present));
  assert.ok(plan.some((p) => p.to === `${dst}/Profile 1/Login Data`));
});

test('Local State (profile list) is seeded from the root, not the inner folder', () => {
  const src = '/orig', dst = '/wb';
  const present = new Set([`${src}/Local State`]);
  const { plan } = planCopy(src, dst, 'Default', fsOf(present));
  assert.ok(plan.some((p) => p.from === `${src}/Local State` && p.to === `${dst}/Local State`));
});
