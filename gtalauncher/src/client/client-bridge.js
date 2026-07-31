#!/usr/bin/env node
// src/client/client-bridge.js
// GTAMP Client Bridge - runs alongside/inside the game.
// Implements stages 4-12 from the client perspective:
//   server list (via platform) -> connect -> resource discovery ->
//   resource download -> resource loading -> NUI -> spawn -> sync -> streaming.
//
// When the C++ hook DLL is active, it connects to this bridge via TCP 22100
// and feeds real game data. Without the DLL (or if patterns don't match this
// GTA build), the bridge simulates movement so the full pipeline still works.

const dgram = require('dgram');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const WebSocket = require('ws');

// ---- Config ----
const serverAddr = process.env.GTAMP_SERVER || '127.0.0.1:22005';
const [host, portStr] = serverAddr.split(':');
const port = parseInt(portStr) || 22005;
const nick = process.env.GTAMP_NICK || 'Player';
const resPort = parseInt(process.env.GTAMP_RES_PORT) || 22010;
const platformUrl = process.env.GTAMP_PLATFORM_URL || 'http://127.0.0.1:22003';

const CACHE_DIR = path.join(os.homedir(), '.gtamp', 'cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

// ---- State ----
const state = {
  netId: null,
  connected: false,
  me: { x: 0, y: 0, z: 72, h: 0, health: 200, inVeh: 0, model: 'mp_m_freemode_01' },
  players: new Map(),
  vehicles: new Map(),
  entities: new Map(),
  chat: [],
  resourcesLoaded: new Set(),
  resourcesPending: [],
  spawned: false,
  simAngle: 0,
  ping: -1,
  startTime: Date.now(),
  money: 5000,
  bank: 25000,
  inventory: {},
  weather: 'CLEAR',
  timeH: 12, timeM: 0,
  hook: null,
  hookQueue: [] // pending JSON lines to send once hook connects
};
function hookSend(obj) {
  const line = JSON.stringify(obj) + '\n';
  if (state.hook && state.hook.writable) {
    try { state.hook.write(line); } catch { state.hookQueue.push(line); }
  } else {
    state.hookQueue.push(line);
    // Cap queue to avoid runaway buffering
    if (state.hookQueue.length > 128) state.hookQueue.shift();
  }
}
function flushHookQueue() {
  if (!state.hook || !state.hook.writable) return;
  while (state.hookQueue.length) {
    const line = state.hookQueue.shift();
    try { state.hook.write(line); } catch(e) { state.hookQueue.unshift(line); break; }
  }
}


// ---- Phase 6: remote player ped lifecycle helpers ----
function remotePedId(netId) { return 'p' + netId; }

function isSelfNetId(netId) {
  return netId != null && state.netId != null && Number(netId) === Number(state.netId);
}

/** Push full spawn command for one remote player to the hook DLL. */
function hookSpawnRemote(p) {
  if (!p || p.netId == null || isSelfNetId(p.netId)) return;
  const pos = p.pos || { x: 0, y: 0, z: 72 };
  hookSend({
    t: 'netPed',
    id: remotePedId(p.netId),
    netId: p.netId,
    name: p.name || ('Player' + p.netId),
    model: p.model || 'mp_m_freemode_01',
    x: +pos.x || 0, y: +pos.y || 0, z: +pos.z || 72,
    h: p.h || 0,
    health: p.health ?? 200,
    armour: p.armour ?? 0,
    vx: p.vx || 0, vy: p.vy || 0, vz: p.vz || 0
  });
}

/** Push position-only update for one remote player. */
function hookMoveRemote(p) {
  if (!p || p.netId == null || isSelfNetId(p.netId)) return;
  const pos = p.pos || { x: 0, y: 0, z: 72 };
  hookSend({
    t: 'netPedPos',
    id: remotePedId(p.netId),
    netId: p.netId,
    name: p.name || ('Player' + p.netId),
    model: p.model || 'mp_m_freemode_01',
    x: +pos.x || 0, y: +pos.y || 0, z: +pos.z || 72,
    h: p.h || 0,
    health: p.health ?? 200,
    armour: p.armour ?? 0,
    vx: p.vx || 0, vy: p.vy || 0, vz: p.vz || 0
  });
}

function hookDeleteRemote(netId) {
  if (netId == null || isSelfNetId(netId)) return;
  hookSend({ t: 'netPedDel', id: remotePedId(netId) });
}

/** After netPedClear (or hook reconnect), re-create every known remote ped. */
function resyncAllRemotePeds(reason) {
  const list = [...state.players.values()].filter(p => !isSelfNetId(p.netId));
  console.log(`[Client] Phase6 resync ${list.length} remote peds (${reason || 'manual'})`);
  for (const p of list) hookSpawnRemote(p);
}


// ---- Solo TestBot (bridge-local) — works even if server freeroam bot fails ----
let localBotTimer = null;
function startLocalTestBot() {
  if (localBotTimer) return;
  const id = 'p9001';
  const name = 'TestBot';
  const model = 'mp_m_freemode_01';
  let ang = 0;
  // Seed roster so resync keeps it
  const seed = {
    netId: 9001, name, model,
    pos: { x: state.me.x + 4, y: state.me.y, z: state.me.z },
    h: 0, health: 200
  };
  state.players.set(9001, seed);
  hookSpawnRemote(seed);
  console.log('[Client] Local TestBot started near player for solo Phase 6 test');
  localBotTimer = setInterval(() => {
    ang += 0.05;
    const baseX = state.me.x || 0, baseY = state.me.y || 0, baseZ = state.me.z || 72;
    const x = baseX + Math.cos(ang) * 5;
    const y = baseY + Math.sin(ang) * 5;
    let h = ang * 180 / Math.PI + 90;
    h = ((h % 360) + 360) % 360;
    const p = state.players.get(9001) || seed;
    p.pos = { x, y, z: baseZ }; p.h = h; p.model = model; p.name = name;
    state.players.set(9001, p);
    hookMoveRemote(p);
  }, 66);
}


// ---- Resources (stages 6+7+8) ----
const resourceVMs = new Map();

function resourceCacheDir(name) {
  const d = path.join(CACHE_DIR, name);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP '+res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function hashBuf(b) { return crypto.createHash('sha1').update(b).digest('hex'); }

async function ensureResource(name, resInfo) {
  // Download files listed in resInfo.files into local cache if not present
  const base = resourceCacheDir(name);
  const files = resInfo.files || [];
  let downloaded = 0;
  for (const f of files) {
    const local = path.join(base, f.path);
    try { fs.mkdirSync(path.dirname(local), { recursive: true }); } catch {}
    let need = true;
    try {
      if (fs.existsSync(local) && fs.statSync(local).size === f.size) need = false;
    } catch {}
    if (need) {
      const url = resInfo.baseUrl + f.path;
      try {
        const data = await httpGet(url);
        fs.writeFileSync(local, data);
        downloaded++;
      } catch (e) {
        console.error(`[Client] failed to download ${name}/${f.path}: ${e.message}`);
      }
    }
  }
  console.log(`[Client] resource ${name}: ${downloaded} new, ${files.length - downloaded} cached`);
  return base;
}

function loadClientScripts(name, scripts) {
  // Each resource has its own isolated JS VM
  const ctx = {
    console, setTimeout, setInterval, clearTimeout, clearInterval,
    on: (ev, fn) => clientEvents.on(name, ev, fn),
    onNet: (ev, fn) => clientEvents.on(name, ev, fn),
    emit: (ev, ...a) => clientEvents.emit(ev, ...a),
    emitNet: (ev, ...a) => sendUDP({ t: 'event', name: ev, args: a }),
    SendNUIMessage: (data) => {
      broadcastWS({ t: 'nui', resource: name, data });
    },
    RegisterKeyMapping: () => {},
    print: (...a) => console.log(`[${name}]`, ...a),
    RegisterCommand: (cmd, fn) => {
      cmdHandlers[cmd.toLowerCase()] = fn;
    },
    GetPlayers: () => [...state.players.keys()],
    GetPlayerName: (id) => { const p = state.players.get(id); return p ? p.name : 'unknown'; },
    GetEntityCoords: () => state.me,
    PlayerPedId: () => state.netId,
    GetPlayerPed: (id) => id === state.netId ? state.netId : (state.players.get(id)?.pedId || 0),
    DrawMarker: () => {},
    SetEntityCoords: (x,y,z) => { state.me.x = x; state.me.y = y; state.me.z = z; },
    RequestModel: () => {},
    CreateVehicle: (model,x,y,z,h) => {
      const id = Math.floor(Math.random()*0xFFFF) + 1000;
      state.vehicles.set(id, { id, model, pos:{x,y,z}, rot:h||0, state: new Map() });
      sendUDP({ t: 'vehCreate', model, x, y, z, h: h||0, tempId: id });
      return id;
    },
    CreatePed: (pedType, model, x, y, z, h, isNet=false, bScriptHost=true) => {
      const id = Math.floor(Math.random()*0xFFFF) + 20000;
      state.entities.set(id, { id, type:'ped', model, pos:{x,y,z,h}, pedType });
      hookSend({ t:'spawnPed', src:'RES', model, x, y, z, h, pedType, offset:false });
      broadcastWS({ t:'pedCreate', id, model, x, y, z, h });
      return id;
    },
    TaskHandsUp: () => {},
    exports: {},
    Citizen: { await: (p)=>p, Wait: (ms)=>new Promise(r=>setTimeout(r,ms)) }
  };
  ctx.global = ctx;
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  for (const s of scripts) {
    try {
      vm.runInContext(s.source, sandbox, { filename: `${name}:${s.name}` });
    } catch (e) {
      console.error(`[Client/${name}] ${s.name}: ${e.message}`);
    }
  }
  resourceVMs.set(name, sandbox);
}

// ---- Event system ----
class ClientEventBus {
  constructor() { this.handlers = new Map(); }
  on(res, name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push({ res, fn });
  }
  emit(name, ...args) {
    const handlers = this.handlers.get(name);
    if (!handlers) return;
    for (const h of handlers) {
      try { h.fn(...args); } catch (e) { console.error('[Client/event]', name, e.message); }
    }
  }
}
const clientEvents = new ClientEventBus();
const cmdHandlers = {};

// ---- UDP socket to game server (stage 5) ----
const udp = dgram.createSocket('udp4');
function sendUDP(obj) {
  const buf = Buffer.from(JSON.stringify(obj) + '\n');
  try { udp.send(buf, port, host); } catch {}
}

// Track reliable seq numbers we've processed (dedupe retransmissions)
const seenSeqs = new Set();
udp.on('message', (buf) => {
  let pktData = buf;
  let seq = -1;
  if (buf.length >= 6 && buf[0] === 0x02) {
    seq = buf.readUInt32BE(2);
    pktData = buf.slice(6);
    if (seenSeqs.has(seq)) return; // duplicate retransmission — already acked
    seenSeqs.add(seq);
    if (seenSeqs.size > 256) { // don't leak memory
      const it = seenSeqs.values(); seenSeqs.delete(it.next().value);
    }
    try { sendUDP({ t: 'ack', seq }); } catch {}
  }
  let pkt;
  try { pkt = JSON.parse(pktData.toString('utf8').trim()); } catch { return; }
  if (!pkt || !pkt.t) return;
  handleServerPacket(pkt);
});

udp.on('listening', () => {
  console.log(`[Client] connecting to ${host}:${port} as "${nick}"`);
  // STAGE 5: connect
  sendUDP({ t: 'join', nick });
  state.connected = true;
  // If server never answers, still allow solo hook features
  setTimeout(() => {
    if (!state.netId) {
      console.log('[Client] no welcome from server yet — solo mode (local TestBot on hook ready)');
      state.netId = 1;
      state.spawned = true;
    }
  }, 3000);

  // Keep-alive
  setInterval(() => sendUDP({ t: 'ping', ts: Date.now() }), 2000);

  // STAGE 11+Phase5: continuous sync (pos updates every 100ms = 10Hz - sufficient over TCP hook + UDP relay)
  setInterval(() => {
    if (state.spawned) {
      sendUDP({
        t: 'pos',
        x: state.me.x, y: state.me.y, z: state.me.z, h: state.me.h,
        vx: 0, vy: 0, vz: 0,
        health: state.me.health,
        inVeh: state.me.inVeh,
        model: state.me.model || 'mp_m_freemode_01'
      });
    }
  }, 100);

  // STAGE 12: local simulation when no real hook attached (so rest of pipeline is exercised)
  // Only run sim when hook is NOT connected (no real game data).
  let a = 0;
  setInterval(() => {
    if (state.spawned && !state.hook) {
      a += 0.015;
      state.me.x = Math.cos(a) * 25;
      state.me.y = Math.sin(a) * 25;
      state.me.h = a + Math.PI/2;
    }
  }, 50);
});

udp.on('error', (e) => { console.error('[Client] UDP error:', e.message); });

udp.bind();

// ---- Packet handlers (stages 6-12) ----
async function handleServerPacket(pkt) {
  switch (pkt.t) {
    case 'welcome': {
      // STAGE 6: Resource discovery
      state.netId = pkt.netId;
      state.me.model = pkt.model || 'mp_m_freemode_01';
      state.me.pos = pkt.spawn; state.me.x = pkt.spawn.x; state.me.y = pkt.spawn.y; state.me.z = pkt.spawn.z;
      state.money = pkt.money || 5000; state.bank = pkt.bank || 25000;
      state.inventory = pkt.inventory || {};
      console.log(`[Client] WELCOME netId=${state.netId} server=${pkt.server?.name}`);
      broadcastWS({ t: 'welcome', netId: state.netId, server: pkt.server, money: state.money });

      // Download & load all client resources
      const resList = pkt.resourceFiles || {};
      const scripts = pkt.resources || {};
      state.resourcesPending = Object.keys({ ...resList, ...scripts });

      for (const [name, info] of Object.entries(resList)) {
        try {
          await ensureResource(name, info);
        } catch (e) { console.error(`[Client] resource ${name} failed: ${e.message}`); }
      }
      // Load client scripts
      for (const [name, list] of Object.entries(scripts)) {
        loadClientScripts(name, list);
      }
      // Fire onClientResourceStart for all
      for (const name of state.resourcesPending) {
        state.resourcesLoaded.add(name);
        clientEvents.emit('onClientResourceStart', name);
      }
      state.resourcesPending = [];
      console.log(`[Client] all resources loaded (${state.resourcesLoaded.size})`);

      // STAGE 7/8: NUI pages - inform UI layer
      broadcastWS({ t: 'nui-pages', pages: Object.fromEntries(
        Object.entries(resList).filter(([,v])=>v.ui_page).map(([k,v])=>[k, v.baseUrl + v.ui_page])
      )});

      // Signal ready
      sendUDP({ t: 'resourceAck' });
      clientEvents.emit('playerConnecting', nick, ()=>{});
      break;
    }
    case 'spawn': {
      // STAGE 10 / Phase 6: local spawn — wipe stale remote peds then rebuild from roster
      state.me.x = pkt.pos.x; state.me.y = pkt.pos.y; state.me.z = pkt.pos.z;
      state.me.model = pkt.model || state.me.model || 'mp_m_freemode_01';
      state.weather = pkt.weather || 'CLEAR';
      if (pkt.time) { state.timeH = pkt.time.h; state.timeM = pkt.time.m; }
      state.spawned = true;
      console.log('[Client] SPAWN at', pkt.pos, 'model='+state.me.model);
      // Clear in-game remote peds (hook), keep state.players roster, then re-spawn each
      hookSend({ t:'netPedClear' });
      resyncAllRemotePeds('local-spawn');
      broadcastWS({ t: 'spawn', pos: pkt.pos, model: state.me.model, weather: state.weather });
      clientEvents.emit('playerSpawned');
      sendUDP({ t: 'spawnComplete', model: state.me.model });
      break;
    }
    case 'snapshot': {
      // STAGE 11/12 + Phase 6: interest snapshot keeps roster + remote peds warm
      for (const e of (pkt.entities || [])) {
        if (e.type === 'player') {
          if (isSelfNetId(e.netId)) continue;
          const prev = state.players.get(e.netId);
          const pos = e.pos || (prev && prev.pos) || { x: 0, y: 0, z: 72 };
          const merged = {
            netId: e.netId,
            name: e.name || (prev && prev.name) || ('Player' + e.netId),
            pos,
            h: e.h || (prev && prev.h) || 0,
            health: e.health ?? (prev && prev.health) ?? 200,
            model: e.model || (prev && prev.model) || 'mp_m_freemode_01',
            vehicle: e.vehicle || 0
          };
          state.players.set(e.netId, merged);
          if (!prev) hookSpawnRemote(merged);
          else hookMoveRemote(merged);
        } else if (e.type === 'vehicle') {
          state.vehicles.set(e.id, { ...state.vehicles.get(e.id), ...e });
        }
      }
      if (pkt.self) {
        state.money = pkt.self.money ?? state.money;
        state.bank = pkt.self.bank ?? state.bank;
        state.me.health = pkt.self.health ?? state.me.health;
      }
      break;
    }
    case 'playerJoin': {
      // Phase 6 lifecycle: join → track → auto-create remote ped (never self)
      if (isSelfNetId(pkt.netId)) {
        console.log(`[Client] Phase6 ignore self playerJoin #${pkt.netId}`);
        break;
      }
      const prev = state.players.get(pkt.netId);
      const p = {
        netId: pkt.netId,
        name: pkt.name || (prev && prev.name) || ('Player' + pkt.netId),
        pos: pkt.pos || (prev && prev.pos) || { x: 0, y: 0, z: 72 },
        h: pkt.h || (prev && prev.h) || 0,
        health: pkt.health ?? (prev && prev.health) ?? 200,
        model: pkt.model || (prev && prev.model) || 'mp_m_freemode_01',
        vehicle: pkt.vehicle || 0
      };
      state.players.set(pkt.netId, p);
      hookSpawnRemote(p);
      clientEvents.emit('playerJoining', pkt.netId);
      broadcastWS({ t: 'playerJoin', ...pkt });
      console.log(`[Client] Phase6 JOIN +${p.name} (#${p.netId}) model=${p.model} @ ${p.pos.x|0},${p.pos.y|0},${p.pos.z|0}`);
      break;
    }
    case 'playerLeft': {
      // Phase 6 lifecycle: leave → despawn remote ped
      const left = state.players.get(pkt.netId);
      const leftName = (pkt.name || (left && left.name) || ('#' + pkt.netId));
      state.players.delete(pkt.netId);
      hookDeleteRemote(pkt.netId);
      broadcastWS({ t: 'playerLeft', netId: pkt.netId, name: leftName });
      clientEvents.emit('playerDropped', pkt.netId, 'left');
      console.log(`[Client] Phase6 LEAVE -${leftName} (#${pkt.netId})`);
      break;
    }
    case 'playerPos': {
      // Phase 6: position stream (~15Hz). Unknown id → auto-create ped (late join / missed packet)
      if (isSelfNetId(pkt.netId)) break;
      let p = state.players.get(pkt.netId);
      if (!p) {
        p = {
          netId: pkt.netId,
          name: pkt.name || ('Player' + pkt.netId),
          pos: { x: pkt.x, y: pkt.y, z: pkt.z },
          h: pkt.h || 0,
          health: pkt.health ?? 200,
          model: pkt.model || 'mp_m_freemode_01',
          vehicle: 0
        };
        state.players.set(pkt.netId, p);
        console.log(`[Client] Phase6 auto-create from pos #${pkt.netId} ${p.name}`);
        hookSpawnRemote(p);
      } else {
        const modelChanged = pkt.model && pkt.model !== p.model;
        p.pos = { x: pkt.x, y: pkt.y, z: pkt.z };
        p.h = pkt.h || 0;
        if (pkt.model) p.model = pkt.model;
        if (pkt.name) p.name = pkt.name;
        if (pkt.health != null) p.health = pkt.health;
        if (modelChanged) hookSpawnRemote(p); // respawn with new model
        else hookMoveRemote(p);
      }
      break;
    }
    case 'playerQuit': { // alias of playerLeft
      state.players.delete(pkt.netId);
      hookDeleteRemote(pkt.netId);
      break;
    }
    case 'chat':
      state.chat.push({ from: pkt.name, msg: pkt.msg, ts: Date.now() });
      if (state.chat.length > 200) state.chat.shift();
      broadcastWS({ t: 'chat', name: pkt.name, msg: pkt.msg, netId: pkt.netId });
      clientEvents.emit('chatMessage', pkt.name || 'SERVER', pkt.msg);
      // Phase 7: push chat into the hook so F8 HUD / nametag client can render it
      hookSend({ t: 'chat', name: pkt.name || 'SERVER', msg: pkt.msg || '', netId: pkt.netId || 0 });
      console.log(`[CHAT] ${pkt.name}: ${pkt.msg}`);
      break;
    case 'createVehicle':
      if (pkt.entity) state.vehicles.set(pkt.entity.id, pkt.entity);
      broadcastWS(pkt);
      break;
    case 'event':
      // Server -> client event (emitNet on server -> onNet in client resource VMs)
      clientEvents.emit(pkt.name, ...(pkt.args||[]));
      break;
    case 'spawnPed':
      // Server-initiated direct spawn (bypasses resource VM for simple events)
      console.log('[Client] server spawnPed:', pkt.model||'s_m_y_cop_01');
      hookSend({ t:'spawnPed', src:'SRV', model:pkt.model||'s_m_y_cop_01',
                 x:pkt.x, y:pkt.y, z:pkt.z, h:pkt.h,
                 offset: pkt.offset !== false, pedType: pkt.pedType||6 });
      break;
    case 'pong':
      state.ping = Date.now() - (pkt.ts||Date.now());
      break;
    case 'kick':
      console.log('[Client] kicked:', pkt.reason);
      broadcastWS({ t: 'kicked', reason: pkt.reason });
      break;
  }
}

// ---- TCP hook server (port 22100 - DLL connects here) ----
const tcpServer = net.createServer((socket) => {
  console.log('[Client] hook connected');
  state.hook = socket;
  // Flush anything queued while hook was offline (e.g. server welcome spawns)
  flushHookQueue();
  // Phase 6: hook may have been re-injected mid-session — recreate remote peds
  resyncAllRemotePeds('hook-connect');
  // If SHV already ready (reconnect), ensure TestBot
  try { if (state.me && (state.me.x || state.me.y)) startLocalTestBot(); } catch {}
  socket.setEncoding('utf8');
  let buf = '';
  socket.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.t === 'pos') {
        state.me.x = m.x; state.me.y = m.y; state.me.z = m.z; state.me.h = m.h||0;
        if (m.ped) state.me.pedId = m.ped;
      } else if (m.t === 'netPedSpawned') {
        console.log('[Client] remote ped', m.id, '-> GTA ped', m.ped);
      } else if (m.t === 'chat') {
        const raw = (m.msg || '').toString().trim();
        const asCmd = raw.startsWith('/') ? raw.slice(1) : raw;
        const parts = asCmd.split(/\s+/).filter(Boolean);
        const cmd = (parts[0] || '').toLowerCase();
        // Known local commands work with or without leading /
        if (cmd && cmdHandlers[cmd]) {
          try { cmdHandlers[cmd](0, parts.slice(1)); } catch (e) { console.error('[Client] cmd', cmd, e.message); }
          console.log('[Client] ran local cmd:', cmd);
        } else if (raw.startsWith('/')) {
          sendUDP({ t: 'chat', msg: raw }); // server commands
        } else {
          sendUDP({ t: 'chat', msg: raw });
        }
      } else if (m.t === 'cmd') {
        const cmd = (m.cmd||'').toLowerCase();
        if (cmdHandlers[cmd]) { try { cmdHandlers[cmd](0, m.args||[]); } catch {} }
        else sendUDP({ t: 'cmd', cmd: m.cmd, args: m.args||[] });
      } else if (m.t === 'hookHello') {
        broadcastWS({ t:'hookHello', v:m.v, gta:m.gta }); broadcastCtrl(m);
      } else if (m.t === 'ready') {
        // Phase 6: SHV fiber is live — ensure remote peds exist in-world
        resyncAllRemotePeds('hook-ready');
        // Solo playtest: always show a remote ped near the player
        try { startLocalTestBot(); } catch (e) { console.error('[Client] local TestBot failed', e.message); }
        broadcastWS({ t:'hookReady', ...m }); broadcastCtrl(m);
      } else if (m.t === 'spawn') {
        if (m.ped && m.ok) state.entities.set(m.ped, { id:m.ped, type:'ped', model:m.model, pos:{x:m.x,y:m.y,z:m.z,h:m.h||0} });
        broadcastWS({ t:'spawnAck', ...m }); broadcastCtrl(m);
        if (state.chat.length < 200) state.chat.push({ from:'HOOK', msg:m.m||`spawned ped ${m.ped}`, ts:Date.now() });
      } else if (m.t) {
        broadcastCtrl(m);
      }
      broadcastWS({ t:'hook', pkt:m });
    }
  });
  socket.on('close', () => {
    console.log('[Client] hook disconnected');
    state.hook = null;
    broadcastWS({ t:'hookDisconnected' });
    broadcastCtrl({t:'hookDisconnected'});
  });
  socket.on('error', () => { state.hook = null; });
});
tcpServer.on('error', (e) => console.error('[Client] TCP error:', e.message));
tcpServer.listen(22100, '127.0.0.1', () => {
  console.log('[Client] hook TCP listener on 127.0.0.1:22100');
});

