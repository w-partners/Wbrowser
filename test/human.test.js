// human.js — the shape of the input stream is what bot defences score, so pin the shape.
const test = require('node:test');
const assert = require('assert');
const human = require('../human');
const identity = require('../identity');

test('mouse path ends exactly on the target, bends, and takes many steps', () => {
  const from = { x: 10, y: 10 }; const to = { x: 600, y: 400 };
  const p = human.mousePath(from, to);
  assert.ok(p.length >= 8, 'a teleport (1 step) is the tell we are avoiding');
  assert.deepStrictEqual({ x: p.at(-1).x, y: p.at(-1).y }, to);
  // Not a straight line: some point sits off the from→to line.
  const off = p.map(({ x, y }) => Math.abs((to.y - from.y) * x - (to.x - from.x) * y + to.x * from.y - to.y * from.x)
    / Math.hypot(to.x - from.x, to.y - from.y));
  assert.ok(Math.max(...off) > 1, 'path must curve');
  assert.ok(p.every((s) => s.wait > 0), 'each step takes time');
});

test('key delays stay within 50–150ms and are not constant', () => {
  const d = Array.from({ length: 200 }, human.keyDelay);
  assert.ok(d.every((x) => x >= 50 && x <= 150));
  assert.ok(new Set(d).size > 10, 'an even beat is a bot tell');
});

test('click point lands inside the box, away from the edges', () => {
  const box = { x: 100, y: 200, width: 40, height: 20 };
  for (let i = 0; i < 100; i += 1) {
    const { x, y } = human.pointIn(box);
    assert.ok(x >= 112 && x <= 128 && y >= 206 && y <= 214);
  }
});

test('mobile switch only on m.* hosts', () => {
  assert.ok(identity.isMobileHost('https://m.example.com/products/1'));
  assert.ok(!identity.isMobileHost('https://www.example.com/'));
  assert.ok(!identity.isMobileHost('https://mail.google.com/'));
  assert.ok(!identity.isMobileHost('not a url'));
});

