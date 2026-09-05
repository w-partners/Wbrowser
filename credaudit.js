// credaudit.js — an append-only record of credential use. Every enroll and every autologin
// writes one line here; the values themselves never do.
//
// 🔴 Security contract (docs/DESIGN-credential-vault.md, property 4): a line records WHICH
//    site, WHICH field/action, and WHEN — never the username in full, never the secret. The
//    log is what lets the user answer "what did the agent touch"; it must be safe to read.
//    Append-only: we never rewrite earlier lines, so the record is tamper-evident by absence
//    of edits (a later integrity check can hash-chain if needed; out of scope here).
//
// Pure formatting is separated from the file append so the format is unit-testable without
// touching disk. The engine calls append(); tests call formatLine().

const fs = require('fs');

// Mask a username so the log can say "which account" without storing the identifier in full.
// Keeps the first char and the domain of an email; otherwise first char + length.
function maskUser(user) {
  const u = (user || '').toString();
  if (!u) return '(none)';
  const at = u.indexOf('@');
  if (at > 0) return `${u[0]}***@${u.slice(at + 1)}`;
  return `${u[0]}***(${u.length})`;
}

// formatLine({ ts, action, origin, user, field, note }) -> a single audit line (no trailing \n).
// ts is passed in (never generated here) so the line is deterministic and testable, and so the
// engine controls the clock. action is 'enroll' | 'autologin' | 'refused' | ...
function formatLine(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('credaudit: event must be an object');
  const ts = ev.ts || '';
  const action = (ev.action || 'unknown').toString();
  const origin = (ev.origin || '(unknown)').toString();
  const parts = [ts, action, origin];
  if (ev.user !== undefined) parts.push(`user=${maskUser(ev.user)}`);
  if (ev.field) parts.push(`field=${ev.field}`);
  if (ev.note) parts.push(`note=${ev.note.toString().replace(/\s+/g, ' ').slice(0, 120)}`);
  const line = parts.join('\t');
  // 🔴 Defence in depth: if a caller ever passes a raw secret by mistake, at least never let a
  //    newline split it across the append boundary. The value still should not be here at all.
  return line.replace(/[\r\n]+/g, ' ');
}

function append(file, ev) {
  fs.appendFileSync(file, formatLine(ev) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

module.exports = { formatLine, append, maskUser };
