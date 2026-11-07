// `wb up` must hand the named browser's ports to the engine process.
//
// 🔴 Reported 2026-11-07 (coupangman): v0.32.2 put comment and log lines between the
//    `WBROWSER_PORT=... \` prefix and `nohup node engine.js`. The assignments became plain shell
//    variables, node never saw them, and every named browser's engine started on the default port
//    7981 and died on EADDRINUSE. Browser 1 hid it, because its ports are the defaults.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WB = fs.readFileSync(path.join(__dirname, '..', 'wb'), 'utf8');
// Join backslash-continued lines into the logical commands bash actually runs.
const logical = WB.replace(/\\\n\s*/g, ' ').split('\n');
const launches = logical.filter((l) => /nohup node "\$DIR\/engine\.js"/.test(l));

assert.ok(launches.length >= 1, 'the engine launch in wb is gone');
for (const l of launches) {
  for (const v of ['WBROWSER_PORT="$ENGINE_PORT"', 'WBROWSER_CDP_PORT="$CDP_PORT"',
    'WBROWSER_BROWSER_NUM="$BROWSER_NUM"']) {
    assert.ok(l.includes(v), `the engine launch does not carry ${v} on the same command:\n  ${l.trim()}`);
  }
}
console.log(`  ✅ ${launches.length} engine launch(es) carry the browser's ports`);
