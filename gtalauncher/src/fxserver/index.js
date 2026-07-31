#!/usr/bin/env node
// src/fxserver/index.js
// GTAMP FXServer - authoritative game server (FiveM-style).
// 13-stage architecture: auth -> server list -> connect -> resource discovery ->
// resource loading -> NUI -> character load -> spawn -> continuous sync -> streaming -> runtime.

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const { PlatformServices, findFreePort } = require('./platform/services');
const { EntityManager } = require('./managers/entity');
const { PlayerManager } = require('./managers/player');
const { VehicleManager } = require('./managers/vehicle');
const { EventDispatcher } = require('./managers/events');
const { RuntimeManager } = require('./runtimes');
const { Database } = require('./database');

const TICK_HZ = 20;
const STREAM_RADIUS = 500;
const CLIENT_RESOURCE_PORT_BASE = 22010;

class FXServer {
  constructor(opts = {}) {
    this.platformPort = opts.platformPort || 0;
    this.gamePort = opts.port || opts.gamePort || 0;
    this.serverName = opts.name || 'GTAMP Server';
    this.maxPlayers = opts.maxPlayers || opts.max || 32;
    this.gamemode = opts.gamemode || opts.mode || 'freeroam';
    this.lanOnly = !!opts.lanOnly;
    this.isPublic = !!opts.isPublic;
    this.description = opts.description || '';
    this._tickTimer = null;
    this.em = new EntityManager();
    this.pm = new PlayerManager(this.em);
    this.vmgr = new VehicleManager(this.em);
    this.events = new EventDispatcher();
    this.db = null;
    this.socket = dgram.createSocket('udp4');
    this.runtimes = null;
    this.platform = null;
    this.seq = 0;
    this.pendingAcks = new Map();
    this.resourceServer = null;
    this.resourcePort = 0;
    this.started = false;
  }

  _setup() {
    this.socket.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
    this.socket.on('error', (e) => {
      if (!this.started) return;
      console.error('[FXServer] socket error:', e.message);
    });
  }

  _epKey(rinfo) { return `${rinfo.address}:${rinfo.port}`; }

  _send(obj, rinfo, reliable = false, channel = 0) {
    try {
      const data = Buffer.from(JSON.stringify(obj) + '\n');
      if (reliable) {
        const seq = this.seq++;
        const pkt = Buffer.alloc(data.length + 6);
        pkt.writeUInt8(0x02, 0);
        pkt.writeUInt8(channel, 1);
        pkt.writeUInt32BE(seq >>> 0, 2);
        data.copy(pkt, 6);
        this.socket.send(pkt, rinfo.port, rinfo.address);
        const key = this._epKey(rinfo);
        if (!this.pendingAcks.has(key)) this.pendingAcks.set(key, { rinfo, map: new Map() });
        this.pendingAcks.get(key).map.set(seq, { buf: pkt, sent: Date.now(), retries: 0 });
      } else {
        this.socket.send(data, rinfo.port, rinfo.address);
      }
    } catch (e) { /* ignore */ }
  }

  _broadcast(obj, reliable = false) {
    for (const p of this.pm.getAll()) {
      if (p.endpoint) this._send(obj, p.endpoint, reliable);
    }
  }

  _playersNear(pos, radius = STREAM_RADIUS, dimension = 0) {
    const r2 = radius * radius;
    return this.pm.getAll().filter(p => {
      if (p.dimension !== dimension || !p.spawned || !p.ped) return false;
      const dx = p.ped.pos.x - pos.x, dy = p.ped.pos.y - pos.y, dz = p.ped.pos.z - pos.z;
      return dx*dx + dy*dy + dz*dz <= r2;
    });
  }

  _findPlayerByEndpoint(rinfo) {
    for (const p of this.pm.getAll()) {
      if (p.endpoint && p.endpoint.address === rinfo.address && p.endpoint.port === rinfo.port) return p;
    }
    return null;
  }

  _findPlayer(nameOrToken) {
    return this.pm.getAll().find(p => p.name === nameOrToken || p.token === nameOrToken || p.netId === nameOrToken);
  }

