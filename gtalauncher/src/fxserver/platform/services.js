// src/fxserver/platform/services.js
// GTAMP Platform Services (mirrors Cfx.re's backend).
// Binds HTTP on 127.0.0.1, auto-advancing port on EADDRINUSE.

const http = require('http');
const crypto = require('crypto');
const net = require('net');

function findFreePort(startPort, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      if (p > startPort + 100) { resolve(startPort); return; }
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => {
        const a = srv.address().port;
        srv.close(() => resolve(a));
      });
      srv.listen(p, host);
    };
    tryPort(startPort);
  });
}

class PlatformServices {
  constructor(port = 22003) {
    this.port = port;
    this.accounts = new Map();
    this.servers = new Map();
    this.accountsByName = new Map();
    this.nextAccId = 1;
    this.server = http.createServer((req, res) => this._onReq(req, res));
  }

  async listen(port) {
    this.port = port || this.port;
    // Find a free port up-front to avoid EADDRINUSE issues
    this.port = await findFreePort(this.port);

    return new Promise((resolve) => {
      this.server.on('error', (e) => {
        console.log('[Platform] http error:', e.code || e.message);
      });
      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[Platform] services listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  getBaseUrl() { return `http://127.0.0.1:${this.port}`; }

  _json(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  }

  _body(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });
  }

  _onReq(req, res) {
    let u;
    try { u = new URL(req.url, `http://${req.headers.host}`); }
    catch { return this._json(res, 400, { error: 'bad url' }); }
    const p = u.pathname;

    if (p === '/auth/register' && req.method === 'POST') {
      this._body(req).then(body => {
        const name = (body.name || '').toString().slice(0, 32).trim();
        if (!name) return this._json(res, 400, { error: 'name required' });
        if (this.accountsByName.has(name.toLowerCase()))
          return this._json(res, 409, { error: 'name taken' });
        const token = crypto.randomBytes(16).toString('hex');
        const acc = { id: this.nextAccId++, name, token, created: Date.now(), banned: false };
        this.accounts.set(token, acc);
        this.accountsByName.set(name.toLowerCase(), token);
        this._json(res, 200, { token, name, id: acc.id });
      });
      return;
    }

    if (p === '/auth/login' && req.method === 'POST') {
      this._body(req).then(body => {
        const token = body.token;
        const acc = this.accounts.get(token);
        if (!acc || acc.banned) return this._json(res, 401, { error: 'bad token' });
        this._json(res, 200, { token: acc.token, name: acc.name, id: acc.id });
      });
      return;
    }

    if (p === '/servers' && req.method === 'GET') {
      const list = [];
      const now = Date.now();
      for (const [addr, s] of this.servers) {
        if (now - s.lastSeen > 30000) continue;
        list.push({ ...s, addr });
      }
      this._json(res, 200, list);
      return;
    }

    if (p === '/servers/heartbeat' && req.method === 'POST') {
      this._body(req).then(body => {
        if (!body.addr) return this._json(res, 400, { error: 'addr required' });
        body.lastSeen = Date.now();
        this.servers.set(body.addr, body);
        this._json(res, 200, { ok: true });
      });
      return;
    }

    if (p === '/update/manifest') {
      this._json(res, 200, { version: '1.0.0', build: 1, channel: 'release', url: null });
      return;
    }

    if (p === '/artifacts') {
      this._json(res, 200, [
        { version: '1.0.0', build: 1, recommended: true, notes: 'Initial release' }
      ]);
      return;
    }

    if (p === '/health') { this._json(res, 200, { ok: true }); return; }

    this._json(res, 404, { error: 'not found' });
  }

  registerLocalServer(info) {
    const addr = info.addr || '127.0.0.1:22005';
    this.servers.set(addr, { ...info, lastSeen: Date.now() });
    if (this._hb) clearInterval(this._hb);
    this._hb = setInterval(() => {
      const s = this.servers.get(addr);
      if (s) s.lastSeen = Date.now();
    }, 10000);
  }
}

module.exports = { PlatformServices, findFreePort };
