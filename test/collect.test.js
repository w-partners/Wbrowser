// collect.js — the pure parts, tested without a browser.
//
// Pinned because each one already had a way to be silently wrong:
//   · metric parsing: the buttons say "2.5K", the aria-label says 2587. Reading the
//     buttons loses 87 likes and nothing complains.
//   · dedupe: X re-renders the same posts while you scroll, so a run without dedupe
//     returns 15 posts seven times and reports 105.
//   · date window: "last 30 days" that is off by one drops or invents a day of data,
//     and the caller cannot tell from the output.
//   · unknown date: dropping a post because we could not parse its time is data loss
//     disguised as filtering — keep it and let the caller see.
const assert = require('assert');
const col = require('../collect');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('collect.js:');

check('parses the real X aria-label exactly (measured 2026-09-27)', () => {
  const m = col.parseXMetrics('48 replies, 538 reposts, 2587 likes, 4508 bookmarks, 198913 views');
  assert.deepStrictEqual(m, { replies: 48, reposts: 538, likes: 2587, bookmarks: 4508, views: 198913 });
});

check('exact numbers, not the abbreviated button text', () => {
  const m = col.parseXMetrics('2587 likes');
  assert.strictEqual(m.likes, 2587, 'must be 2587, never 2.5K → 2500');
});

check('handles thousands separators', () => {
  assert.strictEqual(col.parseXMetrics('1,234 likes').likes, 1234);
  assert.strictEqual(col.parseXMetrics('1 234 views').views, 1234);
});

check('a missing metric stays absent — never invented as 0', () => {
  const m = col.parseXMetrics('3 replies');
  assert.strictEqual(m.replies, 3);
  assert.ok(!('likes' in m), 'a metric we did not see must not appear as 0');
});

check('a null/garbage label yields {} rather than throwing', () => {
  assert.deepStrictEqual(col.parseXMetrics(null), {});
  assert.deepStrictEqual(col.parseXMetrics(''), {});
  assert.deepStrictEqual(col.parseXMetrics('no numbers here'), {});
});

check('retweet wording maps to reposts', () => {
  assert.strictEqual(col.parseXMetrics('5 retweets').reposts, 5);
});

check('withinDays keeps recent, drops old', () => {
  const now = Date.now();
  const recent = new Date(now - 2 * 86400000).toISOString();
  const old = new Date(now - 60 * 86400000).toISOString();
  assert.strictEqual(col.withinDays(recent, 30), true);
  assert.strictEqual(col.withinDays(old, 30), false);
});

check('no window given → everything is kept', () => {
  assert.strictEqual(col.withinDays('2001-01-01T00:00:00Z', null), true);
});

check('an unparseable date is KEPT, not silently dropped', () => {
  assert.strictEqual(col.withinDays('not-a-date', 30), true);
});

check('platformFor recognises x.com and twitter.com, rejects lookalikes', () => {
  assert.strictEqual(col.platformFor('https://x.com/someone').name, 'x');
  assert.strictEqual(col.platformFor('https://twitter.com/someone').name, 'x');
  assert.strictEqual(col.platformFor('https://example.com/x.com'), null);
  assert.strictEqual(col.platformFor('https://notx.com/a'), null);
});

check('mergeRows drops duplicate ids across batches', () => {
  const shape = col.PLATFORMS.x.shape;
  const seen = new Set(); const out = [];
  const batch = [
    { id: '1', url: 'u1', author: 'a', at: new Date().toISOString(), text: 'one', metricsLabel: '1 likes' },
    { id: '2', url: 'u2', author: 'a', at: new Date().toISOString(), text: 'two', metricsLabel: '2 likes' },
  ];
  assert.strictEqual(col.mergeRows(seen, out, batch, shape, null), 2);
  // the same batch again — what scrolling actually produces
  assert.strictEqual(col.mergeRows(seen, out, batch, shape, null), 0);
  assert.strictEqual(out.length, 2, 'a re-rendered batch must not grow the result');
});

check('mergeRows skips rows with no id (nothing to dedupe on)', () => {
  const seen = new Set(); const out = [];
  col.mergeRows(seen, out, [{ id: null, text: 'x' }], col.PLATFORMS.x.shape, null);
  assert.strictEqual(out.length, 0);
});

check('mergeRows applies the day window', () => {
  const shape = col.PLATFORMS.x.shape;
  const seen = new Set(); const out = [];
  col.mergeRows(seen, out, [
    { id: 'new', at: new Date().toISOString(), text: 'recent', metricsLabel: '' },
    { id: 'old', at: new Date(Date.now() - 90 * 86400000).toISOString(), text: 'old', metricsLabel: '' },
  ], shape, 30);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'new');
});

check('shape() lifts metrics up and omits empty media keys', () => {
  const r = col.PLATFORMS.x.shape({
    id: '9', url: 'https://x.com/a/status/9', author: 'a', at: '2026-09-15T13:56:25.000Z',
    text: 'hello', metricsLabel: '48 replies, 2587 likes', images: [], videos: [],
  });
  assert.strictEqual(r.likes, 2587);
  assert.strictEqual(r.replies, 48);
  assert.strictEqual(r.images, undefined, 'empty media must not appear as []');
  assert.strictEqual(r.videos, undefined);
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
