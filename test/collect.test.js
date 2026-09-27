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

// ---- Reddit --------------------------------------------------------------
// Reddit hands everything over as attributes, so the risk is not parsing — it is
// type coercion. An attribute is always a string; "176" must land as a number or every
// sort downstream compares text ("9" > "176").

check('reddit: attributes become numbers, not strings', () => {
  const r = col.PLATFORMS.reddit.shape({
    id: 't3_1wrjlls', permalink: '/r/LocalLLaMA/comments/1wrjlls/x/', author: 'speedb0at',
    at: '2026-09-27T12:58:39.380000+0000', title: 'T', text: 'b',
    score: '176', comments: '52', ratio: '0.9356', subreddit: 'r/LocalLLaMA',
  });
  assert.strictEqual(r.score, 176);
  assert.strictEqual(r.comments, 52);
  assert.ok(Math.abs(r.upvoteRatio - 0.9356) < 1e-9);
  assert.strictEqual(r.url, 'https://www.reddit.com/r/LocalLLaMA/comments/1wrjlls/x/');
});

check('reddit: a missing score is absent, not 0', () => {
  const r = col.PLATFORMS.reddit.shape({ id: 't3_a', score: null, comments: undefined });
  assert.ok(!('score' in r) || r.score === undefined, 'a score we did not see must not be 0');
  assert.strictEqual(r.comments, undefined);
});

check('reddit: host matching accepts subdomains, rejects lookalikes', () => {
  assert.strictEqual(col.platformFor('https://www.reddit.com/r/x/').name, 'reddit');
  assert.strictEqual(col.platformFor('https://old.reddit.com/r/x/').name, 'reddit');
  assert.strictEqual(col.platformFor('https://evil.com/?r=reddit.com'), null);
});

// ---- Threads -------------------------------------------------------------
// Threads gives abbreviated, localized counts and no exact source. The danger is
// presenting a rounded number as though it were exact, and mislabelling metrics read
// by position.

check('threads: abbreviated counts are expanded AND flagged approximate', () => {
  assert.deepStrictEqual(col.parseCount('4.8천'), { value: 4800, approx: true });
  assert.deepStrictEqual(col.parseCount('2.6K'), { value: 2600, approx: true });
  assert.deepStrictEqual(col.parseCount('1.2만'), { value: 12000, approx: true });
});

check('threads: a plain number is exact, not flagged', () => {
  assert.deepStrictEqual(col.parseCount('420'), { value: 420, approx: false });
  assert.deepStrictEqual(col.parseCount('1,234'), { value: 1234, approx: false });
});

check('threads: garbage yields null rather than a wrong number', () => {
  assert.strictEqual(col.parseCount(null), null);
  assert.strictEqual(col.parseCount(''), null);
  assert.strictEqual(col.parseCount('abc'), null);
});

check('threads: four counts map to likes/replies/reposts/quotes, flagged approx', () => {
  const r = col.PLATFORMS.threads.shape({
    id: 'Ddt7cL5EfUG', href: '/@zuck/post/Ddt7cL5EfUG', author: 'zuck',
    at: '2026-09-25T16:50:21.000Z', text: 'hi', counts: ['4.8천', '420', '290', '131'],
  });
  assert.strictEqual(r.likes, 4800);
  assert.strictEqual(r.replies, 420);
  assert.strictEqual(r.reposts, 290);
  assert.strictEqual(r.quotes, 131);
  assert.strictEqual(r.countsApprox, true, 'a rounded count must be marked');
  assert.strictEqual(r.url, 'https://www.threads.com/@zuck/post/Ddt7cL5EfUG');
});

check('threads: exact counts are NOT flagged approximate', () => {
  const r = col.PLATFORMS.threads.shape({
    id: 'a', href: '/@z/post/a', counts: ['12', '3', '1', '0'],
  });
  assert.strictEqual(r.likes, 12);
  assert.strictEqual(r.countsApprox, undefined);
});

check('threads: a partial count run is DROPPED, never mislabelled', () => {
  // 🔴 Two numbers could be any two of the four. Guessing which would produce metrics
  //    that look right and are wrong — unspottable later. Measured: 2 of 10 posts on a
  //    real profile had no readable counts, and they came back without metrics.
  const r = col.PLATFORMS.threads.shape({ id: 'a', href: '/@z/post/a', counts: ['4.8천', '420'] });
  assert.strictEqual(r.likes, undefined);
  assert.strictEqual(r.replies, undefined);
});

check('threads.net and threads.com both resolve', () => {
  assert.strictEqual(col.platformFor('https://www.threads.com/@z').name, 'threads');
  assert.strictEqual(col.platformFor('https://www.threads.net/@z').name, 'threads');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
