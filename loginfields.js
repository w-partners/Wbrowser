// loginfields.js — pick the username / password / submit controls out of a page's form fields.
//
// 🔴 Why this is a separate, pure module: choosing WHERE a secret gets typed is the one
//    decision that must never be a guess. If we cannot identify the password field with
//    confidence, we refuse — a secret typed into the wrong field is the worst outcome
//    (docs/DESIGN-credential-vault.md). Keeping the choice pure means it is fully testable
//    against captured field lists, with no browser and no real credential in the loop.
//
// The engine collects candidate fields over CDP (one Runtime.evaluate that returns, per
// input/button on the page, a small descriptor) and hands the ARRAY to choose(). choose()
// returns { username, password, submit } refs, or throws a named refusal. It never sees or
// returns a secret value — only field identity.
//
// A candidate descriptor (what the engine's page-side script produces):
//   { ref, tag, type, name, id, autocomplete, placeholder, ariaLabel, visible, text }
//     ref         opaque id the engine uses to target the field over CDP
//     tag         'input' | 'button' | ...
//     type        the input's type attribute, lowercased ('password','text','email','submit'...)
//     name/id/... attributes, lowercased where matched
//     visible     whether the field is visible & enabled (hidden fields are never chosen)
//     text        button text / value (for submit detection)

// Signals that a text field is the username/identifier. Ordered strongest → weakest.
const USER_HINTS = [
  'username', 'user-name', 'user_name', 'userid', 'user-id', 'login', 'email',
  'e-mail', 'account', 'identifier', 'phone', 'id',
];
const USER_AUTOCOMPLETE = ['username', 'email'];
const SUBMIT_TEXT = [
  'sign in', 'signin', 'log in', 'login', 'continue', 'next', 'submit', 'go',
  '로그인', '계속', '다음', '확인', '登录', '登錄', 'iniciar', 'entrar', 'acceder',
];

function norm(s) { return (s || '').toString().toLowerCase().trim(); }

function fieldMatchesAny(f, hints) {
  const hay = [f.name, f.id, f.autocomplete, f.placeholder, f.ariaLabel].map(norm);
  return hints.some((h) => hay.some((v) => v.includes(h)));
}

// choose(candidates) -> { username, password, submit } (refs) or throws a named refusal.
function choose(candidates) {
  if (!Array.isArray(candidates)) throw new Error('loginfields: candidates must be an array');
  const visible = candidates.filter((f) => f && f.visible);

  // --- password: the anchor. Exactly one visible type=password, or we refuse. ---
  const passwords = visible.filter((f) => norm(f.type) === 'password');
  if (passwords.length === 0) {
    throw new Error(
      'loginfields: no visible password field found — refusing to type a secret. '
      + 'The page may not be a login form, may render the field later, or may use a custom '
      + 'widget this cannot see. Not guessing.');
  }
  if (passwords.length > 1) {
    // Two visible password fields usually means a "change password" / "confirm" form, not a
    // login. Typing the login secret into a confirm field is exactly the wrong-field risk.
    throw new Error(
      `loginfields: ${passwords.length} visible password fields — this looks like a `
      + 'change/confirm-password form, not a login. Refusing rather than guessing which one '
      + 'takes the login secret.');
  }
  const password = passwords[0];

  // --- username: best text-like field before the password, by hint strength. Optional: some
  //     flows put the password on its own step, so a missing username is allowed (not refused).
  const textCandidates = visible.filter((f) => {
    const t = norm(f.type);
    return f.tag === 'input' && (t === 'text' || t === 'email' || t === 'tel' || t === '');
  });
  let username = textCandidates.find((f) => USER_AUTOCOMPLETE.includes(norm(f.autocomplete)))
    || textCandidates.find((f) => fieldMatchesAny(f, USER_HINTS))
    || textCandidates[0]              // fall back to the first text field only if any exist
    || null;

  // --- submit: a button/submit whose text or type says "sign in". Optional — the caller may
  //     press Enter instead, and submit is gated on approval anyway, so a missing one is fine.
  const submit = visible.find((f) => norm(f.type) === 'submit')
    || visible.find((f) => (f.tag === 'button')
        && SUBMIT_TEXT.some((s) => norm(f.text).includes(s)))
    || null;

  return {
    username: username ? username.ref : null,
    password: password.ref,
    submit: submit ? submit.ref : null,
  };
}

module.exports = { choose, USER_HINTS, SUBMIT_TEXT };
