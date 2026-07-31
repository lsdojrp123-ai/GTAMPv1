// src/server/game-server.js
// GTAMP Game Server + Master Server
// - Master HTTP server on port 22003: returns list of registered game servers
// - Game UDP server: handles player connection, chat, position sync
//
// In a real FiveM/alt:V this would be a massive C++ engine. For this PoC we do:
//   - UDP-based position sync (entity state broadcast)
//   - Chat relay
//   - Player join/leave
//   - JSON-over-UDP protocol

const dgram = require('dgram');
const http = require('http');
const crypto = require('crypto');

// ---------- Protocol ----------
// Packets are JSON lines with a leading type field.
// Client -> Server:
//   { t:"join", nick:"PlayerName" }
//   { t:"pos", x,y,z,h, speed }
//   { t:"chat", msg:"hello" }
//   { t:"ping" }
//   { t:"quit" }
// Server -> Client:
//   { t:"welcome", id:"...", server:{name,mode,max} }
//   { t:"players", list:[{id,nick,x,y,z,h}] }
//   { t:"join", id, nick }
//   { t:"leave", id }
//   { t:"pos", id, x,y,z,h }
//   { t:"chat", id, nick, msg }
//   { t:"pong", t:serverMs }

function encode(obj) { return Buffer.from(JSON.stringify(obj) + '\n'); }
function decode(buf) {
  try {
    const str = buf.toString('utf8').trim();
    if (!str) return null;
    return JSON.parse(str);
  } catch { return null; }
}

// ---------- Game Server ----------
class GameServer {
  constructor(opts = {}) {
    this.port = opts.port || 22005;
    this.name = opts.name || 'GTAMP Server';
    this.mode = opts.mode || 'Freeroam';
    this.max = opts.maxPlayers || 64;
    this.players = new Map(); // id -> { id, nick, addr, port, x, y, z, h, lastSeen }
    this.socket = dgram.createSocket('udp4');
    this.tickRate = 20; // hz
    this.tickInterval = null;
    this._setup();
  }

  _setup() {
    this.socket.on('error', (err) => { console.error('[GS] error', err); this.socket.close(); });
    this.socket.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
    this.socket.on('listening', () => {
      const addr = this.socket.address();
      console.log(`[GS] ${this.name} listening on UDP ${addr.address}:${addr.port}`);
    });
  }

  listen(port) {
    if (port) this.port = port;
    this.socket.bind(this.port);
    this.tickInterval = setInterval(() => this._tick(), 1000 / this.tickRate);
  }

  close() {
    clearInterval(this.tickInterval);
    this.socket.close();
  }

  _onPacket(buf, rinfo) {
    const pkt = decode(buf);
    if (!pkt || !pkt.t) return;
    const key = rinfo.address + ':' + rinfo.port;
    const player = this.players.get(key);

    switch (pkt.t) {
      case 'join': {
        if (this.players.size >= this.max) {
          this._send({ t: 'kick', reason: 'Server full' }, rinfo.port, rinfo.address);
          return;
        }
        const id = crypto.randomBytes(4).toString('hex');
        this.players.set(key, {
          id, nick: (pkt.nick || 'Guest').toString().slice(0, 24),
          addr: rinfo.address, port: rinfo.port,
          x: 0, y: 0, z: 72, h: 0,
          lastSeen: Date.now()
        });
        console.log(`[GS] ${id} "${pkt.nick}" joined from ${key}`);
        // Welcome
        this._send({
          t: 'welcome', id,
          server: { name: this.name, mode: this.mode, max: this.max },
          players: [...this.players.values()].filter(p => p.id !== id).map(p => ({
            id: p.id, nick: p.nick, x: p.x, y: p.y, z: p.z, h: p.h
          }))
        }, rinfo.port, rinfo.address);
        // Broadcast join
        this._broadcast({ t: 'join', id, nick: this.players.get(key).nick }, key);
        break;
      }
      case 'ping': {
        this._send({ t: 'pong', ts: pkt.ts || 0, server: Date.now() }, rinfo.port, rinfo.address);
        break;
      }
      case 'pos': {
        if (!player) return;
        player.x = typeof pkt.x === 'number' ? pkt.x : player.x;
        player.y = typeof pkt.y === 'number' ? pkt.y : player.y;
        player.z = typeof pkt.z === 'number' ? pkt.z : player.z;
        player.h = typeof pkt.h === 'number' ? pkt.h : player.h;
        player.lastSeen = Date.now();
        break;
      }
      case 'chat': {
        if (!player) return;
        const msg = (pkt.msg || '').toString().slice(0, 200);
        if (!msg) return;
        console.log(`[CHAT] ${player.nick}: ${msg}`);
        this._broadcast({ t: 'chat', id: player.id, nick: player.nick, msg });
        break;
      }
      case 'quit': {
        if (player) {
          this.players.delete(key);
          this._broadcast({ t: 'leave', id: player.id });
          console.log(`[GS] ${player.nick} left`);
        }
        break;
      }
    }
  }