// ---- Commands ----
cmdHandlers.spawncop = () => hookSend({ t:'spawnPed', src:'CMD', model:'s_m_y_cop_01', offset:true, pedType:6 });
cmdHandlers.spawn = (_src, args) => {
  const model = (args&&args[0]) ? String(args[0]) : 's_m_y_cop_01';
  hookSend({ t:'spawnPed', src:'CMD', model, offset:true, pedType:4 });
};
cmdHandlers.spawnat = (_src, args) => {
  const model = args[0]||'s_m_y_cop_01';
  const x=parseFloat(args[1]), y=parseFloat(args[2]), z=parseFloat(args[3]);
  const h=parseFloat(args[4]||'0');
  if(isNaN(x)||isNaN(y)||isNaN(z)) { console.log('[Client] usage: /spawnat <model> <x> <y> <z> [h]'); return; }
  hookSend({ t:'spawnPed', src:'CMD', model, x, y, z, h, offset:false, pedType:4 });
};

// ---- Control TCP (port 22102 - launcher main/renderer sends commands here) ----
const controlClients = new Set();
function broadcastCtrl(obj) {
  const s = JSON.stringify(obj) + '\n';
  for (const c of controlClients) { if (c.writable) try { c.write(s); } catch {} }
}
const ctrlServer = net.createServer((socket) => {
  controlClients.add(socket);
  socket.setEncoding('utf8');
  let buf = '';
  socket.write(JSON.stringify({t:'ctrlHello', hookConnected: !!state.hook})+'\n');
  socket.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.t === 'spawn') hookSend({ t:'spawnPed', src:'BTN', model:m.model||'s_m_y_cop_01', offset:true, pedType:m.pedType||6 });
      else if (m.t === 'spawnPed') hookSend({ ...m, src: m.src || 'BTN' });
      else if (m.t === 'cmd') {
        const line = (m.line||m.cmd||'').toString();
        if (line.startsWith('/')) {
          const parts = line.slice(1).split(' ');
          const cmd = parts[0].toLowerCase();
          if (cmdHandlers[cmd]) { try { cmdHandlers[cmd](0, parts.slice(1)); } catch {} }
        } else sendUDP({ t:'chat', msg: line });
      }
    }
  });
  socket.on('close', () => controlClients.delete(socket));
  socket.on('error', () => controlClients.delete(socket));
});
ctrlServer.on('error', (e) => console.error('[Client] ctrl TCP error:', e.message));
ctrlServer.listen(22102, '127.0.0.1', () => {
  console.log('[Client] control TCP on 127.0.0.1:22102');
});

