// copyprofile — seed the wbrowser profile from the user's REAL Chrome profile, so the logins and
// saved passwords that already live in their Google/Chrome profile come along. This is the fix for
// "the agent's window asks me to log in again": Chrome 136+ refuses remote debugging on the
// default profile, so wbrowser drives a copy in ~/.wbrowser — but the copy was starting EMPTY.
// Copying the real profile's login-bearing files in makes the agent's window already-signed-in.
//
// 🔴 Only the files that carry logins/saved passwords/settings — NOT the whole profile (caches,
//    GPU blobs, history are large and pointless here). And it is a SEED: we copy only when the
//    destination file is absent, so we never clobber a session the agent has since built up.
//
// The file list and the decide-what-to-copy logic are pure and unit-tested; the actual fs copy
// is a thin wrapper. Locked files (Chrome running on that profile) are skipped best-effort with a
// note, never a crash — the caller tells the user to close that profile for a complete seed.

const fs = require('node:fs');
const path = require('node:path');

// The login-bearing files (relative to a profile's inner folder, e.g. "Default"). Cookies and
// Login Data are the sign-in; Web Data holds autofill; Preferences/Secure Preferences hold the
// account wiring. Everything else (Cache, GPUCache, History, Service Worker) is skipped.
const SEED_FILES = [
  'Cookies',
  'Login Data',
  'Login Data For Account',
  'Web Data',
  'Preferences',
  'Secure Preferences',
  'Network/Cookies',          // newer Chrome moved Cookies under Network/
];

// Top-level (profile-root, not inner) files worth seeding so the profile list resolves.
const SEED_ROOT_FILES = ['Local State'];

// Decide which files to copy: a seed source file that exists AND whose destination is missing.
// Pure — takes an `exists(path)` probe so it is testable without a filesystem. Returns
// [{ from, to }] pairs, plus which sources were absent (so the caller can say "no logins found").
function planCopy(srcProfileDir, dstProfileDir, innerFolder, exists) {
  const plan = [];
  const missingSrc = [];
  const inner = innerFolder || 'Default';
  // profile-inner files
  for (const rel of SEED_FILES) {
    const from = path.join(srcProfileDir, inner, rel);
    const to = path.join(dstProfileDir, inner, rel);
    if (!exists(from)) { missingSrc.push(rel); continue; }
    if (exists(to)) continue;                    // seed only — never overwrite a live session
    plan.push({ from, to });
  }
  // profile-root files (Local State lists the profiles; needed for name resolution)
  for (const rel of SEED_ROOT_FILES) {
    const from = path.join(srcProfileDir, rel);
    const to = path.join(dstProfileDir, rel);
    if (exists(from) && !exists(to)) plan.push({ from, to });
  }
  return { plan, missingSrc };
}

// Execute a plan. Best-effort per file: a locked file (EBUSY/EPERM, Chrome holding it) is skipped
// and reported, never thrown — a partial seed still helps and the caller advises closing Chrome.
function runCopy(plan) {
  const copied = [];
  const skipped = [];
  for (const { from, to } of plan) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(to);
    } catch (e) {
      skipped.push({ to, why: (e && e.code) || (e && e.message) || 'copy failed' });
    }
  }
  return { copied, skipped };
}

// Full operation: seed dstProfileDir from srcProfileDir for one inner profile folder. Returns a
// summary the caller can log. Does nothing (copied:0) when there is no source or nothing missing.
function seedProfile(srcProfileDir, dstProfileDir, innerFolder) {
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if (!srcProfileDir || !exists(srcProfileDir)) {
    return { copied: [], skipped: [], missingSrc: [], noSource: true };
  }
  const { plan, missingSrc } = planCopy(srcProfileDir, dstProfileDir, innerFolder, exists);
  const { copied, skipped } = runCopy(plan);
  return { copied, skipped, missingSrc, noSource: false };
}

module.exports = { SEED_FILES, SEED_ROOT_FILES, planCopy, runCopy, seedProfile };
