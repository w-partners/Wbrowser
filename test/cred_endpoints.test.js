// The credential engine endpoints, end to end against a real engine on an isolated port.
// 🔴 The property under test is the whole point: a stored secret must not appear in the
//    response, the audit log, the vault file, or the engine's stdout. unlock/enroll do not
//    need Chrome (they never call connect()), so this runs without a browser. /cred/login
//    needs a page and is verified by the master with a real account (see the design doc).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 39881;
const SECRET = 'SECRET_PW_e2e_do_not_leak';

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
}
async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await portOpen(port)) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

test('enroll stores a secret that never leaks to response / audit / file / stdout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbcred-'));
  const credFile = path.join(dir, 'creds.enc');
  const auditFile = path.join(dir, 'audit.log');
  const logFile = path.join(dir, 'engine.log');
  const out = fs.openSync(logFile, 'w');
  const engine = spawn(process.execPath, [path.join(ROOT, 'engine.js')], {
    stdio: ['ignore', out, out],
    env: { ...process.env, WBROWSER_PORT: String(PORT), WBROWSER_CDP_PORT: '39223',
      WBROWSER_CRED_FILE: credFile, WBROWSER_CRED_AUDIT: auditFile },
  });
  t.after(() => { try { engine.kill('SIGTERM'); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });

  assert.ok(await waitPort(PORT), 'engine did not start');

  const unlock = await post('/cred/unlock', { passphrase: 'master-pass-123' });
  assert.equal(unlock.status, 200, `unlock: ${unlock.body}`);

  const enroll = await post('/cred/enroll',
    { origin: 'example.com', username: 'alice@example.com', password: SECRET });
  assert.equal(enroll.status, 200, `enroll: ${enroll.body}`);
  assert.ok(!enroll.body.includes(SECRET), 'the secret came back in the enroll response');

  const audit = fs.readFileSync(auditFile, 'utf8');
  assert.ok(!audit.includes(SECRET), 'the secret leaked into the audit log');
  assert.ok(!audit.includes('alice@example.com'), 'the full username leaked into the audit log');
  assert.match(audit, /enroll\texample\.com/, 'the enroll was not audited');

  const enc = fs.readFileSync(credFile);
  assert.ok(!enc.includes(SECRET), 'the secret is stored in the clear in the vault file');

  // Give stdout a moment to flush, then check the engine never printed the secret.
  await new Promise((r) => setTimeout(r, 200));
  const log = fs.readFileSync(logFile, 'utf8');
  assert.ok(!log.includes(SECRET), 'the secret was printed to the engine log');

  const wrong = await post('/cred/unlock', { passphrase: 'not-the-passphrase' });
  assert.equal(wrong.status, 403, 'a wrong passphrase should be refused');
});
