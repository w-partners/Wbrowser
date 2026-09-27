// collect.js — pull a list of posts off a page, as data.
//
// 🔴 Why per-platform and not one generic scraper: the useful fields are named differently
//    everywhere, and "generic" in practice means the agent gets innerText soup and has to
//    re-derive who posted what, when, and how it did. The point of collecting is to end up
//    with something you can sort and count.
//
// 🔴 Why the extractors are strings evaluated in the page: they run inside Chrome, where the
//    DOM is. Keeping them here (not inline in engine.js) is what lets them be unit-tested
//    against fake DOMs without a browser.
//
// Measured on X 2026-09-27 — the shapes below are what the page really gives:
//   · article[data-testid="tweet"] is one post
//   · a <time> inside an <a href="/user/status/123"> carries the exact ISO timestamp AND
//     the permalink — the only reliable id on the page
//   · [role="group"] has ONE aria-label with every metric as an exact number:
//     "48 replies, 538 reposts, 2587 likes, 4508 bookmarks, 198913 views"
//     🔴 Use it, not the button text: the buttons read "2.5K", which loses 87 likes.

// Parse X's metric aria-label. Exported so it can be tested without a browser.
// 🔵 Locale note: the label is English on an English UI; a localized UI gives localized
//    words and this returns what it can rather than guessing. Missing ≠ zero, so absent
//    keys stay absent — a 0 we invented would be indistinguishable from a real 0.
function parseXMetrics(label) {
  if (!label || typeof label !== 'string') return {};
  const out = {};
  const map = {
    repl: 'replies', repost: 'reposts', retweet: 'reposts', like: 'likes',
    bookmark: 'bookmarks', view: 'views',
  };
  // "48 replies", "2587 likes", "198913 views" — also tolerates 1 234 / 1,234
  const re = /([\d][\d,\s.]*)\s+([a-z]+)/gi;
  let m;
  while ((m = re.exec(label)) !== null) {
    const n = Number(String(m[1]).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n)) continue;
    const word = m[2].toLowerCase();
    const key = Object.keys(map).find((k) => word.startsWith(k));
    if (key) out[map[key]] = n;
  }
  return out;
}

// 🔵 Keep only posts inside the window the caller asked for. Pure, so it is testable, and
//    it is where an off-by-one costs a month of data.
function withinDays(iso, days) {
  if (!days || !iso) return true;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;          // unknown date → keep, do not silently drop
  return (Date.now() - t) <= days * 86400000;
}

// The page-side extractor for X. Returns raw rows; filtering happens in Node.
const X_EXTRACT = `(() => {
  const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
  return arts.map((a) => {
    const timeEl = a.querySelector('time');
    const link = timeEl && timeEl.closest('a[href*="/status/"]');
    const href = link ? link.getAttribute('href') : null;
    const textEl = a.querySelector('[data-testid="tweetText"]');
    const group = a.querySelector('[role="group"]');
    const userLink = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
    const imgs = [...a.querySelectorAll('img')]
      .filter((i) => i.src && !i.src.startsWith('data:') && i.naturalWidth >= 150)
      .map((i) => i.src);
    const vids = [...a.querySelectorAll('video')].map((v) => ({
      poster: v.poster || null,
      seconds: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
    }));
    return {
      id: href ? (href.split('/status/')[1] || '').split(/[?#]/)[0] : null,
      url: href ? 'https://x.com' + href : null,
      author: userLink ? userLink.getAttribute('href').replace(/^\\//, '') : null,
      at: timeEl ? timeEl.getAttribute('datetime') : null,
      text: textEl ? textEl.innerText : '',
      metricsLabel: group ? group.getAttribute('aria-label') : null,
      images: imgs,
      videos: vids,
    };
  });
})()`;

// How far down the page is "the end" — used by the scroll loop to know it has stopped moving.
const SCROLL_STEP = `(() => {
  window.scrollBy(0, window.innerHeight * 0.9);
  return { y: window.scrollY, h: document.body.scrollHeight };
})()`;

// 🔴 Match on the parsed HOST, never on the URL string. A substring test gets this wrong
//    in both directions: `/(^|\.)x\.com/` misses "https://x.com/a" (the scheme is in the
//    way — measured, it returned false), and a looser `/x\.com/` happily matches
//    "https://evil.com/?r=x.com". Same class of bug as the scoped-autofill matcher.
function hostIs(url, domains) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const PLATFORMS = {
  x: {
    match: (u) => hostIs(u, ['x.com', 'twitter.com']),
    extract: X_EXTRACT,
    // 🔵 Turn one page row into the shape we store. Split out so tests can drive it.
    shape: (row) => ({
      id: row.id,
      url: row.url,
      author: row.author,
      at: row.at,
      text: row.text,
      ...parseXMetrics(row.metricsLabel),
      images: row.images && row.images.length ? row.images : undefined,
      videos: row.videos && row.videos.length ? row.videos : undefined,
    }),
  },
};

function platformFor(url) {
  for (const [name, p] of Object.entries(PLATFORMS)) if (p.match(url)) return { name, ...p };
  return null;
}

// Merge new rows into the accumulator, newest-first order preserved, no duplicates.
// 🔴 Deduping by id is what makes the scroll loop safe: X re-renders the same posts as you
//    scroll, and without this a "100 posts" run returns the same 15 posts seven times.
function mergeRows(seen, out, rows, shape, days) {
  let added = 0;
  for (const raw of rows) {
    const row = shape(raw);
    if (!row.id || seen.has(row.id)) continue;
    if (!withinDays(row.at, days)) continue;
    seen.add(row.id);
    out.push(row);
    added += 1;
  }
  return added;
}

module.exports = { parseXMetrics, withinDays, platformFor, mergeRows, hostIs, PLATFORMS, SCROLL_STEP };
