// bench/tasks.js — the reproducible benchmark task set + scoring.
//
// 🔴 Honesty first: we cannot reproduce Aside's headline numbers (Online-Mind2Web etc.) —
//    those run against live, logged-in sites, so nobody can rerun them and get the same score.
//    What IS reproducible is our tool's core capability against a FIXED, LOCAL set of pages: a
//    clone runs `wb bench`, gets the same pages, and gets the same score. That is a benchmark
//    you can trust because you can rerun it. This file defines the tasks and scores results;
//    the runner (bench/run — added next) serves the pages and drives them through the engine.
//
// Each task: { id, page, do, check }
//   page   which local fixture to load (served by the runner on 127.0.0.1)
//   do     the wb command sequence the runner will execute (as {op, args})
//   check  a pure predicate over the engine's reply — did the task succeed?
// The scorer counts checks that passed. No task needs a login or the network, so the number
// is deterministic and portable.

const TASKS = [
  {
    id: 'navigate-and-read-title',
    page: 'basic',
    steps: [{ op: 'go', args: ['/basic'] }],
    check: (r) => r.page && /Bench Basic/.test(r.page.title || ''),
  },
  {
    id: 'read-finds-heading',
    page: 'basic',
    steps: [{ op: 'go', args: ['/basic'] }, { op: 'read', args: [] }],
    check: (r) => r.page && (r.page.h1 === 'Welcome' || /Welcome/.test(JSON.stringify(r.page))),
  },
  {
    id: 'click-a-button-changes-the-page',
    page: 'button',
    steps: [{ op: 'go', args: ['/button'] }, { op: 'click', args: ['#go'] }],
    check: (r) => r.page && /clicked/i.test(JSON.stringify(r.page)),
  },
  {
    id: 'type-into-a-field',
    page: 'form',
    steps: [{ op: 'go', args: ['/form'] }, { op: 'type', args: ['#name', 'benchbot'] },
      { op: 'read', args: [] }],
    check: (r) => /benchbot/.test(JSON.stringify(r.page || {})),
  },
  {
    id: 'find-a-link-by-text',
    page: 'links',
    steps: [{ op: 'go', args: ['/links'] }, { op: 'read', args: [] }],
    check: (r) => r.page && Array.isArray(r.page.links)
      && r.page.links.some((l) => /Docs/.test(l.text || l)),
  },
  {
    id: 'screenshot-is-nonempty',
    page: 'basic',
    steps: [{ op: 'go', args: ['/basic'] }, { op: 'shot', args: [] }],
    check: (r) => typeof r.screenshot_b64 === 'string' && r.screenshot_b64.length > 1000,
  },
];

// score(results) — results is [{ id, ok }]. Returns { passed, total, rate } where rate is a
// 0..1 fraction. Kept pure so the number is testable without a browser.
function score(results) {
  if (!Array.isArray(results)) throw new Error('bench: results must be an array');
  const total = results.length;
  const passed = results.filter((r) => r && r.ok).length;
  return { passed, total, rate: total ? passed / total : 0 };
}

module.exports = { TASKS, score };
