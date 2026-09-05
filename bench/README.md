# Wbrowser benchmark

A **reproducible** capability benchmark: `wb bench` (or `bash scripts/bench.sh`) launches a
throwaway headless Chrome on its own profile and ports — never the browser you use — serves a
fixed set of local pages, drives each task through the engine, and prints a score.

```
$ wb bench
tasks
  ok   navigate-and-read-title
  ok   read-finds-heading
  ok   click-a-button-changes-the-page
  ok   type-into-a-field
  ok   find-a-link-by-text
  ok   screenshot-is-nonempty

score: 6/6  (100.0%)
```

## What it is — and what it is not

🔴 **Honest framing.** This measures the tool against a **fixed, local** task set that anyone
can rerun and get the same number. It is a **floor of capability you can verify**, not a claim
of parity with benchmarks run on the live, logged-in web (Online-Mind2Web and the like) — those
cannot be rerun to the same score, so we do not quote a number against them.

## Files

- `tasks.js` — the task set (navigate/read/click/type/find/screenshot) and the pure scorer.
- `fixtures.js` — the fixed local pages. Changing a fixture changes the score, so keep them stable.
- `run.js` — serves the fixtures and drives each task through a running engine's `/act`.
- `../scripts/bench.sh` — sets up the isolated headless Chrome + engine and runs `run.js`.

## Adding a task

Add an entry to `TASKS` in `tasks.js` (and a fixture in `fixtures.js` if it needs a new page).
Each task is `{ id, steps, check }`; `check` is a pure predicate over the engine's reply. The
scorer and step→command mapping are unit-tested in `test/bench_*.test.js`.
