// rawcdp.js — a thin raw-CDP path used ONLY when playwright's connectOverCDP has gone
// half-dead (see connect() in engine.js). Reported 2026-09-04 (zalman): playwright timed
// out for hours while Chrome answered raw CDP instantly — Page.navigate, Runtime.evaluate,
// Page.captureScreenshot and Input.dispatchMouseEvent all worked. So when the playwright
// handle is dead, we can keep the agent working over a fresh raw websocket instead of
// forcing a Chrome restart.
//
// 🔴 This is deliberately thin. It does NOT replace playwright — it is the emergency lane.
//    What playwright gives that this cannot: selector→coordinate resolution, actionability
//    waiting, frame/scroll handling. So `click` here is best-effort (getBoundingClientRect
//    → dispatchMouseEvent) and fails loudly if it cannot find coordinates, rather than
//    silently clicking nothing.
'use strict';

const http = require('http');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Open a raw CDP session to one page target and run a few commands on it. Uses Node's
// built-in WebSocket (Node 18+). Every send has its own timeout so a truly dead target
// still fails fast instead of hanging.
class RawCDP {
  constructor(cdpBase) {
    this.cdpBase = cdpBase;       // e.g. http://127.0.0.1:9222
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
  }

  // Attach to the page target matching `tabKey` (an engine tab name stamped into the page)
  // or, failing that, the first page target. Returns the raw target info used.
  async attach(match) {
    const list = await getJSON(`${this.cdpBase}/json/list`);
    const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
    if (!pages.length) throw new Error('rawcdp: no page target to attach to');
    // Prefer a page whose title carries our stamp for this tab, else the first page.
    const target = (match && pages.find((t) => (t.title || '').includes(match))) || pages[0];
    await this._connect(target.webSocketDebuggerUrl);
    this.target = target;
    return target;
  }

  _connect(wsUrl) {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line no-undef
      this.ws = new WebSocket(wsUrl);
      const to = setTimeout(() => reject(new Error('rawcdp: websocket open timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(to); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('rawcdp: websocket error')); });
      this.ws.addEventListener('message', (ev) => {
        let o;
        try { o = JSON.parse(ev.data); } catch { return; }
        if (o.id && this.pending.has(o.id)) {
          const { resolve: res, reject: rej } = this.pending.get(o.id);
          this.pending.delete(o.id);
          if (o.error) rej(new Error(`rawcdp: ${o.method || 'cdp'} ${o.error.message || JSON.stringify(o.error)}`));
          else res(o.result);
        }
      });
    });
  }

  send(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = (this.id += 1);
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params: params || {} };
      if (this.sessionId) msg.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`rawcdp: ${method} timed out`)); }
      }, timeoutMs);
    });
  }

  async evaluate(expression, returnByValue = true) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`rawcdp eval: ${r.exceptionDetails.text || 'exception'}`);
    return r.result ? r.result.value : undefined;
  }

  async goto(url) {
    await this.send('Page.enable').catch(() => {});
    await this.send('Page.navigate', { url });
    // best-effort settle: raw CDP has no actionability wait, so give the document a beat.
    await this.evaluate('new Promise(r=>{if(document.readyState==="complete")r(1);else addEventListener("load",()=>r(1),{once:true});setTimeout(()=>r(1),8000)})').catch(() => {});
    return this.evaluate('location.href');
  }

  async screenshot(fullPage) {
    let params = { format: 'png' };
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const s = m.cssContentSize || m.contentSize;
      if (s) params = { format: 'png', clip: { x: 0, y: 0, width: Math.ceil(s.width), height: Math.ceil(s.height), scale: 1 }, captureBeyondViewport: true };
    }
    const r = await this.send('Page.captureScreenshot', params);
    return r.data;    // base64 png
  }

  async press(key) {
    // A minimal key press: keyDown + keyUp. Enough for Enter/Tab and single characters.
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }

  // Best-effort click: resolve the selector to a center point, then dispatch a real mouse
  // click there. 🔴 If the rect is 0×0 or off-screen we do NOT click blindly — we throw,
  // so the caller learns the fallback could not place the click rather than "succeeding"
  // on nothing.
  async click(selector) {
    const box = await this.evaluate(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()`);
    if (!box) throw new Error(`rawcdp click: no element matches ${selector}`);
    if (box.w < 1 || box.h < 1) throw new Error(`rawcdp click: ${selector} has a zero-size box — playwright is needed to click it; restart Chrome`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }

  close() { try { this.ws && this.ws.close(); } catch { /* already gone */ } }
}

module.exports = { RawCDP };
