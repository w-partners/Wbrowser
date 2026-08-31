// preflight.js — one answer to "can this run here?", used by everything that needs it.
//
// 🔴 This existed in three places with three different tests: `wb` looked for the
//    directory, engine.js and mcp-server.js each called require.resolve. Three tests
//    for one fact means they can disagree, and a disagreement is invisible — the one
//    that passes is the one you happen to run. That is the same shape as the bug this
//    file was written for, where `wb status` said ready and nothing was installed.
//
//    So: one test, one message, one place to change it.

const path = require('path');

/** Is the dependency actually loadable from this checkout? */
function isInstalled() {
  try {
    require.resolve('playwright', { paths: [__dirname] });
    return true;
  } catch {
    return false;
  }
}

/** What to tell someone who has not installed it. Same words everywhere. */
function installMessage(dir = __dirname) {
  return [
    '❌ Dependencies are not installed in this directory.',
    '',
    `   cd ${path.resolve(dir)} && npm install`,
    '',
    '🔴 Until then this cannot run — and any engine answering on the port belongs to',
    '   someone else, so commands would drive their browser, not yours.',
  ].join('\n');
}

/** For entry points: print and exit rather than failing later with a stack trace. */
function requireInstalled() {
  if (isInstalled()) return;
  console.error(installMessage());
  process.exit(1);
}

module.exports = { isInstalled, installMessage, requireInstalled };

// 🔵 Runnable so shell callers get the same answer as the JS ones: exit 0 installed,
//    exit 1 not. `wb` uses this instead of testing for the directory itself.
if (require.main === module) {
  // Two jobs, kept apart so callers do not have to read an exit code two ways:
  //   preflight.js            → exit 0 installed, 1 not. The answer.
  //   preflight.js --explain  → print the message, exit 0. Just the words.
  if (process.argv.includes('--explain')) {
    console.error(installMessage());
    process.exit(0);
  }
  process.exit(isInstalled() ? 0 : 1);
}
