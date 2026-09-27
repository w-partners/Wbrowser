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

// Threads shows counts abbreviated and localized — "4.8천", "2.6K", "1.2만" — and offers no
// aria-label with the exact number (measured 2026-09-27, Korean UI). So unlike X, the number
// we can read IS the rounded one.
// 🔴 Therefore mark it. A caller that sorts by `likes` must be able to tell an exact 4800
//    from a rounded 4.8천, or a ranking built on rounded numbers looks as authoritative as
//    one built on real ones. That is why parsed Threads counts carry `approx: true`.
const THREADS_UNITS = [
  [/만$/, 10000], [/천$/, 1000],         // ko
  [/[MmМ]$/, 1000000], [/[KkТт]$/, 1000], // en
  [/億$/, 100000000], [/万$/, 10000],     // ja/zh
];
function parseCount(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().replace(/,/g, '');
  if (!t) return null;
  const m = t.match(/^([\d.]+)\s*(.*)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] || '').trim();
  if (!suffix) return { value: Math.round(n), approx: false };
  for (const [re, mult] of THREADS_UNITS) {
    if (re.test(suffix)) return { value: Math.round(n * mult), approx: true };
  }
  return { value: Math.round(n), approx: false };
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

// Reddit is the easy one: <shreddit-post> carries everything as ATTRIBUTES — score,
// comment-count, created-timestamp (ISO), author, permalink, post-title, upvote-ratio.
// 🔵 Measured 2026-09-27 on r/LocalLLaMA. Read the attributes, not the rendered text: the
//    card shows "176" for a score that is exactly 176 today, but shows "1.2k" once it grows.
// 🔴 Reddit may serve a "Prove your humanity" JS challenge first. It clears itself after a
//    few seconds — which is why zero posts is reported as zero, never as "no collector".
const REDDIT_EXTRACT = `(() => {
  return [...document.querySelectorAll('shreddit-post')].map((p) => {
    const a = (n) => p.getAttribute(n);
    const body = p.querySelector('[slot=text-body]');
    return {
      id: a('id'),
      permalink: a('permalink'),
      author: a('author'),
      at: a('created-timestamp'),
      title: a('post-title'),
      text: body ? body.innerText : '',
      score: a('score'),
      comments: a('comment-count'),
      ratio: a('upvote-ratio'),
      subreddit: a('subreddit-prefixed-name'),
      postType: a('post-type'),
    };
  });
})()`;

// Threads has no post element and no metric labels: a post is the subtree around a <time>,
// and the counts are bare text nodes in order — likes, replies, reposts, quotes.
// 🔴 Positional reading is fragile by nature, so it is fenced: we only take the trailing run
//    of count-shaped tokens, and anything we cannot read stays null instead of being guessed.
const THREADS_EXTRACT = `(() => {
  const out = [];
  for (const t of document.querySelectorAll('time')) {
    const link = t.closest('a[href*="/post/"]');
    if (!link) continue;
    let box = t;
    for (let i = 0; i < 12 && box.parentElement; i += 1) {
      box = box.parentElement;
      if (box.innerText && box.innerText.length > 60) break;
    }
    const lines = box.innerText.split('\\n').map((s) => s.trim()).filter(Boolean);
    // Trailing count-shaped tokens: "4.8천", "420", "2.6K"
    const isCount = (s) => /^[\\d.,]+\\s*[가-힣A-Za-z]?$/.test(s) && /\\d/.test(s);
    const tail = [];
    for (let i = lines.length - 1; i >= 0 && tail.length < 4; i -= 1) {
      if (isCount(lines[i])) tail.unshift(lines[i]); else break;
    }
    const textLines = lines.slice(1).filter((s) => !isCount(s)
      && !/^\\d+일$|^\\d+시간$|^\\d+분$|^번역하기$|^Translate$/.test(s));
    out.push({
      id: (link.getAttribute('href').split('/post/')[1] || '').split(/[?#]/)[0],
      href: link.getAttribute('href'),
      author: (lines[0] || '').replace(/^@/, ''),
      at: t.getAttribute('datetime'),
      text: textLines.join('\\n'),
      counts: tail,
      images: [...box.querySelectorAll('img')].filter((i) => i.naturalWidth >= 200).length,
      videos: box.querySelectorAll('video').length,
    });
  }
  return out;
})()`;

// Hacker News is the cleanest of the lot: a post is tr.athing, its metadata is the very next
// row, and every field has a class. The age carries an exact ISO timestamp in `title`.
// 🔵 Measured 2026-09-27 on the front page: 30 rows, score/user/comments all present.
const HN_EXTRACT = `(() => {
  return [...document.querySelectorAll('tr.athing')].map((r) => {
    const sub = r.nextElementSibling;
    const q = (el, s) => (el ? el.querySelector(s) : null);
    const titleA = q(r, '.titleline a');
    const ageEl = q(sub, '.age');
    const scoreEl = q(sub, '.score');
    // "64 comments" — the discuss link. On a job post there is none, and that is not 0.
    const commentA = sub
      ? [...sub.querySelectorAll('a')].find((a) => /\\d+\\s*(comment|comments)/i.test(a.innerText))
      : null;
    return {
      id: r.id || null,
      title: titleA ? titleA.innerText : null,
      link: titleA ? titleA.href : null,
      site: (q(r, '.sitestr') || {}).innerText || null,
      author: (q(sub, '.hnuser') || {}).innerText || null,
      at: ageEl ? ageEl.getAttribute('title') : null,
      score: scoreEl ? scoreEl.innerText : null,       // "103 points"
      comments: commentA ? commentA.innerText : null,  // "64 comments"
    };
  });
})()`;

