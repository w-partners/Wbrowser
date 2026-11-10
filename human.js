// Human-shaped input — the one place that decides how a pointer moves and how keys are spaced.
//
// 🔴 Bot defences score the input stream, not the request: a pointer that
//    teleports to a button in 0ms, keys at a perfectly even interval, a click with no scroll or
//    movement before it — each is a tell. So by default every click travels a curved path with
//    easing and jitter, every key waits a random 50–150ms, and a page gets a little scroll and
//    pointer movement after it loads.
// 🔵 Both the playwright path (engine.js) and the raw-CDP fallback (rawcdp.js) draw from here,
//    so the two never drift into different "humans".
// 🔵 WBROWSER_HUMAN=0 turns it all off (old behaviour: instant clicks, 25ms keys, no warm-up).

const enabled = () => process.env.WBROWSER_HUMAN !== '0';

const rand = (a, b) => a + Math.random() * (b - a);

// Per-key delay, 50–150ms — the range a typing person actually shows.
// 🔴 For long text the spacing tightens so the whole string fits in ~30s: at 100ms a key, 900+
//    characters outlast the client's 90s request limit, the caller sees a cut-off reply while
//    the engine keeps typing, and the next command races it into the same field. Still uneven.
const TYPE_BUDGET_MS = 30000;
const keyDelay = (len = 0) => {
  const mean = Math.min(100, TYPE_BUDGET_MS / Math.max(1, len));
  return Math.max(1, Math.round(mean * rand(0.5, 1.5)));
};
const tightened = (len) => TYPE_BUDGET_MS / Math.max(1, len) < 100;

// A point inside the middle half of a box — people do not hit the exact centre, but they do
// not hit the edge either (edges can belong to a neighbouring element).
function pointIn(box) {
  return { x: box.x + box.width * rand(0.3, 0.7), y: box.y + box.height * rand(0.3, 0.7) };
}

// Cubic Bezier from→to with two control points pushed off the straight line, sampled with
// ease-in-out so the pointer accelerates then settles. Returns [{x, y, wait}], last = `to`.
function mousePath(from, to) {
  const dx = to.x - from.x; const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 18)));
  // Perpendicular offset for the bend, proportional to the distance (capped).
  const bend = Math.min(dist * 0.3, 120);
  const nx = dist ? -dy / dist : 0; const ny = dist ? dx / dist : 0;
  const c1 = { x: from.x + dx * rand(0.2, 0.4) + nx * rand(-bend, bend), y: from.y + dy * rand(0.2, 0.4) + ny * rand(-bend, bend) };
  const c2 = { x: from.x + dx * rand(0.6, 0.8) + nx * rand(-bend, bend), y: from.y + dy * rand(0.6, 0.8) + ny * rand(-bend, bend) };
  const pts = [];
  for (let i = 1; i <= steps; i += 1) {
    const s = i / steps;
    const t = s < 0.5 ? 2 * s * s : 1 - ((-2 * s + 2) ** 2) / 2;   // ease-in-out
    const u = 1 - t;
    const x = u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x;
    const y = u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y;
    const last = i === steps;
    pts.push({ x: last ? to.x : x + rand(-0.6, 0.6), y: last ? to.y : y + rand(-0.6, 0.6), wait: Math.round(rand(6, 18)) });
  }
  return pts;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Last known pointer position per page — a path starts where the pointer actually is.
const where = new WeakMap();
function startOf(key, viewport) {
  return where.get(key) || { x: rand(0.2, 0.8) * (viewport.width || 1200), y: rand(0.2, 0.8) * (viewport.height || 800) };
}

// Move along a path, then press and release with a human hold time.
// `move(x, y)` / `down(x, y)` / `up(x, y)` are the transport (playwright mouse or raw CDP).
async function clickAlong(key, viewport, target, { move, down, up }) {
  for (const p of mousePath(startOf(key, viewport), target)) { await move(p.x, p.y); await sleep(p.wait); }
  where.set(key, target);
  await sleep(rand(60, 180));          // aim, then press
  await down(target.x, target.y);
  await sleep(rand(40, 120));          // hold
  await up(target.x, target.y);
}

// After a page loads: drift the pointer a little, scroll down, then back to where it was —
// so a screenshot or read that follows still sees the top of the page.
async function warmUp(key, viewport, { move, wheel }) {
  const to = { x: rand(0.3, 0.7) * (viewport.width || 1200), y: rand(0.3, 0.6) * (viewport.height || 800) };
  for (const p of mousePath(startOf(key, viewport), to)) { await move(p.x, p.y); await sleep(p.wait); }
  where.set(key, to);
  const down = Math.round(rand(200, 500));
  for (let i = 0; i < 3; i += 1) { await wheel(down / 3); await sleep(rand(80, 200)); }
  await sleep(rand(200, 500));
  await wheel(-down);
  await sleep(rand(100, 300));
}

module.exports = { enabled, keyDelay, tightened, pointIn, mousePath, clickAlong, warmUp, sleep };
