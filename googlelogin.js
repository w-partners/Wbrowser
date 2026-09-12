// googlelogin — find and click the site's "Sign in with Google" button, so an agent can enter a
// site through the Google session the profile is already signed into (Aside's OAuth login, item 3
// the master asked for). The profile seeding (v0.20) brings the Google login along; this presses
// the button that turns that into a site login.
//
// 🔴 The hard part is not the click — it is FINDING the button across sites that all label it
//    differently ("Sign in with Google", "Continue with Google", "구글로 계속하기", a bare Google
//    "G" with an aria-label, an iframe-embedded GSI button). We keep an ordered list of text and
//    attribute patterns; the resolver tries them in order and clicks the first real match. The
//    patterns are pure and unit-tested; the page interaction lives in the engine.

// Visible-text phrases, lowercased, that name a Google sign-in control across locales. Matched as
// a substring of an element's text — but ONLY against clickable elements the resolver collects,
// never the whole page, so body copy mentioning "google" is not a target.
const TEXT_PATTERNS = [
  'sign in with google',
  'sign up with google',
  'continue with google',
  'log in with google',
  'login with google',
  'google 계정으로 로그인',
  'google로 로그인',
  '구글로 로그인',
  '구글 계정으로 로그인',
  'google로 계속',
  '구글로 계속',
  'با گوگل',            // a few common non-English forms
  'con google',
  'avec google',
  'mit google',
];

// Attribute selectors that identify the button structurally, tried before text (more precise).
// GSI = Google Identity Services, the official widget many sites embed.
const ATTR_SELECTORS = [
  '[aria-label*="Google" i][role="button"]',
  'button[aria-label*="Google" i]',
  'a[aria-label*="Google" i]',
  'div.g_id_signin',                 // GSI rendered button container
  '[data-provider="google" i]',
  '[data-testid*="google" i]',
  'a[href*="accounts.google.com/o/oauth2" i]',
  'a[href*="/auth/google" i]',
  'button[class*="google" i]',
];

// The full ordered candidate list for a page-side resolver: structural selectors first, then a
// text search. Returned as descriptors so the engine can try each and report which matched.
function candidateStrategies() {
  return [
    ...ATTR_SELECTORS.map((sel) => ({ kind: 'selector', value: sel })),
    ...TEXT_PATTERNS.map((t) => ({ kind: 'text', value: t })),
  ];
}

// Does an element's (already-lowercased) text name a Google sign-in? Pure helper the page uses.
function textMatches(loweredText) {
  const t = (loweredText || '').trim();
  if (!t) return false;
  return TEXT_PATTERNS.some((p) => t.includes(p));
}

module.exports = { TEXT_PATTERNS, ATTR_SELECTORS, candidateStrategies, textMatches };