  _tick() {
    const now = Date.now();
    // Timeout stale players (5s)
    for (const [key, p] of this.players) {
      if (now - p.lastSeen > 8000) {
        this.players.delete(key);
        this._broadcast({ t: 'leave', id: p.id });
        console.log(`[GS] ${p.nick} timed out`);
      }
    }
    // Periodic full state sync every 1s (position deltas would be better, this is PoC)
    if (!this._lastFullSync || now - this._lastFullSync > 1000) {
      this._lastFullSync = now;
      const list = [...this.players.values()].map(p => ({
        id: p.id, nick: p.nick, x: p.x, y: p.y, z: p.z, h: p.h
      }));
      this._broadcast({ t: 'players', list });
    }
  }

  _send(obj, port, address) {
    const buf = encode(obj);
    try { this.socket.send(buf, port, address); } catch {}
  }

  _broadcast(obj, exceptKey) {
    const buf = encode(obj);
    for (const [key, p] of this.players) {
      if (key === exceptKey) continue;
      try { this.socket.send(buf, p.port, p.addr); } catch {}
    }
  }

  getInfo() {
    return {
      name: this.name,
      addr: '127.0.0.1:' + this.port,
      mode: this.mode,
      players: this.players.size,
      max: this.max
    };
  }
}

// ---------- Master Server (HTTP) ----------
class MasterServer {
  constructor(port) {
    this.port = port;
    this.servers = new Map(); // addr -> info
    this.server = http.createServer((req, res) => this._onReq(req, res));
  }

  _onReq(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/servers' && req.method === 'GET') {
      res.end(JSON.stringify([...this.servers.values()]));
    } else if (req.url === '/register' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const info = JSON.parse(body);
          if (info.addr) {
            this.servers.set(info.addr, { ...info, lastSeen: Date.now() });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.end(JSON.stringify({ ok: false, err: 'addr required' }));
          }
        } catch { res.end(JSON.stringify({ ok: false, err: 'bad json' })); }
      });
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ err: 'not found' }));
    }
  }

  listen() {
    this.server.listen(this.port, () => {
      console.log(`[Master] listening on http://127.0.0.1:${this.port}`);
    });
    // Clean up dead servers periodically
    setInterval(() => {
      const now = Date.now();
      for (const [addr, info] of this.servers) {
        if (now - info.lastSeen > 30000) this.servers.delete(addr);
      }
    }, 10000);
  }

  register(info) {
    this.servers.set(info.addr, { ...info, lastSeen: Date.now() });
  }
}

// ---------- Boot when run standalone OR imported ----------
function initMaster(masterPort = 22003) {
  const master = new MasterServer(masterPort);
  master.listen();

  // Auto-start a default server (the official freeroam one)
  const official = new GameServer({
    port: 22005,
    name: 'GTAMP Official #1 - Freeroam',
    mode: 'Freeroam',
    maxPlayers: 64
  });
  official.listen();

  // Register with master
  master.register(official.getInfo());

  // Re-register every 10s
  setInterval(() => master.register(official.getInfo()), 10000);

  return { master, official };
}

// If run directly from command line
if (require.main === module) {
  const port = parseInt(process.env.GTAMP_PORT) || 22005;
  if (process.argv.includes('--master')) {
    initMaster(parseInt(process.env.GTAMP_MASTER_PORT) || 22003);
  } else {
    const gs = new GameServer({
      port,
      name: process.env.GTAMP_NAME || 'GTAMP Server',
      mode: process.env.GTAMP_MODE || 'Freeroam'
    });
    gs.listen();
  }
}

module.exports = { GameServer, MasterServer, initMaster };
