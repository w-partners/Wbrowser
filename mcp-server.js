#!/usr/bin/env node
// mcp-server.js — exposes wbrowser as MCP tools.
//
//   local (stdio):   node mcp-server.js
//   remote (http):   WBROWSER_MCP_TOKEN=<token> node mcp-server.js --http [--port 7982] [--host 0.0.0.0]
//
// 🔴 Remote mode does not start without a token.
//    This server drives an "already logged-in browser". Opening it without auth means
//    every session in that browser (mail, banking, work systems) belongs to whoever can
//    reach that port. A design that makes the token optional for convenience is not
//    allowed here.

// 🔴 If dependencies are missing, require blows up first and hides guidance such as
//    "a token is required" (measured). It is not a security flaw, but the user never
//    sees the real cause and gets only a stack trace. Check first and explain in
//    human words.
require('./preflight').requireInstalled();
// 🔵 The MCP SDK is only needed here, so it stays a local check.
try {
  require.resolve('@modelcontextprotocol/sdk/server/index.js');
} catch {
  console.error('❌ The MCP SDK is not installed.');
  console.error('   Run this in this directory:  npm install');
  process.exit(1);
}

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');
const crypto = require('crypto');

const ENGINE = process.env.WBROWSER_ENGINE || 'http://127.0.0.1:7981';
// Agent name — records in the banner and journal which client is driving.
const AGENT = process.env.WBROWSER_AGENT || 'mcp';

// ---------------------------------------------------------------- engine calls

function post(path, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(ENGINE + path);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('Could not parse the engine response')); }
      });
    });
    req.on('error', (e) => reject(new Error(
      `Could not connect to the engine (${ENGINE}). Are the browser and the engine running? — ${e.message}`,
    )));
    req.on('timeout', () => { req.destroy(); reject(new Error('Engine response timed out')); });
    req.end(data);
  });
}

