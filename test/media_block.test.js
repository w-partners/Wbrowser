// The `media` block that `wb read` reports — tested by extracting the REAL code from
// engine.js and running it against fake DOMs, not by retyping the logic here.
//
// 🔴 Retyped logic only proves the copy works. Extraction is what makes a green test
//    evidence about the engine (same pattern as fallback_recovery.test.js).
// 🔵 No Chrome. Spawning Chrome per test run is what got us told off (L-20260906-02),
//    and this logic is pure DOM-walking, so a fake document exercises all of it.
//
// What must never regress, and why:
//   1. A blob: video is FLAGGED and the note names `wb video`. Without the flag the next
//      agent tries to fetch "blob:…" because it looks like a URL. Measured on X 2026-09-27.
//   2. Duration/size come through. "There is a video" without a length is not much use.
//   3. Tracking pixels and spacer gifs stay out, or `media` becomes noise nobody reads.
//   4. No media → the key is absent, not an empty object; `read` output stays clean.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = path.join(__dirname, '..', 'engine.js');

function extractMediaBlock() {
  const src = fs.readFileSync(ENGINE, 'utf8');
  const start = src.indexOf('const media = (() => {');
  assert.ok(start > 0, 'media block not found in engine.js — did summarize() change?');
  const end = src.indexOf('})();', start) + '})();'.length;
  assert.ok(end > start, 'media block end not found');
  return src.slice(start, end);
}

// Minimal element stand-in: only what the block actually touches.
function el(tag, props = {}) {
  return {
    tagName: tag.toUpperCase(),
    src: '', alt: '', poster: '', naturalWidth: 0, naturalHeight: 0,
    videoWidth: 0, videoHeight: 0, duration: NaN, currentSrc: '',
    ...props,
    getBoundingClientRect() { return props._rect || { width: 100, height: 100 }; },
  };
}

function runBlock(elements) {
  const block = extractMediaBlock();
  const sandbox = {
    document: {
      querySelectorAll(sel) {
        const want = sel.trim().toLowerCase();
        return elements.filter((e) => e.tagName.toLowerCase() === want);
      },
    },
    result: undefined,
  };
  const code = `
    const txt = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    ${block}
    result = media;
  `;
  vm.runInNewContext(code, sandbox, { timeout: 5000 });
  return sandbox.result;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('media block (extracted from engine.js):');

check('a blob: video is flagged and the note points at `wb video`', () => {
  const out = runBlock([
    el('video', {
      currentSrc: 'blob:https://x.com/edf103c0-4c5d-4a75-8a9f-f090c04c5dd3',
      poster: 'https://pbs.twimg.com/amplify_video_thumb/209/img/a.jpg',
      duration: 41.192, videoWidth: 1440, videoHeight: 1808,
    }),
  ]);
  assert.strictEqual(out.videos.length, 1);
  assert.strictEqual(out.videos[0].blob, true, 'blob: source must be flagged');
  assert.ok(/wb video/.test(out.note || ''), 'note must name `wb video` as the way out');
});

check('duration and dimensions survive (rounded, not dropped)', () => {
  const out = runBlock([
    el('video', { currentSrc: 'blob:x', duration: 41.192, videoWidth: 1440, videoHeight: 1808 }),
  ]);
  assert.strictEqual(out.videos[0].seconds, 41.2);
  assert.strictEqual(out.videos[0].w, 1440);
  assert.strictEqual(out.videos[0].h, 1808);
});

check('a normal mp4 video is NOT flagged as blob and gets no note', () => {
  const out = runBlock([
    el('video', { currentSrc: 'https://cdn.example.com/clip.mp4', duration: 10, videoWidth: 640, videoHeight: 360 }),
  ]);
  assert.strictEqual(out.videos[0].blob, false);
  assert.strictEqual(out.note, undefined, 'no blob → no blob note');
});

check('a non-finite duration becomes null, never NaN', () => {
  // 🔵 NaN survives JSON.stringify as null anyway, but only by accident — assert it,
  //    because a NaN leaking into arithmetic downstream is silent.
  const out = runBlock([el('video', { currentSrc: 'https://e.com/a.mp4', duration: NaN })]);
  assert.strictEqual(out.videos[0].seconds, null);
});

check('tracking pixels and data: URIs are excluded', () => {
  const out = runBlock([
    el('img', { src: 'https://t.example.com/px.gif', naturalWidth: 1, naturalHeight: 1 }),
    el('img', { src: 'data:image/png;base64,AAA', naturalWidth: 800, naturalHeight: 600 }),
    el('img', { src: 'https://cdn.example.com/real.jpg', naturalWidth: 956, naturalHeight: 1200 }),
  ]);
  assert.strictEqual(out.images.length, 1, 'only the real image should survive');
  assert.strictEqual(out.images[0].w, 956);
});

check('an invisible image is excluded', () => {
  const out = runBlock([
    el('img', { src: 'https://cdn.example.com/hidden.jpg', naturalWidth: 900, naturalHeight: 900,
                _rect: { width: 0, height: 0 } }),
  ]);
  assert.strictEqual(out, undefined, 'nothing visible → no media key at all');
});

check('no media at all → key is absent, not an empty object', () => {
  assert.strictEqual(runBlock([]), undefined);
});

check('images only → no videos key, no note', () => {
  const out = runBlock([
    el('img', { src: 'https://cdn.example.com/a.jpg', naturalWidth: 900, naturalHeight: 900 }),
  ]);
  assert.ok(out.images.length === 1);
  assert.strictEqual(out.videos, undefined);
  assert.strictEqual(out.note, undefined);
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