  _onPacket(buf, rinfo) {
    // Reliable packet? strip header
    let pktData = buf;
    let reliableHeader = null;
    if (buf.length >= 6 && buf[0] === 0x02) {
      reliableHeader = { channel: buf[1], seq: buf.readUInt32BE(2) };
      pktData = buf.slice(6);
      this._send({ t: 'ack', seq: reliableHeader.seq }, rinfo, false);
    }
    let pkt;
    try { pkt = JSON.parse(pktData.toString('utf8').trim()); } catch { return; }
    if (!pkt || !pkt.t) return;

    // Phase 6: keep disconnect-timeout accurate
    {
      const _p = this._findPlayerByEndpoint(rinfo);
      if (_p) _p.lastSeen = Date.now();
    }

    switch (pkt.t) {
      case 'join': this._handleJoin(pkt, rinfo); break;
      case 'ack': {
        const entry = this.pendingAcks.get(this._epKey(rinfo));
        if (entry) entry.map.delete(pkt.seq);
        break;
      }
      case 'pos': this._handlePos(pkt, rinfo); break;
      case 'chat': this._handleChat(pkt, rinfo); break;
      case 'cmd': this._handleCmd(pkt, rinfo); break;
      case 'event': this._handleEvent(pkt, rinfo); break;
      case 'ping': {
        const player = this._findPlayerByEndpoint(rinfo);
        if (player) player.pingMs = Date.now() - (pkt.ts || Date.now());
        this._send({ t: 'pong', ts: pkt.ts, server: Date.now() }, rinfo);
        break;
      }
      case 'quit': {
        const p = this._findPlayerByEndpoint(rinfo);
        if (p) this._removePlayer(p);
        break;
      }
      case 'resourceAck': {
        // client is done loading
        const player = this._findPlayerByEndpoint(rinfo);
        if (player) {
          player.resourcesLoaded = true;
          console.log(`[FXServer] ${player.name} loaded resources, finalizing spawn`);
          this._finalizeSpawn(player);
        }
        break;
      }
      case 'spawnComplete': {
        const player = this._findPlayerByEndpoint(rinfo);
        if (player && !player.spawned) {
          player.spawned = true;
          player.lastSeen = Date.now();
          if (pkt.model) player.model = pkt.model;
          this.events.emit('playerSpawned', player);
          // Phase 6: tell OTHER clients only (never echo join to self)
          const joinPkt = {
            t: 'playerJoin', netId: player.netId, name: player.name,
            pos: player.ped.pos, h: player.ped.state.get('h') || 0,
            model: player.model || 'mp_m_freemode_01', health: 200, vehicle: 0
          };
          for (const other of this.pm.getAll()) {
            if (other === player || !other.endpoint) continue;
            this._send(joinPkt, other.endpoint, true);
          }
          console.log(`[FXServer] ${player.name} spawned at ${JSON.stringify(player.ped.pos)} model=${player.model}`);
        }
        break;
      }
      case 'vehEnter': case 'vehExit': case 'vehCreate': case 'vehDelete':
        // Vehicle sync events
        this.events.emit('net:' + pkt.t, this._findPlayerByEndpoint(rinfo), pkt);
        break;
      case 'damage': {
        const player = this._findPlayerByEndpoint(rinfo);
        if (player && player.ped) {
          player.ped.state.set('health', Math.max(0, pkt.health ?? player.ped.state.get('health')));
        }
        break;
      }
    }
  }

  _handleJoin(pkt, rinfo) {
    const name = (pkt.nick || 'Player').toString().slice(0, 32).trim() || 'Player';
    const token = pkt.token || null;

    // Guard: if resources haven't finished loading yet, defer the join briefly
    if (!this.runtimes || !this.db) {
      console.log(`[FXServer] join from ${name} before init complete, deferring 500ms`);
      setTimeout(() => this._handleJoin(pkt, rinfo), 500);
      return;
    }

    // Idempotency: if this endpoint is already joined, ignore duplicate join packets
    const existing = this._findPlayerByEndpoint(rinfo);
    if (existing) {
      // Player already exists — re-send welcome in case they missed it
      this._sendWelcome(existing);
      return;
    }

    // STAGE 9: Character loading
    const u = this.db.findOrCreateUser(name, token || name);

    const player = this.pm.add(name, {
      port: rinfo.port, address: rinfo.address,
      send: (obj, rel) => this._send(obj, rinfo, rel !== false)
    }, token);

    player.dbId = u.id;
    player.money = u.money ?? 5000;
    player.bank = u.bank ?? 25000;
    player.token = token || name;
    player.model = u.model || 'mp_m_freemode_01';
    player.appearance = u.appearance ? (typeof u.appearance === 'string' ? JSON.parse(u.appearance) : u.appearance) : {};
    try {
      const p = typeof u.position === 'string' ? JSON.parse(u.position) : u.position;
      if (p && typeof p.x === 'number') player.ped.pos = p;
      else player.ped.pos = { x: 0, y: 0, z: 72 };
    } catch { player.ped.pos = { x: 0, y: 0, z: 72 }; }
    player.inventory = u.inventory ? (typeof u.inventory === 'string' ? JSON.parse(u.inventory) : u.inventory) : {};
    player.vehicles = u.vehicles ? (typeof u.vehicles === 'string' ? JSON.parse(u.vehicles) : u.vehicles) : [];
    player._welcomed = false;
    player._spawned = false;

    player.lastSeen = Date.now();
    this.events.emit('playerJoining', player);
    console.log(`[FXServer] ${name} joined (#${player.netId}) from ${rinfo.address}:${rinfo.port}`);
    this._sendWelcome(player);

    // Heartbeat
    if (this.platform) {
      this.platform.registerLocalServer({
        name: 'GTAMP Official #1 - Freeroam',
        mode: 'Freeroam', players: this.pm.count(), max: 64, version: '1.0.0',
        tags: ['freeroam', 'pvp', 'custom-cars']
      });
    }
  }

