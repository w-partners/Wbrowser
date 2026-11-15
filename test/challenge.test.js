const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../challenge');

const page = (o) => ({ url: 'https://shop.example.com/item', title: 'Item', text: 'Buy now', textLength: 7, frames: [], ...o });

test('an ordinary page is not a challenge', () => {
  assert.equal(classify(page()), null);
});

test('a visible reCAPTCHA / hCaptcha / Cloudflare frame is a captcha', () => {
  for (const f of ['https://www.google.com/recaptcha/api2/anchor?k=x', 'https://www.recaptcha.net/recaptcha/api2/anchor?k=x', 'https://newassets.hcaptcha.com/captcha/v1/x', 'https://challenges.cloudflare.com/cdn-cgi/x']) {
    assert.equal(classify(page({ frames: [f] })).kind, 'captcha');
  }
});

test('Korean and English captcha / block / second-factor wording on a short page', () => {
  assert.equal(classify(page({ text: '자동입력 방지 문자를 입력해 주세요' })).kind, 'captcha');
  assert.equal(classify(page({ text: '회원님의 계정에 보호조치가 적용되었습니다' })).kind, 'blocked');
  assert.equal(classify(page({ text: '2단계 인증 — 휴대폰으로 받은 인증번호를 입력', inputs: 1 })).kind, 'verification');
  assert.equal(classify(page({ text: "Access Denied You don't have permission. Reference #18.abc" })).kind, 'blocked');
});

test('the same words in a long article do not stop work', () => {
  const long = `How 2단계 인증 works. ${'x'.repeat(5000)}`;
  assert.equal(classify(page({ text: long.slice(0, 6000), textLength: long.length })), null);
});

test('challenge URLs', () => {
  assert.equal(classify(page({ url: 'https://www.google.com/sorry/index?continue=x' })).kind, 'captcha');
  assert.equal(classify(page({ url: 'https://www.facebook.com/checkpoint/123' })).kind, 'blocked');
  assert.equal(classify(page({ url: 'https://en.wikipedia.org/wiki/CAPTCHA' })), null);   // an article about captchas
  assert.equal(classify(page({ url: 'https://x.com/account/access' })).kind, 'blocked');
  assert.equal(classify(page({ url: 'https://www.netflix.com/account/access' })), null);   // ends in "x.com", is not X
  assert.equal(classify(page({ url: 'https://notfacebook.com/checkpoint/1' })), null);
  assert.equal(classify(page({ url: 'https://m.facebook.com/checkpoint/1' })).kind, 'blocked');
  assert.equal(classify(page({ url: 'https://example.com/challenge/42' })), null);   // a coding challenge, not a captcha
  assert.equal(classify(page({ url: 'https://example.com/challenges-of-2026' })), null);
});

test('a captcha the person already solved does not stop work', () => {
  const f = ['https://www.google.com/recaptcha/api2/anchor?k=x'];
  assert.equal(classify(page({ frames: f, solved: true })), null);
  assert.equal(classify(page({ frames: f, solved: false })).kind, 'captcha');
});

test('a signup form that merely asks for identity checking is not a second factor', () => {
  assert.equal(classify(page({ text: '회원가입 · 본인 확인 · 추가 인증 · verification code 받기' })), null);
});

test('a page that only talks about 2-step verification, with no box for a code, is not stopped', () => {
  assert.equal(classify(page({ text: 'Security settings · 2-step verification: On', inputs: 0 })), null);
});

test('check: a page that never answers is said so, not read as clear; a self-passing widget gets a second look', async () => {
  const { check } = require('../challenge');
  const notes = [];
  assert.equal(await check(async () => null, (n) => notes.push(n)), null);
  assert.match(notes[0], /could not check/);
  const shots = [page({ frames: ['https://challenges.cloudflare.com/x'] }), page({ frames: ['https://challenges.cloudflare.com/x'], solved: true })];
  assert.equal(await check(async () => shots.shift(), () => {}), null);
  const stuck = page({ frames: ['https://challenges.cloudflare.com/x'] });
  assert.equal((await check(async () => stuck, () => {})).kind, 'captcha');
});