function get(path, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(ENGINE + path);
    const req = http.get({
      hostname: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('Could not parse the engine response')); }
      });
    });
    req.on('error', (e) => reject(new Error(`Engine connection failed (${ENGINE}) — ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Engine response timed out')); });
  });
}

// Attach agent to every act call — so the banner and journal record who did it.
const act = (cmd) => post('/act', { agent: AGENT, ...cmd });

// ---------------------------------------------------------------- tool definitions

const TOOLS = [
  {
    name: 'browser_open',
    description: 'Opens the given URL and returns a summary of the page structure '
      + '(title, links, buttons, input fields). Do not guess selectors — use the ones '
      + 'printed in this result.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the address to open' },
        tab: { type: 'string', description: 'tab name. defaults to main when omitted' },
        account: { type: 'string', description: 'account/profile hint (e.g. work@example.com, "Profile 1")' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description: 'Returns a summary of the current screen structure. Includes the body text and clickable selectors.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string' }, account: { type: 'string' } },
    },
  },
  {
    name: 'browser_click',
    description: 'Clicks an element by CSS selector. Also returns a summary of the screen after the click.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        tab: { type: 'string' }, account: { type: 'string' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: 'Enters text into an input field. '
      + '🔴 Do not enter passwords, card numbers, or national ID numbers — the user must type those themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        tab: { type: 'string' }, account: { type: 'string' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_press',
    description: 'Presses a key (Enter, Tab, Escape, ArrowDown …). '
      + '🔵 If you are repeating a key to add rows or items, count after each press and stop '
      + 'when you reach the target. Sending 8 presses in a row once produced 40 rows — the '
      + 'page processed them faster than expected.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        tab: { type: 'string' }, account: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_eval',
    description: 'Runs JavaScript in the page context and returns its value. '
      + 'Use it for complex form manipulation or DOM queries. '
      + '🔵 Frameworks like React ignore direct value assignment. Use the native setter '
      + '(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set) followed by '
      + 'input and change events — or fall back to browser_type, which sends real keystrokes.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'the JS to run. The last expression becomes the return value.' },
        tab: { type: 'string' }, account: { type: 'string' },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser_console',
    description: 'Returns console logs, uncaught exceptions, and failed network requests. For debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'regex filter (optional)' },
        tab: { type: 'string' }, account: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Captures the current screen as a PNG and returns it as an image.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'the whole page (default: only the visible area)' },
        tab: { type: 'string' }, account: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_tabs',
    description: 'Returns the list of open tabs and the agent that opened each one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_status',
    description: 'Returns whether the browser and engine are alive, which profile they are '
      + 'attached to, and how many login cookies there are.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- execution

function textOut(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

async function runTool(name, a) {
  const common = { tab: a.tab, account: a.account };

  switch (name) {
    case 'browser_open':
      return textOut(await act({ ...common, goto: a.url, read: true }));
    case 'browser_read':
      return textOut(await act({ ...common, read: true }));
    case 'browser_click':
      return textOut(await act({ ...common, click: a.selector, wait: 1200, read: true }));
    case 'browser_type':
      return textOut(await act({ ...common, type: { selector: a.selector, text: a.text } }));
    case 'browser_press':
      return textOut(await act({ ...common, press: a.key, wait: 1500, read: true }));
    case 'browser_eval':
      return textOut(await act({ ...common, eval: a.code }));
    case 'browser_console':
      return textOut(await act({
        ...common, console: true, errors: true, network: true, filter: a.filter, limit: 60,
      }));
    case 'browser_screenshot': {
      const r = await act({ ...common, shot: true, fullPage: !!a.fullPage });
      if (r.error) return textOut(r);
      if (!r.screenshot_b64) return textOut({ error: 'the screenshot is empty' });
      return { content: [{ type: 'image', data: r.screenshot_b64, mimeType: 'image/png' }] };
    }
    case 'browser_tabs':
      return textOut(await get('/tabs'));
    case 'browser_status': {
      const [h, l] = await Promise.all([
        get('/health').catch((e) => ({ error: e.message })),
        get('/logins').catch((e) => ({ error: e.message })),
      ]);
      return textOut({ health: h, logins: l });
    }
    default:
      return textOut({ error: `unknown tool: ${name}` });
  }
}

function buildServer() {
  const server = new Server(
    // 🔴 One version, in package.json. It used to be written here too, and two copies of a
    //    version number drift the moment someone bumps one of them.
    { name: 'wbrowser', version: require('./package.json').version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await runTool(name, args || {});
    } catch (e) {
      // 🔴 Do not swallow failures silently. Surface the cause as-is.
      return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
    }
  });
  return server;
}

// ---------------------------------------------------------------- transports

async function runStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // In stdio mode stdout is the protocol channel — emit logs to stderr only.
  process.stderr.write(`wbrowser MCP (stdio) → engine ${ENGINE}\n`);
}

async function runHttp(port, host) {
  const token = process.env.WBROWSER_MCP_TOKEN;
  if (!token || token.length < 16) {
    console.error('❌ Remote mode requires WBROWSER_MCP_TOKEN (16 characters or more).');
    console.error('   This server drives a logged-in browser — it cannot be opened without auth.');
    console.error('   Example to generate one: openssl rand -hex 32');
    process.exit(1);
  }
  const { StreamableHTTPServerTransport } =
    require('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const expected = Buffer.from(`Bearer ${token}`);
  const httpServer = http.createServer(async (req, res) => {
    // Constant-time comparison — so the token's length and content do not leak via timing
    const got = Buffer.from(req.headers.authorization || '');
    const ok = got.length === expected.length && crypto.timingSafeEqual(got, expected);
    if (!ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'authentication failed' }));
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    return transport.handleRequest(req, res);
  });

  httpServer.listen(port, host, () => {
    console.error(`wbrowser MCP (http) http://${host}:${port} → engine ${ENGINE}`);
    if (host === '0.0.0.0' || host === '::') {
      console.error('🔴 This is open on all interfaces. Use it only on a trusted network (VPN/tailnet).');
    }
  });
}

const argv = process.argv.slice(2);
const isHttp = argv.includes('--http');
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (isHttp) {
  runHttp(Number(argOf('--port', 7982)), argOf('--host', '127.0.0.1'));
} else {
  runStdio().catch((e) => { process.stderr.write(`FATAL ${e.message}\n`); process.exit(1); });
}