  _sendWelcome(player) {
    if (player._welcomed) return;
    player._welcomed = true;
    const rinfo = player.endpoint;
    if (!rinfo) return;
    const resources = this.runtimes.gatherClientScripts();
    const resourceFiles = this.runtimes.gatherResourceFiles();
    this._send({
      t: 'welcome',
      netId: player.netId,
      server: {
        name: 'GTAMP Official #1 - Freeroam',
        port: this.actualPort,
        resPort: this.resourcePort,
        mode: 'Freeroam',
        icon: 'default',
        desc: 'Default GTAMP freeroam server'
      },
      spawn: player.ped.pos,
      model: player.model,
      money: player.money,
      bank: player.bank,
      resources,
      resourceFiles,
      inventory: player.inventory,
      vehicles: player.vehicles,
      appearance: player.appearance,
      maxplayers: 64
    }, rinfo, true);
  }

  _finalizeSpawn(player) {
    if (player._finalized) return;
    player._finalized = true;
    // STAGE 10: tell client to spawn
    player.send({
      t: 'spawn',
      pos: player.ped.pos,
      model: player.model,
      skin: player.appearance,
      weather: 'CLEAR',
      time: { h: 12, m: 0 }
    });
    // Send existing players/entities
    const existing = this.pm.getAll().filter(p => p.netId !== player.netId && p.spawned);
    for (const other of existing) {
      player.send({
        t: 'playerJoin',
        netId: other.netId, name: other.name,
        pos: other.ped.pos, h: other.ped.state.get('h') || 0,
        health: other.ped.state.get('health') ?? 200,
        model: other.model || 'mp_m_freemode_01',
        vehicle: other.vehicle ? other.vehicle.id : 0
      });
    }
    this.events.emit('playerJoined', player);
  }

  _handlePos(pkt, rinfo) {
    const player = this._findPlayerByEndpoint(rinfo);
    if (!player || !player.spawned || !player.ped) return;
    const dt = 1 / TICK_HZ;
    const newPos = { x: +pkt.x || 0, y: +pkt.y || 0, z: +pkt.z || 0 };
    const maxSpeed = player.vehicle ? 100 : 14;
    if (pkt.model) player.model = pkt.model;
    if (this.em.validateMovement(player.ped, newPos, dt, maxSpeed)) {
      player.ped.pos = newPos;
      player.ped.vel = { x: pkt.vx||0, y: pkt.vy||0, z: pkt.vz||0 };
      player.ped.state.set('h', pkt.h||0);
      player.ped.state.set('health', pkt.health ?? 200);
      player.ped.state.set('inVeh', pkt.inVeh || 0);
      if (pkt.armour != null) player.ped.state.set('armour', pkt.armour);
    }
    // Phase 5: broadcast position to other nearby players ~15Hz
    const now = Date.now();
    if (!player._lastPosBroadcast || now - player._lastPosBroadcast > 66) {
      player._lastPosBroadcast = now;
      const pktOut = {
        t: 'playerPos',
        netId: player.netId, name: player.name, model: player.model || 'mp_m_freemode_01',
        x: player.ped.pos.x, y: player.ped.pos.y, z: player.ped.pos.z,
        h: player.ped.state.get('h') || 0,
        health: player.ped.state.get('health') ?? 200,
        armour: player.ped.state.get('armour') ?? 0,
        vx: player.ped.vel?.x || 0, vy: player.ped.vel?.y || 0, vz: player.ped.vel?.z || 0,
        inVeh: player.ped.state.get('inVeh') || 0
      };
      // Send to all OTHER spawned players (reliable=false — pos is fire-and-forget)
      for (const other of this.pm.getAll()) {
        if (other === player || !other.spawned || !other.endpoint) continue;
        this._send(pktOut, other.endpoint, false, 0);
      }
    }
  }

