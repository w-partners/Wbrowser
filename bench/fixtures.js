// bench/fixtures.js — the fixed local pages the benchmark drives. Served on 127.0.0.1 by the
// runner. Deterministic and offline: no login, no network, so a clone gets the same pages and
// therefore the same score. Keep these tiny and stable — changing a fixture changes the score.

const PAGES = {
  '/basic': `<!doctype html><html><head><title>Bench Basic</title></head>
    <body><h1>Welcome</h1><p>A plain page for the benchmark.</p>
    <a href="/links">more</a></body></html>`,

  '/button': `<!doctype html><html><head><title>Bench Button</title></head>
    <body><h1>Button</h1><button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
    <div id="out">idle</div></body></html>`,

  '/form': `<!doctype html><html><head><title>Bench Form</title></head>
    <body><h1>Form</h1><label>Name <input id="name" name="name"></label>
    <button type="submit">Save</button></body></html>`,

  '/links': `<!doctype html><html><head><title>Bench Links</title></head>
    <body><h1>Links</h1><ul>
    <li><a href="/basic">Home</a></li>
    <li><a href="/docs">Docs</a></li>
    <li><a href="/about">About</a></li></ul></body></html>`,
};

module.exports = { PAGES };
