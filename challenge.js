// challenge.js — notice when a page is asking for a person (captcha, a second factor, a block
// or protection notice), so the engine stops instead of pushing on.
//
// 🔴 What happens on a hit is the caller's job (engine.js): input stops, the reply carries
//    `reconnect: true` and the reason, and a person takes over. Nothing here tries to solve
//    anything — a captcha solved by a program, or a login retried in a loop, is how accounts
//    get locked.
// 🔵 Pure: `classify(snapshot)` decides from a snapshot taken in the page (SNAPSHOT_EXPR), so
//    it is testable without a browser and the same on both lanes.

// Taken in the page. Visible iframes only — reCAPTCHA v3 / invisible v2 sit on ordinary pages
// as a hidden badge and must not count.
const SNAPSHOT_EXPR = `(() => {
  const frames = [];
  for (const f of document.querySelectorAll('iframe')) {
    const r = f.getBoundingClientRect();
    const st = getComputedStyle(f);
    // size=invisible is the v3 / invisible-v2 badge — on screen at a corner of ordinary pages.
    // On screen only: a checkbox in a comment form further down is not what this page is about.
    const onScreen = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    if (r.width > 30 && r.height > 30 && onScreen && st.visibility !== 'hidden' && st.display !== 'none'
        && !/[?&]size=invisible/.test(f.src || '')) frames.push(f.src || '');
  }
  const text = (document.body && document.body.innerText || '').slice(0, 6000);
  // A solved widget stays on screen; its response token is how a page tells solved from not.
  const solved = [...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]')]
    .some((n) => (n.value || '').length > 0);
  // Visible boxes for a code — a page that asks for one has it; a help page with a search box
  // does not. A code box says so: one-time-code, a numeric keypad, a short maxlength, or a
  // name like code / otp / pin / 인증.
  const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=search]):not([type=password])')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .filter((n) => (n.autocomplete || '') === 'one-time-code' || n.inputMode === 'numeric' || n.type === 'tel' || n.type === 'number'
      || (n.maxLength >= 4 && n.maxLength <= 8)
      || /code|otp|pin|token|verif|인증/i.test([n.name, n.id, n.placeholder, n.getAttribute('aria-label')].join(' '))).length;
  return { url: location.href, title: document.title, text, textLength: (document.body && document.body.innerText || '').length, frames, solved, inputs };
})()`;

const FRAME_RULES = [
  { kind: 'captcha', re: /(google\.com|recaptcha\.net)\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i, why: 'a reCAPTCHA is on screen' },
  { kind: 'captcha', re: /hcaptcha\.com\/captcha/i, why: 'an hCaptcha is on screen' },
  { kind: 'captcha', re: /challenges\.cloudflare\.com/i, why: 'a Cloudflare challenge is on screen' },
  { kind: 'captcha', re: /captcha-delivery\.com|geo\.captcha/i, why: 'a captcha is on screen' },
];
const URL_RULES = [
  // Anchored at the host: netflix.com/account/access must not read as x.com/account/access.
  { kind: 'captcha', re: /^https?:\/\/([^/]*\.)?google\.[a-z.]+\/sorry\//i, why: 'Google is asking to prove this is not a robot' },
  { kind: 'blocked', re: /^https?:\/\/([^/]*\.)?(facebook\.com\/checkpoint|instagram\.com\/challenge)/i, why: 'the account is at a security checkpoint' },
  { kind: 'blocked', re: /^https?:\/\/([^/]*\.)?(x|twitter)\.com\/account\/access/i, why: 'the account is locked pending a check' },
];
// 🔴 Text alone is weaker evidence — an ordinary page can mention "2-step verification" in a
//    help article. These count only on a short page (a challenge page is short; an article
//    about one is not).
const SHORT_PAGE = 3000;
const TEXT_RULES = [
  { kind: 'captcha', re: /자동\s?입력\s?방지|보안문자를?\s?입력|로봇이 아닙니다|i'?m not a robot|verify you are (a )?human|are you a robot|press (&|and) hold/i, why: 'the page asks to prove this is a person' },
  { kind: 'blocked', re: /보호\s?조치|비정상적인 (접근|활동|트래픽)|unusual (traffic|activity)|access denied[\s\S]{0,200}reference\s?#/i, why: 'the site has flagged or blocked this session' },
  // Only with a box to type the code into (`inputs` counts code boxes, see above): a settings page or an article that names
  // 2-step verification has none, a page waiting for the code has one. A sign-up form that
  // wants a code sent to a phone does stop — that code is the person's to give.
  { kind: 'verification', needsInput: true, re: /2단계 인증|2차 인증|인증번호를? 입력|two-factor|2-step verification|enter the code (we|that we) sent/i, why: 'the site asks for a second factor' },
];

function classify(snap) {
  if (!snap) return null;
  // 🔴 Once the person has solved it the widget is still visible — without this a solved
  //    captcha would stop every later command on that page.
  if (!snap.solved) for (const f of snap.frames || []) {
    for (const r of FRAME_RULES) if (r.re.test(f)) return { kind: r.kind, reason: r.why, url: snap.url, frame: true };
  }
  for (const r of URL_RULES) if (r.re.test(snap.url || '')) return { kind: r.kind, reason: r.why, url: snap.url };
  if ((snap.textLength || 0) <= SHORT_PAGE) {
    const t = `${snap.title || ''}\n${snap.text || ''}`;
    for (const r of TEXT_RULES) if ((!r.needsInput || snap.inputs > 0) && r.re.test(t)) return { kind: r.kind, reason: r.why, url: snap.url };
  }
  return null;
}

// 🔴 The check both lanes run. `snap()` takes a snapshot (null if the page did not answer);
//    `note()` puts a line in the reply.
//    - A page that does not answer is tried once more, then said so — never read as "clear".
//    - A widget seen as a frame gets one more look 2.5s later: a Turnstile that passes by
//      itself fills its token in a second or two, and that page needs no person.
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
async function check(snap, note) {
  let s = await snap();
  if (!s) { await sleep(1000); s = await snap(); }
  if (!s) {
    note('could not check this page for a captcha or a block notice (it did not answer) — look at it before going on');
    return null;
  }
  let c = classify(s);
  if (c && c.frame) {
    await sleep(2500);
    const again = await snap();
    if (again) c = classify(again);
  }
  return c;
}

// What the reply says. One wording for both lanes.
const HANDOVER = 'stopped: the page needs a person — nothing more was typed or clicked. '
  + 'Finish it by hand in this tab (do not let a program solve it), then run the command again.';

module.exports = { SNAPSHOT_EXPR, classify, check, HANDOVER };