  _handleChat(pkt, rinfo) {
    const player = this._findPlayerByEndpoint(rinfo);
    if (!player) return;
    const msg = (pkt.msg || '').toString().slice(0, 256);
    if (!msg.trim()) return;
    // Commands start with /
    if (msg.startsWith('/')) {
      const parts = msg.slice(1).split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);
      this.events.emit('cmd:' + cmd, player, args);
      return;
    }
    this.events.emit('chatMessage', player, msg);
    console.log(`[CHAT] ${player.name}: ${msg}`);
    this._broadcast({ t: 'chat', netId: player.netId, name: player.name, msg });
  }

  _handleCmd(pkt, rinfo) {
    const player = this._findPlayerByEndpoint(rinfo);
    if (!player) return;
    const cmd = (pkt.cmd || '').toString().toLowerCase();
    this.events.emit('cmd:' + cmd, player, pkt.args || []);
  }

  _handleEvent(pkt, rinfo) {
    const player = this._findPlayerByEndpoint(rinfo);
    if (!player) return;
    this.events.handleClientEvent(player, pkt.name, pkt.args || []);
  }

  _removePlayer(p) {
    try {
      this.db.updateUser(p.token || p.name, {
        position: JSON.stringify(p.ped ? p.ped.pos : {x:0,y:0,z:72}),
        money: p.money, bank: p.bank,
        last_seen: Date.now()
      });
    } catch {}
    this._broadcast({ t: 'playerLeft', netId: p.netId, name: p.name });
    this.events.emit('playerDropped', p, 'Disconnected');
    console.log(`[FXServer] ${p.name} left (#${p.netId})`);
    this.pm.remove(p.netId);
    if (p.endpoint) this.pendingAcks.delete(this._epKey(p.endpoint));
  }

  _startResourceFileServer() {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        try {
          const u = new URL(req.url, 'http://x');
          // Resolve resource name and file path
          const m = u.pathname.match(/^\/res\/([^/]+)\/(.+)$/);
          if (!m) { res.writeHead(404); res.end(); return; }
          const resName = m[1], filePath = m[2];
          const resDir = this.runtimes.resourceDirs.get(resName);
          if (!resDir) { res.writeHead(404); res.end(); return; }
          const full = path.join(resDir, filePath);
          // Prevent escape
          if (!full.startsWith(resDir)) { res.writeHead(403); res.end(); return; }
          if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
          const ext = path.extname(full).toLowerCase();
          const ct = {
            '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
            '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
            '.svg':'image/svg+xml', '.ogg':'audio/ogg', '.wav':'audio/wav'
          }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=60' });
          fs.createReadStream(full).pipe(res);
        } catch (e) { res.writeHead(500); res.end(); }
      });
      findFreePort(CLIENT_RESOURCE_PORT_BASE).then(port => {
        srv.listen(port, '127.0.0.1', () => {
          this.resourceServer = srv;
          this.resourcePort = port;
          console.log(`[FXServer] resource http server on http://127.0.0.1:${port}`);
          resolve();
        });
      });
    });
  }

  _tick() {
    const now = Date.now();

    // Retry reliable
    for (const [key, entry] of this.pendingAcks) {
      for (const [seq, info] of entry.map) {
        if (now - info.sent > 200 + info.retries * 100) {
          try { this.socket.send(info.buf, entry.rinfo.port, entry.rinfo.address); } catch {}
          info.sent = now; info.retries++;
          if (info.retries > 10) entry.map.delete(seq);
        }
      }
      if (entry.map.size === 0) this.pendingAcks.delete(key);
    }

    // Snapshot streaming (STAGE 12: interest management)
    for (const p of this.pm.getAll()) {
      if (!p.spawned || !p.ped) continue;
      const nearby = this._playersNear(p.ped.pos, STREAM_RADIUS, p.dimension)
                       .filter(x => x.netId !== p.netId);
      const entities = [];
      for (const other of nearby) {
        entities.push({
          id: other.ped.id, netId: other.netId, name: other.name,
          type: 'player', pos: other.ped.pos,
          h: other.ped.state.get('h') || 0,
          health: other.ped.state.get('health') ?? 200,
          model: other.model || 'mp_m_freemode_01',
          vehicle: other.vehicle ? other.vehicle.id : 0
        });
      }
      const nearVehicles = this.em.getInRadius(p.ped.pos, STREAM_RADIUS, p.dimension)
                             .filter(e => e.type === 'vehicle');
      for (const v of nearVehicles) {
        entities.push({
          id: v.id, type: 'vehicle', model: v.model, pos: v.pos,
          rot: v.rot, state: Object.fromEntries(v.state)
        });
      }
      this._send({
        t: 'snapshot', tick: now,
        self: { pos: p.ped.pos, health: p.ped.state.get('health') ?? 200, money: p.money, bank: p.bank },
        entities,
        nearby: entities.length
      }, p.endpoint);
    }

    // Time out stale players
    for (const p of this.pm.getAll()) {
      if (p.lastSeen && now - p.lastSeen > 15000) {
        this._removePlayer(p);
        break;
      }
    }
  }

  async start() {
    this._setup();

    // Choose free ports
    this.platformPort = await findFreePort(this.platformPort);
    this.gamePort = await findFreePort(this.gamePort);

    // DB (user data dir)
    try {
      const userData = process.env.GTAMP_USER_DATA || path.join(require('os').homedir(), '.gtamp');
      fs.mkdirSync(userData, { recursive: true });
      this.db = new Database(path.join(userData, 'gtamp-data'));
    } catch (e) {
      this.db = new Database(path.join(process.cwd(), 'gtamp-data'));
    }

    // Platform services
    this.platform = new PlatformServices(this.platformPort);
    await this.platform.listen();

    // Game UDP
    await new Promise((resolve) => {
      this.socket.once('listening', () => {
        const a = this.socket.address();
        this.actualPort = a.port;
        console.log(`[FXServer] listening on UDP ${a.address}:${a.port}`);
        this.platform.registerLocalServer({
          name: this.serverName,
          addr: `127.0.0.1:${a.port}`,
          mode: this.gamemode, players: 0, max: this.maxPlayers, version: '1.0.0',
          tags: [this.gamemode, this.lanOnly?'lan':'local', this.isPublic?'public':''].filter(Boolean),
          ping: 0
        });
        resolve();
      });
      this.socket.bind(this.gamePort, '127.0.0.1');
    });

    // Resource file server (STAGE 6+8: resource download / NUI)
    await this._startResourceFileServer();

    // Wire events
    this.events.broadcast = (pkt) => this._broadcast(pkt, false);
    this.events.playersNear = (pos, r, d) => this._playersNear(pos, r, d);

    // Load resources
    const resRoot = path.join(__dirname, 'resources');
    this.runtimes = new RuntimeManager(resRoot, this.events, this.em, this.pm,
                                        this.vmgr, this.db,
                                        (pkt) => this._broadcast(pkt),
                                        this.resourcePort);
    this.runtimes.discover();
    this.runtimes.startAll();

    // Built-in commands
    this.events.on('cmd:stop', 'console', (player) => {
      if (player) player.send({ t: 'chat', name: 'SERVER', msg: 'Shutting down...' });
      setTimeout(() => process.exit(0), 500);
    });
    this.events.on('cmd:players', (player) => {
      player.send({ t: 'chat', name: 'SERVER', msg: `Players online: ${this.pm.count()}` });
    });

    this._tickTimer = setInterval(() => this._tick(), 1000 / TICK_HZ);

    this.started = true;
    console.log(`[FXServer] ready (game UDP ${this.actualPort}, platform http ${this.platformPort}, res http ${this.resourcePort})`);

    process.on('SIGINT', () => {
      console.log('\n[FXServer] shutting down');
      this._broadcast({ t: 'kick', reason: 'Server shutting down' });
      process.exit(0);
    });

    return {
      gamePort: this.actualPort,
      platformPort: this.platformPort,
      resourcePort: this.resourcePort,
      platformUrl: this.platform.getBaseUrl()
    };
  }

  stop() {
    try { if (this._tickTimer) clearInterval(this._tickTimer); } catch {}
    try { this.socket.close(); } catch {}
    try { if (this.platform && typeof this.platform.close === 'function') this.platform.close(); } catch {}
    try { if (this.resourceServer) this.resourceServer.close(); } catch {}
    this.started = false;
    console.log(`[FXServer] stopped (was ${this.serverName} on ${this.actualPort})`);
  }
}

if (require.main === module) {
  const server = new FXServer();
  server.start().then(info => {
    console.log('[FXServer] started:', info);
  }).catch(e => {
    console.error('[FXServer] failed to start:', e);
    process.exit(1);
  });
}

module.exports = { FXServer };