// Instagram's profile grid is a wall of thumbnails and nothing else.
// 🔴 Measured 2026-09-27 on a real profile: the grid has NO timestamps and NO like/comment
//    counts — they only exist once a post is opened. The caption survives only as the
//    thumbnail's alt text. So this collector returns links + captions and says plainly that
//    metrics are not available from the grid. Inventing zeros, or quietly omitting the fact
//    that nothing was measured, is what would make this feature a liar.
const INSTAGRAM_EXTRACT = `(() => {
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/(p|reel)\\/([^/?#]+)/);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    const img = a.querySelector('img');
    out.push({
      id: m[2],
      href,
      kind: m[1] === 'reel' ? 'reel' : 'post',
      caption: img && img.alt ? img.alt : '',
      thumb: img && img.src ? img.src : null,
    });
  }
  return out;
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
  reddit: {
    match: (u) => hostIs(u, ['reddit.com']),
    extract: REDDIT_EXTRACT,
    shape: (row) => {
      // 🔴 Number(null) is 0 and Number('') is 0. Coercing straight from the attribute
      //    turns "this post had no score attribute" into "this post scored 0" — a value
      //    indistinguishable from a real zero, and one that sorts to the bottom as though
      //    it had been measured. Reject the empty cases BEFORE coercing.
      const num = (v) => {
        if (v === null || v === undefined || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      return {
        id: row.id,
        url: row.permalink ? `https://www.reddit.com${row.permalink}` : undefined,
        author: row.author,
        at: row.at,
        title: row.title,
        text: row.text || '',
        score: num(row.score),
        comments: num(row.comments),
        upvoteRatio: num(row.ratio),
        subreddit: row.subreddit,
      };
    },
  },
  threads: {
    match: (u) => hostIs(u, ['threads.com', 'threads.net']),
    extract: THREADS_EXTRACT,
    shape: (row) => {
      // Order on the card is likes, replies, reposts, quotes (measured 2026-09-27).
      // 🔴 Only trust it when all four are present; a partial run could be any of them, and
      //    mislabelled metrics are worse than missing ones — you cannot spot them later.
      const names = ['likes', 'replies', 'reposts', 'quotes'];
      const out = {
        id: row.id,
        url: row.href ? `https://www.threads.com${row.href}` : undefined,
        author: row.author,
        at: row.at,
        text: row.text || '',
        images: row.images || undefined,
        videos: row.videos || undefined,
      };
      if (Array.isArray(row.counts) && row.counts.length === 4) {
        let anyApprox = false;
        row.counts.forEach((raw, i) => {
          const p = parseCount(raw);
          if (!p) return;
          out[names[i]] = p.value;
          if (p.approx) anyApprox = true;
        });
        // 🔴 Say so when a number is rounded. Threads gives "4.8천", not 4800 — a caller
        //    sorting by likes must know these are not exact, or a ranking built on rounded
        //    counts reads as authoritatively as one built on real ones.
        if (anyApprox) out.countsApprox = true;
      }
      return out;
    },
  },
  hackernews: {
    match: (u) => hostIs(u, ['news.ycombinator.com', 'ycombinator.com']),
    extract: HN_EXTRACT,
    shape: (row) => {
      // "103 points" → 103, "64 comments" → 64. A field that was not on the row stays
      // absent: a job post has no score and no discuss link, and that is not zero.
      const lead = (s) => {
        if (!s) return undefined;
        const m = String(s).match(/([\d,]+)/);
        if (!m) return undefined;
        const n = Number(m[1].replace(/,/g, ''));
        return Number.isFinite(n) ? n : undefined;
      };
      return {
        id: row.id,
        url: row.id ? `https://news.ycombinator.com/item?id=${row.id}` : undefined,
        link: row.link || undefined,     // where the story points (often another site)
        site: row.site || undefined,
        author: row.author || undefined,
        at: row.at,
        title: row.title,
        text: '',
        score: lead(row.score),
        comments: lead(row.comments),
      };
    },
  },
  instagram: {
    match: (u) => hostIs(u, ['instagram.com']),
    extract: INSTAGRAM_EXTRACT,
    shape: (row) => ({
      id: row.id,
      url: row.href ? `https://www.instagram.com${row.href}` : undefined,
      kind: row.kind,
      // 🔵 The caption lives in the thumbnail's alt text; that is genuinely all the grid has.
      text: row.caption || '',
      thumb: row.thumb || undefined,
      // 🔴 No date and no metrics exist in the grid — not "zero", not "unknown so far".
      //    Stamp the reason on every row so a caller that sorts by likes finds out here
      //    rather than concluding the account gets no engagement.
      metricsUnavailable: 'Instagram\'s grid carries no timestamps or like/comment counts — '
        + 'open a post to see those. Only links and captions are collectable here.',
    }),
    // 🔴 The day filter cannot work without dates. Say so instead of returning everything
    //    and letting the caller believe it was filtered.
    noDates: true,
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

module.exports = { parseXMetrics, parseCount, withinDays, platformFor, mergeRows, hostIs, PLATFORMS, SCROLL_STEP };