// ---- WebSocket overlay server (STAGE 8: NUI / CEF) ----
const wss = new WebSocket.Server({ port: 22101, host: '127.0.0.1' }, () => {
  console.log('[Client] NUI WS on 127.0.0.1:22101');
});
function broadcastWS(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) { if (c.readyState === WebSocket.OPEN) c.send(s); }
}
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    t: 'init', state: {
      netId: state.netId, pos: state.me, players: [...state.players.values()],
      vehicles: [...state.vehicles.values()], chat: state.chat,
      money: state.money, bank: state.bank, ping: state.ping
    }
  }));
  ws.on('message', (m) => {
    try {
      const pkt = JSON.parse(m.toString());
      if (pkt.t === 'chat') {
        const msg = (pkt.msg||'').toString();
        if (msg.startsWith('/')) {
          const parts = msg.slice(1).split(' ');
          const cmd = parts[0].toLowerCase();
          if (cmdHandlers[cmd]) { try { cmdHandlers[cmd](state.netId, parts.slice(1)); } catch(e){} }
          else sendUDP({ t: 'chat', msg });
        } else sendUDP({ t: 'chat', msg });
      } else if (pkt.t === 'cmd') {
        sendUDP({ t: 'cmd', cmd: pkt.cmd, args: pkt.args||[] });
      } else if (pkt.t === 'event') {
        sendUDP({ t: 'event', name: pkt.name, args: pkt.args||[] });
      }
    } catch {}
  });
});

// Periodic state broadcast to all WS clients (for debug/NUI/overlay)
setInterval(() => {
  broadcastWS({
    t: 'state',
    self: { pos: state.me, health: state.me.health, money: state.money, bank: state.bank, ping: state.ping },
    players: [...state.players.values()].map(p => ({ netId: p.netId, name: p.name, pos: p.pos, health: p.health, vehicle: p.vehicle })),
    vehicles: [...state.vehicles.values()].map(v => ({ id: v.id, model: v.model, pos: v.pos })),
    chatCount: state.chat.length
  });
}, 100);

console.log('[Client] bridge ready.');

process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (e) => console.error('[Client] uncaught:', e.message));