test('headless override removes the HeadlessChrome tell only', () => {
  const v = { major: '149', full: '149.0.7827.196', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36' };
  const d = identity.overrideFor('desktop', v);
  assert.ok(!/Headless/.test(d.userAgent) && /Chrome\/149/.test(d.userAgent));
  assert.ok(!d.userAgentMetadata.brands.some((b) => /Headless/.test(b.brand)));
  const m = identity.overrideFor('mobile', v);
  assert.ok(/Android/.test(m.userAgent) && m.userAgentMetadata.mobile === true);
});

test('brand list matches what Chrome 149 itself sends (measured)', () => {
  const b = identity.brands('149', '149.0.7827.196');
  assert.deepStrictEqual(b.brands, [
    { brand: 'Google Chrome', version: '149' }, { brand: 'Chromium', version: '149' }, { brand: 'Not)A;Brand', version: '24' }]);
  assert.deepStrictEqual(b.fullVersionList.map((x) => x.version), ['149.0.7827.196', '149.0.7827.196', '24.0.0.0']);
});

test('long text tightens key spacing so typing fits the request limit', () => {
  for (const n of [10, 300, 2000, 10000]) {
    const total = Array.from({ length: n }, () => human.keyDelay(n)).reduce((a, b) => a + b, 0);
    assert.ok(total < 45000, `${n} chars took ${total}ms`);
  }
  assert.ok(!human.tightened(300) && human.tightened(301));
});

// A fake /json/version so switchTo runs its real logic.
const http = require('http');
function fakeCdp(ua) {
  return new Promise((res) => {
    const srv = http.createServer((q, r) => r.end(JSON.stringify({ Browser: 'Chrome/149.0.7827.196', 'User-Agent': ua })))
      .listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}
const HEADED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36';

test('switchTo: phone on m., back to desktop after, nothing on a plain headed goto', async () => {
  const cdp = await fakeCdp(HEADED);
  try {
    const calls = []; const send = async (m, p) => { calls.push([m, p]); };
    assert.strictEqual((await identity.switchTo(send, 'https://www.example.com/', cdp.base, null)).mode, null);
    assert.strictEqual(calls.length, 0, 'a headed desktop goto must not touch the tab');
    assert.strictEqual((await identity.switchTo(send, 'https://m.example.com/', cdp.base, null)).mode, 'mobile');
    assert.ok(calls.some(([m, p]) => m === 'Emulation.setDeviceMetricsOverride' && p.mobile));
    calls.length = 0;
    assert.strictEqual((await identity.switchTo(send, 'https://www.example.com/', cdp.base, 'mobile')).mode, null);
    assert.deepStrictEqual(calls.map(([m]) => m), ['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setUserAgentOverride']);
    assert.strictEqual(calls[2][1].userAgent, '', 'the UA override is cleared');
  } finally { cdp.close(); }
});

test('switchTo: headless gets its own UA minus the HeadlessChrome tell', async () => {
  const cdp = await fakeCdp(HEADLESS);
  try {
    const calls = []; const send = async (m, p) => { calls.push([m, p]); };
    assert.strictEqual((await identity.switchTo(send, 'https://www.example.com/', cdp.base, null)).mode, 'desktop');
    const ua = calls.find(([m]) => m === 'Emulation.setUserAgentOverride')[1];
    assert.strictEqual(ua.userAgent, HEADLESS.replace('HeadlessChrome/', 'Chrome/'));
    assert.strictEqual(ua.userAgentMetadata.platform, 'Linux');
  } finally { cdp.close(); }
});

test('launch refuses a proxy it cannot use, before starting anything', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const run = (proxy) => spawnSync(process.execPath, [path.join(__dirname, '..', 'launch.js')], {
    env: { ...process.env, WBROWSER_PROXY: proxy, WBROWSER_CDP_PORT: '1' }, encoding: 'utf8', timeout: 20000 });
  const creds = run('http://user:pass@127.0.0.1:8000');
  assert.strictEqual(creds.status, 1); assert.match(creds.stderr, /username\/password/);
  const bad = run('ftp://127.0.0.1:21');
  assert.strictEqual(bad.status, 1); assert.match(bad.stderr, /not a proxy URL/);
});

test('headless override carries the full hint set (measured on Chrome 149 Linux)', async () => {
  const cdp = await fakeCdp(HEADLESS);
  try {
    const calls = []; await identity.switchTo(async (m, p) => { calls.push([m, p]); }, 'https://www.example.com/', cdp.base, null);
    const md = calls.find(([m]) => m === 'Emulation.setUserAgentOverride')[1].userAgentMetadata;
    assert.deepStrictEqual({ a: md.architecture, b: md.bitness, v: md.platformVersion, w: md.wow64, f: md.formFactors },
      { a: 'x86', b: '64', v: '', w: false, f: ['Desktop'] });
  } finally { cdp.close(); }
});

test('headless on a system whose hints we cannot reproduce: no invented UA, but a phone is still undone', async () => {
  const cdp = await fakeCdp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36');
  try {
    const calls = []; const send = async (m, p) => { calls.push([m, p]); };
    const r = await identity.switchTo(send, 'https://www.example.com/', cdp.base, null);
    assert.strictEqual(r.mode, null); assert.match(r.note, /cannot be reproduced/);
    assert.strictEqual(calls.length, 0, 'nothing set from a clean tab');
    const back = await identity.switchTo(send, 'https://www.example.com/', cdp.base, 'mobile');
    assert.strictEqual(back.mode, null);
    assert.deepStrictEqual(calls.map(([m]) => m), ['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setUserAgentOverride']);
    assert.strictEqual(calls[2][1].userAgent, '', 'the phone UA is cleared, not replaced with an invented one');
  } finally { cdp.close(); }
});

test('a switch that failed halfway is re-applied in full next time', async () => {
  const cdp = await fakeCdp(HEADED);
  try {
    const calls = [];
    let fail = true;
    const session = { send: async (m, p) => { calls.push(m); if (fail && m === 'Emulation.setDeviceMetricsOverride') throw new Error('tab closing'); } };
    const page = { context: () => ({ newCDPSession: async () => session }) };
    await assert.rejects(identity.apply(page, 'https://m.example.com/', cdp.base));
    fail = false; calls.length = 0;
    assert.strictEqual((await identity.apply(page, 'https://www.example.com/', cdp.base)).mode, null);
    assert.ok(calls.includes('Emulation.setUserAgentOverride'), 'the half-set mobile UA must be cleared');
    assert.ok(calls.includes('Emulation.clearDeviceMetricsOverride'));
  } finally { cdp.close(); }
});
