// src/main/main.js - GTAMP Launcher main process
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const net = require('net');
const discordRpc = require('./discord-rpc');
function writeLaunchDiag(lines) {
  try {
    const text = lines.join('\n') + '\n';
    const tmp = path.join(os.tmpdir(), 'gtamp_status.txt');
    fs.appendFileSync(tmp, `[${new Date().toISOString()}]\n${text}\n---\n`);
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'gtamp_status.txt'), text + '\n'); } catch {}
  } catch (e) { console.error('[Main] diag write failed', e.message); }
}


const isDev = process.argv.includes('--dev');
let mainWindow = null;
let fxServerInfo = null;
let bridgeProc = null;
let gameProc = null;
let injectorProc = null;
let hostedServers = [];

// v1.7.0: loading UI (startup splash + server connect window) + tray
let loadingWin = null;
let tray = null;
let gtaWatchTimer = null;
let connectCtl = null;
let startupCtl = null;
let startupDone = false;

let hookClient = null;
let hookConnected = false;

// ============================================================
// Built-in multiplayer relay (port 22100) — FiveM-style glue
// Hook DLL <-> this process <-> FXServer UDP
// Solo TestBot if no other players after a few seconds.
// ============================================================
const dgram = require('dgram');

let hookTcpServer = null;
const hookSockets = new Set();
let soloBotTimer = null;
let lastHookPos = { x: 0, y: 0, z: 72, h: 0 };
let mpUdp = null;
let mpServer = { host: '127.0.0.1', port: 22005 };
let mpNetId = null;
let mpSpawned = false;
let mpNick = 'Player';
let mpRemote = new Map(); // netId -> {name,model,pos,h,health}
let mpGotOtherPlayer = false;

function hookBroadcast(obj) {
  const line = JSON.stringify(obj) + '\n';
  for (const s of hookSockets) {
    try { if (s.writable) s.write(line); } catch {}
  }
}

function mpSend(obj) {
  if (!mpUdp) return;
  try {
    const buf = Buffer.from(JSON.stringify(obj) + '\n');
    mpUdp.send(buf, mpServer.port, mpServer.host);
  } catch (e) {
    writeLaunchDiag(['mpSend error: ' + e.message]);
  }
}

function hookSpawnRemotePlayer(p) {
  if (!p || p.netId == null) return;
  if (mpNetId != null && Number(p.netId) === Number(mpNetId)) return;
  const pos = p.pos || { x: 0, y: 0, z: 72 };
  const model = p.model || 's_m_y_cop_01';
  hookBroadcast({
    t: 'netPed',
    id: 'p' + p.netId,
    netId: p.netId,
    name: p.name || ('Player' + p.netId),
    model,
    x: +pos.x || 0, y: +pos.y || 0, z: +pos.z || 72,
    h: p.h || 0,
    health: p.health ?? 200
  });
  writeLaunchDiag(['remote JOIN #' + p.netId + ' ' + (p.name || '') + ' model=' + model]);
}

function hookMoveRemotePlayer(p) {
  if (!p || p.netId == null) return;
  if (mpNetId != null && Number(p.netId) === Number(mpNetId)) return;
  const pos = p.pos || { x: 0, y: 0, z: 72 };
  hookBroadcast({
    t: 'netPedPos',
    id: 'p' + p.netId,
    netId: p.netId,
    name: p.name || ('Player' + p.netId),
    model: p.model || 's_m_y_cop_01',
    x: +pos.x || 0, y: +pos.y || 0, z: +pos.z || 72,
    h: p.h || 0,
    health: p.health ?? 200
  });
}

function hookDeleteRemotePlayer(netId) {
  if (netId == null) return;
  if (mpNetId != null && Number(netId) === Number(mpNetId)) return;
  hookBroadcast({ t: 'netPedDel', id: 'p' + netId });
  writeLaunchDiag(['remote LEAVE #' + netId]);
}

function stopSoloBot() {
  if (soloBotTimer) { clearInterval(soloBotTimer); soloBotTimer = null; }
}

function startSoloBot() {
  if (soloBotTimer) return;
  if (mpGotOtherPlayer) return; // real players present — no fake bot
  const okPos = (Math.abs(lastHookPos.x) > 1 || Math.abs(lastHookPos.y) > 1) && lastHookPos.z > 1;
  if (!okPos) return;
  writeLaunchDiag(['solo TestBot near ' + lastHookPos.x.toFixed(1) + ',' + lastHookPos.y.toFixed(1)]);
  let ang = 0;
  const pushSpawn = () => {
    hookBroadcast({
      t: 'netPed', id: 'p9001', name: 'TestBot', model: 's_m_y_cop_01',
      x: lastHookPos.x + 5, y: lastHookPos.y, z: lastHookPos.z,
      h: lastHookPos.h || 0, health: 200, netId: 9001
    });
  };
  pushSpawn();
  soloBotTimer = setInterval(() => {
    if (mpGotOtherPlayer) { stopSoloBot(); hookDeleteRemotePlayer(9001); return; }
    ang += 0.05;
    const x = lastHookPos.x + Math.cos(ang) * 5;
    const y = lastHookPos.y + Math.sin(ang) * 5;
    let h = ((ang * 180 / Math.PI + 90) % 360 + 360) % 360;
    hookBroadcast({
      t: 'netPedPos', id: 'p9001', name: 'TestBot', model: 's_m_y_cop_01',
      x, y, z: lastHookPos.z, h, health: 200, netId: 9001
    });
  }, 66);
}

function handleServerPacket(pkt) {
  if (!pkt || !pkt.t) return;
  switch (pkt.t) {
    case 'welcome': {
      mpNetId = pkt.netId;
      writeLaunchDiag(['MP WELCOME netId=' + mpNetId + ' server=' + (pkt.server && pkt.server.name)]);
      // Minimal client: ack resources immediately so server finalizes spawn
      mpSend({ t: 'resourceAck' });
      if (connectCtl) connectCtl.event('welcome');
      break;
    }
    case 'spawn': {
      mpSpawned = true;
      if (connectCtl) connectCtl.event('spawn');
      if (pkt.pos) {
        // Don't force local player coords — hook owns real pos. Just mark spawned.
      }
      mpSend({ t: 'spawnComplete', model: (pkt.model || 'mp_m_freemode_01') });
      writeLaunchDiag(['MP SPAWN ok — streaming positions to server']);
      try {
        discordRpc.setInGame(
          'GTAMP Server',
          (mpServer.host + ':' + mpServer.port),
          mpRemote.size + 1
        );
      } catch {}
      // Resync any remotes we already know
      for (const p of mpRemote.values()) hookSpawnRemotePlayer(p);
      // If alone, TestBot after short delay
      setTimeout(() => { if (!mpGotOtherPlayer) startSoloBot(); }, 4000);
      break;
    }
    case 'playerJoin': {
      if (mpNetId != null && Number(pkt.netId) === Number(mpNetId)) break;
      mpGotOtherPlayer = true;
      stopSoloBot();
      hookDeleteRemotePlayer(9001);
      const p = {
        netId: pkt.netId,
        name: pkt.name || ('Player' + pkt.netId),
        pos: pkt.pos || { x: 0, y: 0, z: 72 },
        h: pkt.h || 0,
        health: pkt.health ?? 200,
        model: pkt.model || 's_m_y_cop_01'
      };
      mpRemote.set(pkt.netId, p);
      hookSpawnRemotePlayer(p);
      hookBroadcast({ t: 'chat', name: 'JOIN', msg: p.name + ' joined' });
      try {
        discordRpc.setInGame('GTAMP Server', mpServer.host + ':' + mpServer.port, mpRemote.size + 1);
      } catch {}
      break;
    }
    case 'playerLeft':
    case 'playerQuit': {
      mpRemote.delete(pkt.netId);
      hookDeleteRemotePlayer(pkt.netId);
      hookBroadcast({ t: 'chat', name: 'LEAVE', msg: (pkt.name || ('#' + pkt.netId)) + ' left' });
      if (mpRemote.size === 0) {
        mpGotOtherPlayer = false;
        setTimeout(() => startSoloBot(), 2000);
      }
      break;
    }
    case 'playerPos': {
      if (mpNetId != null && Number(pkt.netId) === Number(mpNetId)) break;
      mpGotOtherPlayer = true;
      stopSoloBot();
      let p = mpRemote.get(pkt.netId);
      if (!p) {
        p = {
          netId: pkt.netId,
          name: pkt.name || ('Player' + pkt.netId),
          pos: { x: pkt.x, y: pkt.y, z: pkt.z },
          h: pkt.h || 0,
          health: pkt.health ?? 200,
          model: pkt.model || 's_m_y_cop_01'
        };
        mpRemote.set(pkt.netId, p);
        hookSpawnRemotePlayer(p);
      } else {
        p.pos = { x: pkt.x, y: pkt.y, z: pkt.z };
        p.h = pkt.h || 0;
        if (pkt.model) p.model = pkt.model;
        if (pkt.name) p.name = pkt.name;
        if (pkt.health != null) p.health = pkt.health;
        hookMoveRemotePlayer(p);
      }
      break;
    }
    case 'chat': {
      hookBroadcast({ t: 'chat', name: pkt.name || 'SERVER', msg: pkt.msg || '', netId: pkt.netId || 0 });
      break;
    }
    case 'spawnPed': {
      hookBroadcast({
        t: 'spawnPed', src: 'SRV', model: pkt.model || 's_m_y_cop_01',
        x: pkt.x, y: pkt.y, z: pkt.z, h: pkt.h,
        offset: pkt.offset !== false, pedType: pkt.pedType || 6
      });
      break;
    }
    case 'kick': {
      writeLaunchDiag(['MP KICKED: ' + (pkt.reason || '')]);
      hookBroadcast({ t: 'chat', name: 'SERVER', msg: 'Kicked: ' + (pkt.reason || '') });
      break;
    }
    case 'damage': {
      // v1.9.0 — a remote player hit US: forward into the game fiber (health/armour apply)
      hookBroadcast({ t: 'dmg', d: pkt.d || 0, from: pkt.fromName || ('Player #' + (pkt.from || pkt.netId || '?')) });
      break;
    }
    default:
      break;
  }
}

function ensureMpUdp(serverAddr) {
  // serverAddr like 127.0.0.1:22005
  let host = '127.0.0.1', port = 22005;
  if (serverAddr && String(serverAddr).includes(':')) {
    const [h, ps] = String(serverAddr).split(':');
    host = h || host;
    port = parseInt(ps, 10) || port;
  }
  mpServer = { host, port };
  mpNick = (config && config.nickname) || 'Player';

  if (mpUdp) {
    try { mpUdp.close(); } catch {}
    mpUdp = null;
  }
  mpNetId = null;
  mpSpawned = false;
  mpRemote.clear();
  mpGotOtherPlayer = false;
  stopSoloBot();

  mpUdp = dgram.createSocket('udp4');
  mpUdp.on('message', (buf) => {
    let data = buf;
    // strip reliable header if present (0x02 ...)
    if (buf.length >= 6 && buf[0] === 0x02) {
      data = buf.slice(6);
      try {
        const seq = buf.readUInt32BE(2);
        mpSend({ t: 'ack', seq });
      } catch {}
    }
    let pkt;
    try { pkt = JSON.parse(data.toString('utf8').trim()); } catch { return; }
    handleServerPacket(pkt);
  });
  mpUdp.on('error', (e) => writeLaunchDiag(['MP UDP error: ' + e.message]));
  mpUdp.bind(() => {
    writeLaunchDiag(['MP UDP bound, joining ' + host + ':' + port + ' as ' + mpNick]);
    mpSend({ t: 'join', nick: mpNick });
    // keepalive
    if (ensureMpUdp._ping) clearInterval(ensureMpUdp._ping);
    ensureMpUdp._ping = setInterval(() => mpSend({ t: 'ping', ts: Date.now() }), 2000);
    // report session to the website for the live server list
    try { startWebsiteReporter(); } catch (e) { writeLaunchDiag(['website reporter: ' + e.message]); }
  });
}

// ---------- Website live sync ----------
// Reports this session (server + player count) to the GTAMP website so the
// web server list / homepage badge match what the launcher shows.
function postJson(urlStr, obj, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const data = Buffer.from(JSON.stringify(obj));
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs
      }, (res) => { res.resume(); resolve(true); });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
      req.on('error', () => resolve(false));
      req.write(data);
      req.end();
    } catch { resolve(false); }
  });
}

let websiteReporter = null;
let launcherPingTimer = null;

function startWebsiteReporter() {
  const site = String((config && config.websiteUrl) || defaultConfig.websiteUrl || '').replace(/\/+$/, '');
  if (!site) return;
  stopWebsiteReporter();
  if (!config.clientId) {
    try { config.clientId = require('crypto').randomUUID(); saveConfig(config); } catch {}
  }
  const report = () => {
    postJson(site + '/api/servers/report', {
      addr: mpServer.host + ':' + mpServer.port,
      name: config.serverName || 'GTAMP Server',
      desc: '',
      mode: 'Freeroam',
      players: mpRemote.size + (mpSpawned ? 1 : 0),
      maxPlayers: 64,
      tags: ['freeroam']
    });
  };
  report();
  websiteReporter = setInterval(report, 10000);
  const ping = () => postJson(site + '/api/launcher/ping', { id: config.clientId });
  ping();
  launcherPingTimer = setInterval(ping, 30000);
  writeLaunchDiag(['website reporter started -> ' + site]);
}

function stopWebsiteReporter() {
  if (websiteReporter) { clearInterval(websiteReporter); websiteReporter = null; }
  if (launcherPingTimer) { clearInterval(launcherPingTimer); launcherPingTimer = null; }
}

function ensureHookTcpServer() {
  if (hookTcpServer) return;
  try {
    hookTcpServer = net.createServer((socket) => {
      writeLaunchDiag(['hook DLL connected to built-in TCP 22100']);
      hookSockets.add(socket);
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          let m; try { m = JSON.parse(l); } catch { continue; }
          if (m.t === 'hookHello') {
            writeLaunchDiag(['hookHello v=' + (m.v || '?') + ' gta=' + (m.gta || '?')]);
            if (connectCtl) connectCtl.event('hookHello', m.v || '?');
          } else if (m.t === 'ready') {
            writeLaunchDiag(['hook SHV ready ped=' + m.ped]);
            if (connectCtl) connectCtl.event('hookReady');
            // Resync all known remotes into the game now that natives work
            for (const p of mpRemote.values()) hookSpawnRemotePlayer(p);
            setTimeout(() => { if (!mpGotOtherPlayer) startSoloBot(); }, 2000);
          } else if (m.t === 'pos') {
            if (typeof m.x === 'number') {
              lastHookPos = { x: m.x, y: m.y, z: m.z, h: m.h || 0 };
            }
            // Stream to game server when spawned
            if (mpSpawned && typeof m.x === 'number') {
              mpSend({
                t: 'pos',
                x: m.x, y: m.y, z: m.z, h: m.h || 0,
                vx: 0, vy: 0, vz: 0,
                health: typeof m.health === 'number' ? m.health : 200,
                armour: typeof m.armour === 'number' ? m.armour : 0,
                model: 'mp_m_freemode_01'
              });
            }
            if (!mpGotOtherPlayer) startSoloBot();
          } else if (m.t === 'hit') {
            // v1.9.0 — local player damaged a remote clone: report to server (damage routing)
            const target = parseInt(String(m.id || '').replace(/^p/, ''), 10);
            const d = Math.max(0, Math.min(300, parseInt(m.d, 10) || 0));
            if (mpSpawned && target > 0 && d > 0) {
              mpSend({ t: 'hit', target, d });
              writeLaunchDiag(['hit -> server: target=' + target + ' d=' + d]);
            }
          } else if (m.t === 'consoleCmd') {
            // v1.8.0 — commands typed into the in-game F8 console
            if (m.cmd === 'connect' && m.arg) {
              writeLaunchDiag(['consoleCmd: connect ' + m.arg]);
              const r = startGameConnect(String(m.arg));
              if (!r.ok) hookBroadcast({ t: 'conLog', msg: 'connect failed: ' + (r.error || 'unknown') });
            } else if (m.cmd === 'disconnect') {
              disconnectSession('console command');
              hookBroadcast({ t: 'joinEnd', ok: 0 });
            }
          } else if (m.t === 'chat') {
            const raw = (m.msg || '').toString().trim();
            const body = raw.startsWith('/') ? raw.slice(1) : raw;
            const parts = body.split(/\s+/).filter(Boolean);
            const cmd = (parts[0] || '').toLowerCase();
            if (cmd === 'spawncop' || cmd === 'spawn') {
              hookBroadcast({ t: 'spawnPed', src: 'CMD', model: parts[1] || 's_m_y_cop_01', offset: true, pedType: 6 });
            } else {
              mpSend({ t: 'chat', msg: raw });
            }
          } else if (m.t === 'spawn') {
            writeLaunchDiag(['hook spawn ack ped=' + m.ped + ' ok=' + m.ok]);
          }
        }
      });
      socket.on('close', () => {
        hookSockets.delete(socket);
        writeLaunchDiag(['hook DLL disconnected from 22100']);
      });
      socket.on('error', () => hookSockets.delete(socket));
    });
    hookTcpServer.on('error', (e) => {
      writeLaunchDiag(['hook TCP server error: ' + e.message]);
      hookTcpServer = null;
    });
    hookTcpServer.listen(22100, '127.0.0.1', () => {
      writeLaunchDiag(['built-in MP relay listening 127.0.0.1:22100']);
      console.log('[Main] built-in MP relay on 127.0.0.1:22100');
    });
  } catch (e) {
    writeLaunchDiag(['ensureHookTcpServer failed: ' + e.message]);
  }
}

// hostedServers already declared above (line 13) — do NOT redeclare

// ============================================================
// CONFIG + APPDATA DIRECTORY STRUCTURE (FiveM-style)
// Creates: %LOCALAPPDATA%\GTAMP\GTAMP Application Data\
//   bin\         CEF/runtime DLLs (placeholder - Electron provides Chromium)
//   cache\       downloaded resources
//   crashes\     crash dumps
//   game-storage\   per-savegame storage
//   logs\        log files
//   nui-storage\     NUI localStorage / IndexedDB
//   nui-storage-fxdk\
//   server-cache\   server-resource cache
//   server-cache-fxdk\
//   server-cache-priv\  private server cache (e.g. OneSync)
//   config.json
// ============================================================
const appDataRoot = path.join(app.getPath('userData')); // Electron's appData product dir
const fivemStyleDataDir = path.join(app.getPath('appData'), 'GTAMP', 'GTAMP Application Data');
const DATA_DIRS = [
  'bin', 'cache', 'crashes', 'game-storage', 'logs',
  'nui-storage', 'nui-storage-fxdk', 'nui-storage-fxdk-guest',
  'server-cache', 'server-cache-fxdk', 'server-cache-priv'
];

function ensureDataDirs() {
  try {
    // Ensure primary appData root
    fs.mkdirSync(appDataRoot, { recursive: true });
    // FiveM-style layout in %APPDATA%\GTAMP\GTAMP Application Data\
    fs.mkdirSync(fivemStyleDataDir, { recursive: true });
    for (const d of DATA_DIRS) {
      fs.mkdirSync(path.join(fivemStyleDataDir, d), { recursive: true });
    }
    // Write a placeholder ceflauncher.exe in bin so tools expecting the layout don't break
    const binMarker = path.join(fivemStyleDataDir, 'bin', 'readme.txt');
    if (!fs.existsSync(binMarker)) {
      fs.writeFileSync(binMarker, 'GTAMP uses Chromium via Electron. Runtime DLLs live next to GTAMP Launcher.exe.\n');
    }
    console.log('[Main] Data directories ready at', fivemStyleDataDir);
  } catch (e) { console.error('[Main] Failed to create data dirs:', e.message); }
}

// Config file
const configPath = path.join(appDataRoot, 'config.json');
const defaultConfig = {
  gtaPath: '',
  nickname: 'Player',
  language: 'en',
  autoConnect: false,
  lastServer: null,
  graphicsPreset: 'high',
  windowed: false,
  fullscreenBorderless: true,
  discordRpc: true,
  discordAppId: '1532843546640384311', // Discord Developer Portal Application ID (GTAMP app)
  voiceEnabled: true,
  ptt: true,
  voiceVolume: 70,
  volume: 80,
  bookmarks: [],
  history: [],
  launcherType: 'auto',
  masterServerUrl: 'http://127.0.0.1:22003',
  websiteUrl: 'http://127.0.0.1:3000',
  serverName: 'GTAMP Server',
  clientId: '',
  nuiScale: 1.0,
  streamerMode: false,
  devTools: false,
  keybinds: {
    console: 'F8',
    chat: 'T',
    ptt: 'N',
    scoreboard: 'Z',
    voice: 'CapsLock'
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaultConfig, ...parsed, keybinds: { ...defaultConfig.keybinds, ...(parsed.keybinds||{}) } };
    }
  } catch (e) { console.error('Config load failed:', e); }
  return JSON.parse(JSON.stringify(defaultConfig));
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) { console.error('Config save failed:', e); return false; }
}
let config = loadConfig();

// ---------- GTA detection ----------
function detectLauncher(gtaPath) {
  try {
    if (fs.existsSync(path.join(gtaPath, 'steam_api64.dll')) ||
        fs.existsSync(path.join(gtaPath, 'steam_api64r.dll')) ||
        fs.existsSync(path.join(gtaPath, 'steam_appid.txt'))) return 'steam';
    if (fs.existsSync(path.join(gtaPath, 'EOSSDK-Win64-Shipping.dll'))) return 'epic';
  } catch {}
  return 'rockstar';
}

function findSteamExe() {
  const c = [];
  if (process.env['ProgramFiles(x86)']) c.push(path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steam.exe'));
  if (process.env.ProgramFiles) c.push(path.join(process.env.ProgramFiles, 'Steam', 'steam.exe'));
  if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Steam', 'steam.exe'));
  c.push('C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe');
  for (const pth of c) { try { if (fs.existsSync(pth)) return pth; } catch {} }
  return null;
}

function findRockstarLauncherExe() {
  const c = [];
  for (const ev of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LOCALAPPDATA']) {
    if (process.env[ev]) c.push(path.join(process.env[ev], 'Rockstar Games', 'Launcher', 'Launcher.exe'));
  }
  c.push('C:\\\\Program Files\\\\Rockstar Games\\\\Launcher\\\\Launcher.exe');
  c.push('C:\\\\Program Files (x86)\\\\Rockstar Games\\\\Launcher\\\\Launcher.exe');
  for (const pth of c) { try { if (fs.existsSync(pth)) return pth; } catch {} }
  return null;
}

function findEpicExe() {
  const c = [];
  if (process.env['ProgramFiles(x86)'])
    c.push(path.join(process.env['ProgramFiles(x86)'], 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe'));
  if (process.env.ProgramFiles)
    c.push(path.join(process.env.ProgramFiles, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'));
  for (const pth of c) { try { if (fs.existsSync(pth)) return pth; } catch {} }
  return null;
}

/** Windows: is process image running? */
function isProcessRunning(imageName) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /NH`, {
      windowsHide: true, encoding: 'utf8', timeout: 5000
    }) || '';
    return out.toLowerCase().includes(String(imageName).toLowerCase());
  } catch { return false; }
}

/**
 * FiveM / RAGE / alt:V style: ensure platform process is already running.
 * Rockstar DRM (ERR_NO_LAUNCHER) requires Launcher/Steam/Epic — never bare GTA5.exe alone.
 */
function ensurePlatformRunning(kind) {
  if (process.platform !== 'win32') return;
  try {
    if (kind === 'steam' || kind === 'steam-applaunch' || kind === 'steam-url') {
      if (!isProcessRunning('steam.exe')) {
        const steam = findSteamExe();
        if (steam) {
          spawn(steam, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          writeLaunchDiag(['started Steam (was not running) — FiveM-style platform bootstrap']);
        }
      }
    } else if (kind === 'rockstar' || kind === 'playgtav' || kind === 'gtavlauncher' || kind === 'rockstar-ui') {
      if (!isProcessRunning('Launcher.exe') && !isProcessRunning('RockstarService.exe')) {
        const rgl = findRockstarLauncherExe();
        if (rgl) {
          spawn(rgl, [], { detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(rgl) }).unref();
          writeLaunchDiag(['started Rockstar Launcher (was not running) — required to avoid ERR_NO_LAUNCHER']);
        }
      }
    } else if (kind === 'epic') {
      if (!isProcessRunning('EpicGamesLauncher.exe')) {
        const epic = findEpicExe();
        if (epic) {
          spawn(epic, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          writeLaunchDiag(['started Epic Launcher (was not running)']);
        }
      }
    }
  } catch (e) {
    writeLaunchDiag(['ensurePlatformRunning: ' + e.message]);
  }
}

/**
 * Start GTA the way multiplayer clients do:
 *  1) Platform launcher running
 *  2) Game started THROUGH platform (PlayGTAV / steam -applaunch / Epic)
 *  3) Inject into GTA5.exe when it appears (never require user to run bare GTA5.exe)
 */
function findLauncher(launcherType, gtaPath) {
  const playGTA = path.join(gtaPath, 'PlayGTAV.exe');
  const gtavLauncher = path.join(gtaPath, 'GTAVLauncher.exe');
  const w = config.windowed !== false;
  // Soft offline-from-R*Online flags. GTAMP multiplayer is our UDP.
  // No -disablenetwork (breaks Social Club on many installs).
  const gameArgs = ['-scOfflineOnly', '-nostraighttofreemode', '-borderless'];
  if (w) gameArgs.push('-windowed');

  let kind = launcherType;
  if (!kind || kind === 'auto') kind = detectLauncher(gtaPath);

  // Steam — same pattern as FiveM: steam.exe -applaunch 271590
  if (kind === 'steam') {
    const steam = findSteamExe();
    if (steam) {
      return {
        exe: steam,
        args: ['-applaunch', '271590', ...gameArgs],
        kind: 'steam-applaunch',
        cwd: path.dirname(steam),
        shell: false,
        injectWaitMs: 90000,
        ensurePlatform: 'steam',
        note: 'Starting via Steam (FiveM-style). Wait for GTA — GTAMP injects into GTA5.exe automatically.'
      };
    }
    return {
      exe: 'cmd.exe',
      args: ['/c', 'start', '', 'steam://rungameid/271590//' + gameArgs.join('/')],
      kind: 'steam-url',
      shell: false,
      injectWaitMs: 90000,
      ensurePlatform: 'steam',
      note: 'Starting via Steam URL. Wait for GTA to open.'
    };
  }

  // Epic
  if (kind === 'epic') {
    return {
      exe: 'cmd.exe',
      args: ['/c', 'start', '', 'com.epicgames.launcher://apps/9d2d0eb6f1c04d4b8b86e2ce4f4f584b%3A9d2d0eb6f1c04d4b8b86e2ce4f4f584b%3AHeather?action=launch&silent=true'],
      kind: 'epic',
      shell: false,
      injectWaitMs: 90000,
      ensurePlatform: 'epic',
      note: 'Starting via Epic. Wait for GTA5.exe — GTAMP injects automatically.'
    };
  }

  // Rockstar / retail — MUST use PlayGTAV (talks to RGL). Bare GTA5.exe = ERR_NO_LAUNCHER.
  if (fs.existsSync(playGTA)) {
    return {
      exe: playGTA,
      args: gameArgs,
      kind: 'playgtav',
      cwd: gtaPath,
      shell: false,
      injectWaitMs: 90000,
      ensurePlatform: 'rockstar',
      note: 'Starting via PlayGTAV.exe (same idea as other MP clients). Rockstar Launcher must stay installed/running.'
    };
  }
  if (fs.existsSync(gtavLauncher)) {
    return {
      exe: gtavLauncher,
      args: gameArgs,
      kind: 'gtavlauncher',
      cwd: gtaPath,
      shell: false,
      injectWaitMs: 90000,
      ensurePlatform: 'rockstar',
      note: 'Starting via GTAVLauncher.exe. Wait for GTA5.exe.'
    };
  }
  const rgl = findRockstarLauncherExe();
  if (rgl) {
    return {
      exe: rgl,
      args: [],
      kind: 'rockstar-ui',
      cwd: path.dirname(rgl),
      shell: false,
      injectWaitMs: 120000,
      ensurePlatform: 'rockstar',
      note: 'Rockstar Launcher opened. Click GTA V → Story Mode once. GTAMP waits for GTA5.exe then injects (like FiveM/RAGE).'
    };
  }
  return null;
}

async function detectGTAPath() {
  const prefixes = [];
  for (const ev of ['ProgramFiles','ProgramFiles(x86)','ProgramW6432'])
    if (process.env[ev]) prefixes.push(process.env[ev]);
  const drives = [];
  for (const l of 'CDEFGHIJKLMNOP') drives.push(l+':');
  const tries = [];
  for (const pre of [...prefixes, ...drives]) {
    tries.push(path.join(pre,'Rockstar Games','Grand Theft Auto V'));
    tries.push(path.join(pre,'Epic Games','GTAV'));
    tries.push(path.join(pre,'Steam','steamapps','common','Grand Theft Auto V'));
    tries.push(path.join(pre,'steamapps','common','Grand Theft Auto V'));
  }
  for (const p of tries) {
    try { if (fs.existsSync(path.join(p,'GTA5.exe')) || fs.existsSync(path.join(p,'PlayGTAV.exe'))) return p; } catch {}
  }
  if (process.platform === 'win32') {
    const { exec } = require('child_process');
    const keys = [
      'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V',
      'HKLM\\SOFTWARE\\Rockstar Games\\Grand Theft Auto V',
      'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGames\\GTAV'
    ];
    for (const key of keys) {
      try {
        const out = await new Promise(r => exec(`reg query "${key}" /v InstallFolder 2>nul`, (_,s)=>r(s||'')));
        const m = out.match(/REG_SZ\s+(.+)/);
        if (m) {
          const p = m[1].trim();
          if (fs.existsSync(path.join(p,'GTA5.exe'))||fs.existsSync(path.join(p,'PlayGTAV.exe'))) return p;
        }
      } catch {}
    }
  }
  return '';
}

// ---------- GTA V ownership verification (v1.7.0) ----------
// FiveM-style: GTAMP refuses to run without a genuine, fully-installed copy.
function verifyGtaOwnership(dir) {
  const checks = [];
  const add = (label, ok, note) => checks.push({ label, ok: !!ok, note: note || '' });
  if (!dir) {
    add('Grand Theft Auto V install folder', false, 'No folder configured');
    add('Game executable (GTA5.exe)', false, '');
    add('Game data archive (update\\update.rpf)', false, '');
    add('Store platform (Steam / Epic / Rockstar)', false, '');
    return { ok: false, checks, edition: '', platform: '' };
  }
  const gtaExe = path.join(dir, 'GTA5.exe');
  const enhExe = path.join(dir, 'GTA5_Enhanced.exe');
  const playExe = path.join(dir, 'PlayGTAV.exe');
  const hasGta = fs.existsSync(gtaExe) || fs.existsSync(playExe);
  const hasEnhanced = fs.existsSync(enhExe);
  const edition = hasEnhanced ? 'enhanced' : (hasGta ? 'legacy' : '');
  add('Grand Theft Auto V install folder', fs.existsSync(dir), dir);
  add('Game executable (GTA5.exe)', hasGta || hasEnhanced, hasEnhanced ? 'Enhanced edition' : (hasGta ? 'Legacy edition' : 'missing'));
  // Game data archive (multi-hundred-MB) — strong "real copy" signal
  let dataOk = false;
  try {
    const upd = path.join(dir, 'update', 'update.rpf');
    if (fs.existsSync(upd)) dataOk = fs.statSync(upd).size > 200 * 1024 * 1024;
  } catch {}
  add('Game data archive (update\\update.rpf)', dataOk, dataOk ? 'fully installed' : 'not found / too small');
  let platform = '';
  if (fs.existsSync(path.join(dir, 'steam_api64.dll')) || fs.existsSync(path.join(dir, 'steam_api64r.dll'))) platform = 'steam';
  else if (fs.existsSync(path.join(dir, 'EOSSDK-Win64-Shipping.dll'))) platform = 'epic';
  else if (fs.existsSync(playExe) || fs.existsSync(path.join(dir, 'GTAVLauncher.exe')) || fs.existsSync(path.join(dir, 'socialclub.dll'))) platform = 'rockstar';
  add('Store platform (Steam / Epic / Rockstar)', platform !== '', platform || 'unknown');
  return { ok: checks.every(c => c.ok), checks, edition, platform, dir };
}

// ---------- Loading window: startup splash + server connect (v1.7.0) ----------
const LAUNCHER_VER = '1.9.7';
function openLoading(mode, opts = {}) {
  closeLoading();
  loadingWin = new BrowserWindow({
    width: 420, height: 470, resizable: false, maximizable: false, minimizable: false,
    frame: false, show: false, backgroundColor: '#0a0b0a',
    alwaysOnTop: mode === 'connect',
    title: mode === 'connect' ? 'GTAMP — Connecting' : 'GTAMP',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  loadingWin.once('ready-to-show', () => { try { loadingWin.show(); loadingWin.focus(); } catch {} });
  loadingWin.on('closed', () => { loadingWin = null; });
  loadingWin.loadFile(path.join(__dirname, '..', 'renderer', 'loading.html'), {
    query: { mode, server: opts.server || '', v: LAUNCHER_VER }
  });
}
function closeLoading() {
  try { if (loadingWin && !loadingWin.isDestroyed()) loadingWin.destroy(); } catch {}
  loadingWin = null;
}
function sendLoading(ch, payload) {
  try { if (loadingWin && !loadingWin.isDestroyed()) loadingWin.webContents.send('loading:' + ch, payload); } catch {}
}
const loadingSteps = (steps) => sendLoading('steps', steps);
const loadingStatus = (status, sub, pct) => sendLoading('status', { status, sub: sub || '', pct: (typeof pct === 'number' ? pct : null) });

// ---------- Tray (GTAMP keeps running in the background like FiveM) ----------
function ensureTray() {
  if (tray) return tray;
  try {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    let img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('GTAMP');
    const showMain = () => {
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
      else if (startupDone) createWindow();
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show GTAMP', click: showMain },
      { type: 'separator' },
      { label: 'Quit GTAMP', click: () => app.quit() }
    ]));
    tray.on('click', showMain);
  } catch (e) { writeLaunchDiag(['tray: ' + e.message]); }
  return tray;
}

// ---------- GTA5.exe presence + exit watcher ----------
function gtaRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = require('child_process').execSync(
      'tasklist /FI "IMAGENAME eq GTA5.exe" /NH & tasklist /FI "IMAGENAME eq GTA5_Enhanced.exe" /NH',
      { windowsHide: true, encoding: 'utf8', timeout: 6000 }) || '';
    return /GTA5(.exe)?\s|GTA5_Enhanced\.exe/i.test(out);
  } catch { return false; }
}
function startGtaExitWatch() {
  stopGtaExitWatch();
  let misses = 0;
  gtaWatchTimer = setInterval(() => {
    if (gtaRunning()) misses = 0; else misses++;
    if (misses >= 3) { stopGtaExitWatch(); onGtaClosed(); }
  }, 3000);
}
function stopGtaExitWatch() { if (gtaWatchTimer) { clearInterval(gtaWatchTimer); gtaWatchTimer = null; } }
function onGtaClosed() {
  writeLaunchDiag(['GTA5 exited — restoring GTAMP launcher']);
  try { if (injectorProc && !injectorProc.killed) injectorProc.kill(); } catch {}
  try { discordRpc.setInLauncher(); } catch {}
  try { tray && tray.setToolTip('GTAMP'); } catch {}
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('game:closed', {}); }
}

// ---------- Startup sequence with splash (v1.7.0) ----------
async function runStartup() {
  openLoading('startup');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const steps = [
    'Preparing GTAMP data folders',
    'Checking launcher version',
    'Locating Grand Theft Auto V',
    'Verifying your GTA V copy',
    'Connecting to Rockstar Games services',
    'Starting multiplayer services',
    'Starting GTAMP'
  ].map(label => ({ label, state: 'pending' }));
  const draw = () => loadingSteps(steps);
  draw();
  const finish = async (i, sub) => { steps[i].state = 'done'; draw(); if (sub) loadingStatus('', sub); await sleep(150); };

  // 1 — folders + hook server
  steps[0].state = 'active'; draw();
  loadingStatus('STARTING GTAMP', 'Preparing data folders…');
  ensureDataDirs();
  try { ensureHookTcpServer(); } catch (e) { console.error(e); }
  await finish(0);

  // 2 — version + FiveM-style self-update (Bootstrap parity: patch BEFORE anything else runs)
  steps[1].state = 'active'; draw();
  loadingStatus('STARTING GTAMP', 'GTAMP Launcher v' + LAUNCHER_VER);
  await sleep(220);
  try {
    const upd = await checkForLauncherUpdate();
    if (upd && cmpVer(upd.version, LAUNCHER_VER) > 0) {
      steps[1].label = 'Updating GTAMP launcher (v' + LAUNCHER_VER + ' → v' + upd.version + ')'; draw();
      const done = await doSelfUpdate(upd, loadingStatus, sleep);
      if (done) return; // new exe was spawned; this process exits
      steps[1].label = 'Checking launcher version'; draw();
      await finish(1, 'update to v' + upd.version + ' could not be applied — continuing');
    } else {
      await finish(1, 'v' + LAUNCHER_VER + (upd ? ' (up to date)' : ''));
    }
  } catch (e) {
    writeLaunchDiag(['update check error: ' + (e && e.message)]);
    await finish(1, 'v' + LAUNCHER_VER);
  }

  // 3 — locate GTA V
  steps[2].state = 'active'; draw();
  loadingStatus('LOCATING GRAND THEFT AUTO V', 'Scanning install locations…');
  if (!config.gtaPath) {
    try { const d = await detectGTAPath(); if (d) { config.gtaPath = d; saveConfig(config); } } catch {}
  }
  await finish(2, config.gtaPath || 'not found automatically');

  // 4 — ownership verification
  steps[3].state = 'active'; draw();
  loadingStatus('VERIFYING GAME OWNERSHIP', 'Checking your GTA V files…');
  const verify = verifyGtaOwnership(config.gtaPath);
  await sleep(350);
  if (verify.ok) {
    await finish(3, (verify.edition === 'enhanced' ? 'GTAV Enhanced' : 'GTAV Legacy') + ' · ' + (verify.platform || 'PC'));
  } else if (process.platform === 'win32') {
    steps[3].state = 'failed'; draw();
    loadingStatus('VERIFICATION FAILED', 'GTAMP could not verify a genuine copy of GTA V.');
    const choice = await waitStartupChoice(verify);
    if (choice === 'quit') { app.quit(); return; }
    return runStartup(); // picked a folder / retry — start over
  } else {
    steps[3].label = 'Verifying your GTA V copy (skipped — dev platform)';
    await finish(3, 'unverified (non-Windows dev)');
  }

  // 5 — Rockstar services handshake
  steps[4].state = 'active'; draw();
  const platNote = verify.platform === 'steam' ? 'Steam' : verify.platform === 'epic' ? 'Epic Games Launcher' : 'Rockstar Games Launcher';
  loadingStatus('CONNECTING TO ROCKSTAR GAMES SERVICES', 'Activating via ' + platNote + '…');
  await sleep(500); await finish(4, platNote);

  // 6 — multiplayer services (FXServer)
  steps[5].state = 'active'; draw();
  loadingStatus('STARTING MULTIPLAYER SERVICES', 'Relay + master list…');
  try {
    const { FXServer } = require(path.join(__dirname, '..', 'fxserver', 'index.js'));
    const fx = new FXServer({ port: 22005, platformPort: 22003, name: 'GTAMP Official (Local)' });
    // v1.9.2 — NEVER let the splash hang here: 12s cap, then continue degraded.
    // (Hang seen on machines where a second instance / zombie process held the ports.)
    const fxPromise = fx.start();
    fxPromise.catch(() => {}); // late rejection must never become an unhandledRejection
    fxServerInfo = await Promise.race([
      fxPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('FXServer start timeout (12s)')), 12000))
    ]);
    console.log('[Main] FXServer up:', fxServerInfo);
    writeLaunchDiag(['FXServer up: ' + JSON.stringify(fxServerInfo).slice(0, 300)]);
  } catch (e) {
    console.error('[Main] FXServer failed:', e);
    writeLaunchDiag(['FXServer start degraded: ' + e.message]);
    fxServerInfo = { gamePort: 22005, platformPort: 22003, resourcePort: 22010, platformUrl: 'http://127.0.0.1:22003', error: e.message };
  }
  // Discord presence (non-blocking)
  try {
    const dr = discordRpc.start({
      enabled: config.discordRpc !== false,
      clientId: config.discordAppId || process.env.GTAMP_DISCORD_APP_ID || ''
    });
    if (dr.ok) discordRpc.setInLauncher();
  } catch (e) { console.error('[Main] discord rpc', e); }
  await finish(5);

  // 7 — open the launcher
  steps[6].state = 'active'; draw();
  loadingStatus('STARTING GTAMP', 'Opening launcher…');
  await sleep(350);
  steps[6].state = 'done'; draw();
  loadingStatus('READY', 'Welcome to GTAMP', 1);
  await sleep(450);
  closeLoading();
  createWindow();
  ensureTray();
  startupDone = true;
}

function waitStartupChoice(verify) {
  return new Promise(resolve => {
    startupCtl = { resolve };
    sendLoading('error', {
      title: 'No genuine GTA V found',
      detail: 'GTAMP requires a legitimate PC copy of Grand Theft Auto V. If it is installed, select its folder (the one containing GTA5.exe / PlayGTAV.exe).\n\n' +
        (verify.checks || []).map(c => (c.ok ? '✓ ' : '✗ ') + c.label).join('\n'),
      actions: [
        { id: 'pickFolder', label: 'Choose GTA V folder…' },
        { id: 'retry', label: 'Retry' },
        { id: 'quit', label: 'Quit' }
      ]
    });
  });
}

async function pickGtaFolderDialog() {
  const parent = loadingWin || mainWindow;
  const res = await dialog.showOpenDialog(parent, { properties: ['openDirectory'], title: 'Select Grand Theft Auto V folder' });
  return (!res.canceled && res.filePaths[0]) ? res.filePaths[0] : null;
}

// Actions from loading.html buttons (startup errors + connect cancel)
ipcMain.on('loading:action', (_e, act) => {
  const id = typeof act === 'string' ? act : (act && act.id);
  if (connectCtl && ['cancel', 'retry', 'retryInject', 'pickFolder', 'quit'].includes(id)) {
    (async () => {
      if (id === 'cancel') return connectCtl.cancel();
      if (id === 'quit') return app.quit();
      if (id === 'pickFolder') {
        const p = await pickGtaFolderDialog();
        if (p) { config.gtaPath = p; saveConfig(config); connectCtl.retry(); }
        return;
      }
      connectCtl.retry(); // 'retry' / 'retryInject' both restart the connect flow
    })();
    return;
  }
  if (startupCtl && startupCtl.resolve) {
    (async () => {
      if (id === 'pickFolder') {
        const p = await pickGtaFolderDialog();
        if (p) { config.gtaPath = p; saveConfig(config); }
        const r = startupCtl.resolve; startupCtl = null; r('retry');
      } else if (id === 'retry') {
        const r = startupCtl.resolve; startupCtl = null; r('retry');
      } else if (id === 'quit') {
        const r = startupCtl && startupCtl.resolve; startupCtl = null; r('quit');
      }
    })();
  }
});

// ---------- Connect flow: join server with FiveM-style loading (v1.7.0) ----------
// ---------- v1.9.0: FiveM-parity pre-launch environment ----------
// Modeled on citizenfx/fivem code/client/launcher (Main.cpp DoPreLaunchTasks,
// DisableNVSP.cpp, ExecutablePreload.cpp) — mirrored with our own code.
function fixGtaSettings(gtaDir) {
  // Rockstar support's #1 fix for ERR_GFX_D3D_INIT: bad DX level / corrupt settings.xml.
  // Force DirectX 11 (value 2). Never delete the file silently — patch in place.
  const out = { touched: false, detail: 'settings.xml not found' };
  try {
    const docs = path.join(process.env.USERPROFILE || require('os').homedir(), 'Documents');
    const cands = [
      path.join(docs, 'Rockstar Games', 'GTA V', 'settings.xml'),
      path.join(docs, 'Rockstar Games', 'Social Club', 'settings.xml')
    ];
    for (const f of cands) {
      try {
        if (!fs.existsSync(f)) continue;
        let x = fs.readFileSync(f, 'utf8');
        let changed = false;
        const m = x.match(/<DX_Version\s+value="(\d+)"\s*\/>/);
        if (m && m[1] !== '2') { x = x.replace(/<DX_Version\s+value="\d+"\s*\/>/, '<DX_Version value="2" />'); changed = true; }
        const h = x.match(/<HDR\s+value="true"\s*\/>/);
        if (h) { x = x.replace(/<HDR\s+value="true"\s*\/>/, '<HDR value="false" />'); changed = true; } // HDR mismatch also triggers D3D init fail on some systems
        if (changed) {
          try { fs.copyFileSync(f, f + '.gtamp.bak'); } catch {}
          fs.writeFileSync(f, x);
        }
        out.touched = true;
        out.detail = changed ? 'settings patched → DirectX 11' : 'settings OK (DX11)';
        return out;
      } catch (e) { out.detail = 'settings patch error: ' + e.message; }
    }
  } catch (e) { out.detail = 'settings check error: ' + e.message; }
  return out;
}

function killGameProcesses() {
  // v1.9.1 — DISABLED by default: force-killing GTA5.exe makes Rockstar's launcher show
  // "Grand Theft Auto V Legacy exited unexpectedly". Only used deliberately with GTAMP_FORCE_KILL=1
  // as a last-resort escape hatch for a fully wedged game.
  const names = ['GTA5.exe', 'GTA5_Enhanced.exe'];
  if (!process.env.GTAMP_FORCE_KILL) {
    writeLaunchDiag(['killGameProcesses: skipped (set GTAMP_FORCE_KILL=1 to enable)']);
    return;
  }
  for (const n of names) {
    try { require('child_process').execSync('taskkill /F /IM "' + n + '" /T', { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

function queryNvNode() {
  // citizenfx/fivem DisableNVSP.cpp verbatim flow: NvNode state → port+secret → local HTTP API.
  return new Promise((resolve) => {
    try {
      const f = path.join(process.env.LOCALAPPDATA || '', 'NVIDIA Corporation', 'NvNode', 'nodejs.json');
      if (!fs.existsSync(f)) return resolve(null);
      const st = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!st || typeof st.port !== 'number' || !st.secret) return resolve(null);
      const http = require('http');
      const req = http.request({
        host: '127.0.0.1', port: st.port, path: '/ShadowPlay/v.1.0/Launch', method: 'GET',
        headers: { 'X_LOCAL_SECURITY_COOKIE': st.secret }, timeout: 2000
      }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => {
          try { const j = JSON.parse(b); resolve({ port: st.port, secret: st.secret, enabled: !!j.launch }); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

function nvspSet(conn, enabled) {
  return new Promise((resolve) => {
    try {
      const http = require('http');
      const req = http.request({
        host: '127.0.0.1', port: conn.port, path: '/ShadowPlay/v.1.0/Launch', method: 'POST',
        headers: { 'X_LOCAL_SECURITY_COOKIE': conn.secret, 'Content-Type': 'application/json' }, timeout: 2000
      }, (res) => { res.resume(); resolve(res.statusCode <= 399); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end(JSON.stringify({ launch: enabled }));
    } catch { resolve(false); }
  });
}
let nvspDisabledByUs = null; // remembered cookie so we restore on quit (like FiveM's enable_nvsp cookie)

function checkComponentUpdates() {
  // FiveM's "Updating components" stage — pull the published launcher version from our website.
  return new Promise((resolve) => {
    try {
      const site = String(config.websiteUrl || defaultConfig.websiteUrl || '').replace(/\/+$/, '');
      if (!site || !/^https?:/.test(site)) return resolve(null);
      const u = new URL(site + '/api/launcher/version');
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const req = lib.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, timeout: 3500 }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => {
          try { const j = JSON.parse(b); resolve(j && j.version ? j : null); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ---------- v1.9.6: FiveM-style self-update (Bootstrap.cpp parity: update BEFORE the app does anything) ----------
// FiveM's bootstrapper phones home, downloads the delta/full update and restarts itself before
// the game ever loads. We do the same against GitHub Releases (canonical, always latest) with
// the community website as fallback. Old builds that lack this code only ever need ONE more
// manual download — from v1.9.6 on, the launcher patches itself.
const UPDATE_REPO = 'lsdojrp123-ai/GTAMPv1';
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x - y; }
  return 0;
}
function httpsJson(urlStr, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const req = require('https').get({
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        headers: { 'User-Agent': 'GTAMP-Launcher/' + LAUNCHER_VER, 'Accept': 'application/vnd.github+json' },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return httpsJson(res.headers.location, timeoutMs).then(resolve);
        }
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    } catch { resolve(null); }
  });
}
function downloadWithProgress(url, dest, onPct, hops = 0) {
  // streams an https: URL (following redirects, GitHub release CDN jumps included) to `dest`
  return new Promise((resolve) => {
    if (hops > 5) return resolve(false);
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const req = lib.get({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
        headers: { 'User-Agent': 'GTAMP-Launcher/' + LAUNCHER_VER }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return downloadWithProgress(res.headers.location, dest, onPct, hops + 1).then(resolve);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(false); }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let got = 0;
        const fs = require('fs');
        const w = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          if (onPct && total > 0) { try { onPct(got / total, got, total); } catch {} }
        });
        res.pipe(w);
        w.on('finish', () => { w.close(() => resolve(got > 0)); });
        w.on('error', () => resolve(false));
      });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}
async function checkForLauncherUpdate() {
  // 1) GitHub Releases — canonical source of truth, no dependence on the user's local website
  try {
    const j = await httpsJson('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', 5000);
    const tag = j && String(j.tag_name || '').replace(/^v/, '');
    const asset = j && (j.assets || []).find(a => /\.exe$/i.test(a.name || ''));
    if (tag && asset && asset.browser_download_url) {
      return { version: tag, exeUrl: asset.browser_download_url, source: 'github' };
    }
  } catch {}
  // 2) community website fallback
  try {
    const site = String(config.websiteUrl || defaultConfig.websiteUrl || '').replace(/\/+$/, '');
    if (/^https?:/.test(site)) {
      const j = await new Promise((resolve) => {
        try {
          const u = new URL(site + '/api/launcher/version');
          const lib = u.protocol === 'https:' ? require('https') : require('http');
          const req = lib.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, timeout: 3500 }, (res) => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
        } catch { resolve(null); }
      });
      if (j && j.version) return { version: j.version, exeUrl: site + (j.url || ('/download/GTAMP-Launcher-v' + j.version + '.exe')), source: 'website' };
    }
  } catch {}
  return null;
}
async function doSelfUpdate(upd, loadingStatus, sleep) {
  writeLaunchDiag(['self-update available: v' + upd.version + ' from ' + upd.source + ' (' + upd.exeUrl + ')']);
  if (process.platform !== 'win32' || !app.isPackaged) {
    writeLaunchDiag(['self-update: skipped (dev build / non-Windows)']);
    return false;
  }
  const path = require('path'), fs = require('fs');
  loadingStatus('UPDATING GTAMP', 'GTAMP v' + upd.version + ' is available — downloading (FiveM-style auto-update)…', 0);
  try {
    const dir = path.dirname(process.execPath);
    const dest = path.join(dir, 'GTAMP-Launcher-v' + upd.version + '.exe');
    const tmp = dest + '.download';
    let lastPct = -1;
    const ok = await downloadWithProgress(upd.exeUrl, tmp, (pct, got, total) => {
      const p = Math.round(pct * 100);
      if (p !== lastPct) {
        lastPct = p;
        loadingStatus('UPDATING GTAMP', 'Downloading v' + upd.version + ' — ' + p + '%  (' + (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB)', pct);
      }
    });
    if (!ok) { try { fs.unlinkSync(tmp); } catch {} writeLaunchDiag(['self-update: download failed']); return false; }
    const st = fs.statSync(tmp);
    const fd = fs.openSync(tmp, 'r'); const head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (st.size < 8 * 1048576 || head.toString('latin1') !== 'MZ') { // sanity: a launcher exe is tens of MB and starts MZ
      try { fs.unlinkSync(tmp); } catch {}
      writeLaunchDiag(['self-update: sanity check failed (size=' + st.size + ')']);
      return false;
    }
    try { fs.renameSync(tmp, dest); } catch (e) { writeLaunchDiag(['self-update: rename failed: ' + e.message]); return false; }
    loadingStatus('UPDATING GTAMP', 'Restarting into GTAMP v' + upd.version + '…', 1);
    writeLaunchDiag(['self-update: downloaded OK (' + st.size + ' bytes) → relaunching as ' + dest]);
    await sleep(1400);
    try {
      const c = require('child_process').spawn(dest, [], { detached: true, stdio: 'ignore', windowsHide: false });
      c.unref();
    } catch (e) { writeLaunchDiag(['self-update: relaunch failed: ' + e.message]); return false; }
    setTimeout(() => { try { app.exit(0); } catch {} }, 600);
    return true;
  } catch (e) {
    writeLaunchDiag(['self-update: exception: ' + e.message]);
    return false;
  }
}

async function runConnectFlow({ launch, serverAddr, effectiveAddr }) {
  const serverName = serverAddr || 'GTAMP Official #1';
  if (connectCtl) { const old = connectCtl; connectCtl = null; try { await old.cancel(true); } catch {} }
  const ctl = {
    cancelled: false,
    events: {},
    _waiters: new Map(),
    event(name) {
      ctl.events[name] = true;
      const w = ctl._waiters.get(name) || [];
      ctl._waiters.delete(name);
      w.forEach(fn => fn());
    },
    waitFor(name, timeoutMs) {
      if (ctl.events[name]) return Promise.resolve(true);
      return new Promise(res => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; res(false); } }, timeoutMs);
        const arr = ctl._waiters.get(name) || [];
        arr.push(() => { if (!done) { done = true; clearTimeout(to); res(true); } });
        ctl._waiters.set(name, arr);
      });
    },
    async retry() {
      try { await ctl.cancel(true); } catch {}
      runConnectFlow({ launch, serverAddr, effectiveAddr });
    },
    async cancel(silent) {
      ctl.cancelled = true;
      stopGtaExitWatch();
      try { if (injectorProc && !injectorProc.killed) injectorProc.kill(); } catch {}
      if (!silent) { try { discordRpc.setInLauncher(); } catch {} }
      try { hookBroadcast({ t: 'joinEnd', ok: 0 }); } catch {}
      closeLoading();
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    }
  };
  connectCtl = ctl;
  const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); });
  const stepDefs = [
    ['Initializing GTAMP runtime', 'INITIALIZING GTAMP RUNTIME'],
    ['Verifying GTA V ownership', 'VERIFYING GAME OWNERSHIP'],
    ['Checking game files', 'CHECKING GAME FILES'],
    ['Preparing game environment', 'PREPARING GAME ENVIRONMENT'],
    ['Updating components', 'UPDATING COMPONENTS'],
    ['Connecting to Rockstar Games services', 'CONNECTING TO ROCKSTAR GAMES SERVICES'],
    ['Launching Grand Theft Auto V', 'STARTING GRAND THEFT AUTO V'],
    ['Waiting for game window', 'WAITING FOR GAME WINDOW'],
    ['Preparing injection', 'PREPARING INJECTION'],
    ['Injecting GTAMP hook', 'INJECTING GTAMP HOOK'],
    ['Linking multiplayer hook', 'LINKING MULTIPLAYER HOOK'],
    ['Connecting to server', 'CONNECTING TO ' + serverName.toUpperCase()],
    ['Loading into session', 'LOADING INTO SESSION']
  ];
  const steps = stepDefs.map(d => ({ label: d[0], state: 'pending' }));
  const setStep = (i, state, sub) => {
    steps[i].state = state; loadingSteps(steps);
    if (sub !== undefined) loadingStatus(stepDefs[i][1], sub);
  };
  const fail = (i, title, detail, actions) => {
    setStep(i, 'failed');
    sendLoading('error', { title, detail, actions: actions || [{ id: 'retry', label: 'Retry' }, { id: 'cancel', label: 'Cancel' }] });
    try { hookBroadcast({ t: 'joinFail', msg: title }); } catch {}
  };

  // STEP 0 — runtime: hook TCP server + MP UDP endpoint first, so the hook has somewhere to land
  setStep(0, 'active', 'Binding local bridges…');
  try { ensureHookTcpServer(); } catch (e) { writeLaunchDiag(['ensureHookTcpServer: ' + e.message]); }
  try {
    ensureMpUdp(effectiveAddr);
    writeLaunchDiag(['MP join scheduled -> ' + effectiveAddr + ' nick=' + (config.nickname || 'Player')]);
    try { discordRpc.setConnecting(serverAddr || 'Local GTAMP', effectiveAddr); } catch {}
  } catch (e) { writeLaunchDiag(['ensureMpUdp failed: ' + e.message]); }

  openLoading('connect', { server: serverName });
  if (mainWindow) mainWindow.hide();
  ensureTray();
  loadingSteps(steps);
  loadingStatus('INITIALIZING GTAMP RUNTIME', '');
  await sleep(300);
  setStep(0, 'done', 'local bridges up');

  // STEP 1 — ownership
  setStep(1, 'active', 'Checking your game files…');
  const v = verifyGtaOwnership(config.gtaPath);
  await sleep(250);
  if (ctl.cancelled) return;
  if (!v.ok) {
    fail(1, 'Could not verify GTA V',
      'GTAMP needs a genuine, fully installed copy.\n\n' + v.checks.map(c => (c.ok ? '✓ ' : '✗ ') + c.label).join('\n'),
      [{ id: 'pickFolder', label: 'Choose folder…' }, { id: 'cancel', label: 'Cancel' }]);
    return;
  }
  setStep(1, 'done', (v.edition === 'enhanced' ? 'GTAV Enhanced' : 'GTAV Legacy') + ' · ' + (v.platform || 'PC'));

  // STEP 2 — game file integrity summary
  setStep(2, 'active', 'Validating game installation…');
  await sleep(320);
  setStep(2, 'done', (v.checks || []).filter(c => c.ok).length + ' checks passed');

  // STEP 3 — game environment (FiveM DoPreLaunchTasks parity)
  setStep(3, 'active', 'Forcing DirectX 11…');
  const fxSet = fixGtaSettings(config.gtaPath);
  writeLaunchDiag(['prep: ' + (fxSet.detail || '')]);
  // v1.9.1 — never taskkill GTA/Rockstar processes. A /F kill is an abnormal exit and Rockstar's
  // launcher watchdog reports it as "GTA V exited unexpectedly" (and can demand a Safe Mode reboot).
  // FiveM reuses a running game instead (their -switchcl flow) — STEP 6 below does exactly that.
  let nv = null;
  try { nv = await queryNvNode(); } catch {}
  if (nv && nv.enabled) {
    setStep(3, 'active', 'NVIDIA ShadowPlay is ON — pausing it for this session (known GTA V graphics-init conflict, per FiveM launcher)');
    const okOff = await nvspSet(nv, false);
    if (okOff) { nvspDisabledByUs = nv; writeLaunchDiag(['prep: ShadowPlay disabled for this session (restored on quit)']); }
  }
  await sleep(150);
  if (ctl.cancelled) return;
  setStep(3, 'done', (fxSet.detail || 'environment ready') + (nvspDisabledByUs ? ' · ShadowPlay paused' : ''));

  // STEP 4 — components (update check against our website)
  setStep(4, 'active', 'Checking for GTAMP updates…');
  const upd = await checkComponentUpdates();
  if (ctl.cancelled) return;
  if (upd && upd.version && upd.version !== LAUNCHER_VER) {
    setStep(4, 'done', 'UPDATE v' + upd.version + ' available — you are on v' + LAUNCHER_VER + '. Get it from the GTAMP website Downloads page (old builds do not inject correctly).');
    writeLaunchDiag(['components: update available v' + upd.version]);
  } else {
    setStep(4, 'done', 'v' + LAUNCHER_VER + ' up to date');
  }

  // STEP 5 — Rockstar Games services (platform must be up BEFORE the game, Rockstar entitlement flow)
  setStep(5, 'active', launch.note || '…');
  try {
    if (launch.ensurePlatform) {
      ensurePlatformRunning(launch.ensurePlatform);
      try { require('child_process').execSync('ping 127.0.0.1 -n 3 >nul', { windowsHide: true }); } catch {}
    }
  } catch {}
  if (ctl.cancelled) return;
  setStep(5, 'done');

  // STEP 6 — launch GTA (or reuse a running one, FiveM -switchcl style)
  setStep(6, 'active', launch.note || '');
  let reusedGame = false;
  if (gtaRunning()) {
    reusedGame = true;
    setStep(6, 'done', 'GTA V already running — switching into GTAMP session');
    writeLaunchDiag(['GTA already running: reusing instance (FiveM switchcl equivalent)']);
  } else {
  try {
    const useShell = !!launch.shell || launch.kind === 'steam-url' || launch.kind === 'epic';
    writeLaunchDiag(['launching kind=' + launch.kind, 'exe=' + launch.exe, 'args=' + JSON.stringify(launch.args || []), launch.note || '']);
    gameProc = spawn(launch.exe, launch.args || [], {
      cwd: launch.cwd || config.gtaPath, detached: true, stdio: 'ignore',
      shell: useShell, windowsHide: false
    });
    gameProc.unref();
    gameProc.on('error', e => writeLaunchDiag(['game launch error: ' + e.message]));
  } catch (e) {
    fail(6, 'Could not start GTA V', e.message);
    return;
  }
  await sleep(1200);
  if (ctl.cancelled) return;
  setStep(6, 'done');
  }

  // STEP 7 — wait for the game process, THEN a real window (= D3D init succeeded)
  setStep(7, 'active', 'The game can take a minute to appear…');
  const waitMs = (launch.injectWaitMs || 90000) + 60000;
  const t0 = Date.now();
  let found = false;
  while (Date.now() - t0 < waitMs) {
    if (ctl.cancelled) return;
    found = gtaRunning();
    if (found) break;
    const left = Math.ceil((waitMs - (Date.now() - t0)) / 1000);
    loadingStatus('WAITING FOR GAME WINDOW', 'Game process — up to ' + left + 's remaining');
    await sleep(2000);
  }
  if (ctl.cancelled) return;
  if (!found) {
    fail(7, 'GTA5.exe never appeared',
      'The game did not start. Retry, or start GTA V yourself and press Retry Inject.',
      [{ id: 'retryInject', label: 'Retry Inject' }, { id: 'cancel', label: 'Cancel' }]);
    return;
  }
  // STEP 7..9 — the INJECTOR natively waits window → settle → inject and streams stage lines
  // (v1.9.3: replaces the PowerShell-polling storm that spiked commit memory / WerFault 0xc000012d)
  setStep(7, 'active', 'Waiting for the game window (graphics init)…');
  let injectorOutcome = null;
  let stage8Armed = false;
  const onStage = (line) => {
    if (line.startsWith('stage:process-found')) {
      const m = line.match(/pid=(\d+)/);
      setStep(7, 'active', 'Game process found' + (m ? ' (pid ' + m[1] + ')' : '') + ' — waiting for the game window…');
    } else if (line.startsWith('stage:window-found')) {
      ctl.event('windowFound');
      setStep(7, 'done', 'game window up (D3D ready)');
      setStep(8, 'active', 'Letting the game render its first frames…');
      stage8Armed = true;
    } else if (line.startsWith('stage:window-timeout')) {
      // v1.9.5 — window never matched (odd title / store wrapper); NOT fatal, injector proceeds blind
      ctl.event('windowFound');
      setStep(7, 'done', 'window not detected — game is running, injecting anyway');
      setStep(8, 'active', 'Settling before injection…');
      stage8Armed = true;
    } else if (line.startsWith('stage:settling')) {
      if (!stage8Armed) { setStep(7, 'done'); setStep(8, 'active', 'Settling before injection…'); }
      loadingStatus('PREPARING INJECTION', 'The game is rendering normally — injecting in a few seconds…');
    } else if (line === 'stage:injected') {
      injectorOutcome = { ok: true };
      ctl.event('injected');
    } else if (line.startsWith('error:')) {
      injectorOutcome = { ok: false, code: line.slice(6) };
    }
  };
  writeLaunchDiag(['game process found — native injector takes over (window wait → settle → inject, blind-safe), alreadyRunning=' + reusedGame]);
  // v1.9.6 — window wait caps at 120s then the injector blind-injects (a game alive that long is past D3D init);
  // reused instances skip the gate entirely. GTAMP_WINDOW_MS overrides for stuttery machines.
  const windowCap = Math.max(30000, parseInt(process.env.GTAMP_WINDOW_MS || '120000', 10) || 120000);
  const injRes = runInjector({ waitWindow: true, alreadyRunning: reusedGame, settleMs: Math.max(1000, parseInt(process.env.GTAMP_SETTLE_MS || '6000', 10) || 6000), timeoutMs: windowCap }, onStage);
  if (!injRes.ok) { fail(9, 'Injection failed', injRes.error || 'unknown'); return; }

  // STEP 8 — wait until the injector reports injected / errored (its own timeout is 240s)
  {
    const t2 = Date.now();
    while (!injectorOutcome && !ctl.events['hookHello'] && Date.now() - t2 < Math.min(windowCap + 30000, 300000)) {
      if (ctl.cancelled) return;
      await sleep(400);
    }
    // v1.9.4 — if the HOOK reported in, the DLL is in no matter what stdout said
    if (!injectorOutcome && ctl.events['hookHello']) injectorOutcome = { ok: true, via: 'hookHello' };
  }
  if (ctl.cancelled) return;
  if (!injectorOutcome || !injectorOutcome.ok) {
    const code = injectorOutcome && injectorOutcome.code;
    if (code === 'process-exited') {
      fail(7, 'GTA V exited unexpectedly',
        'The game closed during startup (Rockstar reports this in its "exited unexpectedly" dialog).\n\n1) Click OK in the Rockstar dialog if one is open.\n2) Press Retry here — GTAMP re-launches the game.\nIf it repeats: Safe Mode once (Rockstar dialog button) restores vanilla graphics, then Retry. Update GPU drivers and close overlays (ShadowPlay/Discord/Afterburner) only if it keeps happening.',
        [{ id: 'retry', label: 'Retry' }, { id: 'cancel', label: 'Cancel' }]);
      return;
    }
    fail(8, 'Game window never appeared',
      'GTA V started but never finished graphics init (e.g. ERR_GFX_D3D_INIT).\n\nGTAMP forced DirectX 11 in settings.xml and paused ShadowPlay. On your earlier screenshot GTAMP also spotted an ENB/ReShade installation — those custom d3d11.dll overlays are a top cause of ERR_GFX_D3D_INIT. Remove/pause ENB (enbdev) or ReShade from the GTA folder, reboot once, then Retry. Also check GPU drivers and close Discord/Afterburner overlays.',
      [{ id: 'retry', label: 'Retry' }, { id: 'cancel', label: 'Cancel' }]);
    return;
  }
  if (!stage8Armed) setStep(7, 'done', 'game window up (D3D ready)');
  setStep(8, 'done');
  if (!injectorOutcome.ok) { fail(9, 'Injection failed', 'injector reported failure'); return; }

  // STEP 9 — inject confirmed by the injector itself
  setStep(9, 'done');
  // From here the game itself shows GTAMP's FiveM-style in-game connect panel
  try { hookBroadcast({ t: 'joinBegin', server: serverName }); } catch {}

  // STEP 10 — hook link
  setStep(10, 'active', 'Waiting for the hook to report in…');
  try { hookConnect(); } catch (e) {}
  const helloOk = await ctl.waitFor('hookHello', 90000);
  if (ctl.cancelled) return;
  if (!helloOk) {
    fail(10, 'Hook did not come online',
      'The DLL was injected but never connected back. Antivirus may be blocking it — or try Retry Inject.',
      [{ id: 'retryInject', label: 'Retry Inject' }, { id: 'cancel', label: 'Cancel' }]);
    return;
  }
  setStep(10, 'done', 'hook online · F8 console + T chat active');
  startGtaExitWatch();

  // STEP 11 — server handshake
  setStep(11, 'active', 'Handshaking with ' + effectiveAddr + '…');
  try { hookBroadcast({ t: 'joinStage', stage: 'Handshaking with server' }); } catch {}
  const welcomeOk = await ctl.waitFor('welcome', 15000);
  if (ctl.cancelled) return;
  setStep(11, 'done', welcomeOk ? 'connected' : 'server unreachable — continuing offline');

  // STEP 12 — spawn
  setStep(12, 'active', 'Streaming world state…');
  try { hookBroadcast({ t: 'joinStage', stage: 'Loading session — streaming world' }); } catch {}
  await ctl.waitFor('spawn', 15000);
  if (ctl.cancelled) return;
  setStep(12, 'done');

  loadingStatus('IN SESSION — HAVE FUN!', 'GTAMP keeps running in the background', 1);
  try { hookBroadcast({ t: 'joinEnd', ok: 1 }); } catch {}
  await sleep(1500);
  closeLoading();
  try { tray && tray.setToolTip('GTAMP — connected to ' + serverName); } catch {}
  connectCtl = null;
}

// ---------- Window ----------
function createWindow() {
  // v1.7.1: never create a duplicate main window — re-show the existing one
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.show(); mainWindow.focus(); } catch {}
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280, height: 780, minWidth: 1024, minHeight: 640,
    backgroundColor: '#0a0a0f', frame: false, title: 'GTAMP',
    icon: path.join(__dirname,'..','..','build','icon.png'),
    webPreferences: {
      preload: path.join(__dirname,'..','preload','preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  mainWindow.once('ready-to-show', () => { try { mainWindow.show(); mainWindow.focus(); } catch {} });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    try { writeLaunchDiag(['main window load FAILED ' + code + ' ' + desc]); } catch {}
  });
  mainWindow.loadFile(path.join(__dirname,'..','renderer','index.html'));
  if (isDev || config.devTools) mainWindow.webContents.openDevTools({mode:'detach'});
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', () => {
    if (fxServerInfo) mainWindow.webContents.send('server:info', fxServerInfo);
  });
}

// ---------- Lifecycle ----------
// v1.7.0: splash screen FIRST (FiveM-style), main window only after startup done.
// v1.9.2 — FiveM parity: ONE client process only. A duplicate instance can't bind the MP
// ports and would sit forever at "Starting multiplayer services" (the reported hang).
// v1.9.7 — stale-instance takeover: if the lock is HELD, a frozen older launcher owns it
// (user runs the new exe but the zombie old window answers — "file says 1.9.6, screen says
// 1.9.0"). FiveM's -switchcl handoff favors the NEW client; we now do the same: kill the
// stale GTAMP processes and retake the lock instead of app.exit(0).
function killStaleLauncherInstances() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try { require('child_process').execSync('taskkill /F /IM "GTAMP-Launcher-*.exe" /FI "PID ne ' + process.pid + '"', { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch {}
  try { require('child_process').execSync('taskkill /F /IM gtamp_injector.exe', { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch {}
  try { writeLaunchDiag(['stale instance takeover: killed old GTAMP launcher/injector processes']); } catch {}
}
let singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  killStaleLauncherInstances();
  try { require('child_process').execSync('ping 127.0.0.1 -n 2 >nul', { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {} // ~1s for the mutex to release
  singleInstanceLock = app.requestSingleInstanceLock();
  if (!singleInstanceLock) app.exit(0); // genuinely could not take over — bail as before
}
if (singleInstanceLock) {
  app.on('second-instance', () => {
    // second click while we're already running → the other process kills itself via the
    // takeover path above; here we just make sure OUR window comes forward.
    if (loadingWin && !loadingWin.isDestroyed()) { loadingWin.show(); loadingWin.focus(); }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
  });
}
app.whenReady().then(() => { runStartup(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && startupDone) createWindow(); });
// v1.7.1 hotfix: the loading/connect window is TRANSIENT. When it closes it briefly
// leaves ZERO windows (e.g. splash closes right before createWindow()). Quitting there
// killed the whole app before the launcher ever appeared — guard with startupDone.
app.on('window-all-closed', () => {
  if (!startupDone) return; // transient window swap in progress — do nothing
  if (BrowserWindow.getAllWindows().length === 0) { cleanup(); if (process.platform!=='darwin') app.quit(); }
});
app.on('before-quit', () => {
  cleanup();
  // v1.9.0 — restore NVIDIA ShadowPlay if we paused it (FiveM restores via its enable_nvsp cookie)
  if (nvspDisabledByUs) {
    const conn = nvspDisabledByUs;
    nvspSet(conn, true).then(ok => writeLaunchDiag(['ShadowPlay restored: ' + ok]));
  }
});
Menu.setApplicationMenu(null);

function cleanup() {
  try { stopGtaExitWatch(); } catch {}
  try { stopWebsiteReporter(); } catch {}
  try { if (bridgeProc && !bridgeProc.killed) bridgeProc.kill(); } catch {}
  try { discordRpc.stop(); } catch {}
}

// ---------- IPC ----------
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e,p) => {
  config = {...config, ...p};
  saveConfig(config);
  // Refresh Discord RPC if toggled / app id changed
  try {
    if (p && ('discordRpc' in p || 'discordAppId' in p)) {
      discordRpc.stop();
      if (config.discordRpc !== false) {
        discordRpc.start({ enabled: true, clientId: config.discordAppId || process.env.GTAMP_DISCORD_APP_ID || '' });
        discordRpc.setInLauncher();
      }
    }
  } catch {}
  return config;
});
ipcMain.handle('config:reset', () => {
  try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch {}
  config = loadConfig();
  return config;
});

ipcMain.handle('dialog:selectFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow,{properties:['openDirectory'],title:'Select Grand Theft Auto V folder'});
  return (!res.canceled && res.filePaths[0]) ? res.filePaths[0] : null;
});
ipcMain.handle('dialog:message', (_e, opts) => dialog.showMessageBox(mainWindow, opts||{}));

ipcMain.handle('gta:detect', detectGTAPath);
ipcMain.handle('gta:validate', (_e,p) => {
  if (!p) return false;
  return fs.existsSync(path.join(p,'GTA5.exe')) || fs.existsSync(path.join(p,'PlayGTAV.exe'));
});
ipcMain.handle('gta:launcherType', (_e,p) => detectLauncher(p));

ipcMain.handle('datadir:get', () => ({ appDataRoot, fivemStyleDataDir, dirs: DATA_DIRS }));
ipcMain.handle('datadir:open', (_e, sub) => {
  const dir = sub ? path.join(fivemStyleDataDir, sub) : fivemStyleDataDir;
  if (fs.existsSync(dir)) shell.openPath(dir);
  return dir;
});
ipcMain.handle('cache:clear', () => {
  let n = 0;
  for (const d of ['cache','server-cache','server-cache-priv','nui-storage','nui-storage-fxdk','nui-storage-fxdk-guest','crashes']) {
    const full = path.join(fivemStyleDataDir, d);
    try {
      if (fs.existsSync(full)) {
        fs.rmSync(full, {recursive:true, force:true});
        fs.mkdirSync(full, {recursive:true});
        n++;
      }
    } catch {}
  }
  return { cleared: n };
});
ipcMain.handle('shell:open', (_e,url) => shell.openExternal(url));
ipcMain.handle('shell:openPath', (_e,p) => shell.openPath(p));
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.quit(); });

ipcMain.handle('server:info', () => fxServerInfo);

ipcMain.handle('server:ping', (_e,addr) => new Promise(resolve => {
  const [h,ps] = (addr||'').split(':');
  const port = parseInt(ps)||22005;
  if (!h) return resolve({ping:-1,online:false});
  const dgram = require('dgram');
  const s = dgram.createSocket('udp4');
  const start = Date.now();
  let done = false;
  const fin = (o) => { if (done) return; done=true; try{s.close();}catch{}; resolve(o); };
  s.on('message', () => fin({ping:Date.now()-start, online:true}));
  s.on('error', () => fin({ping:-1,online:false}));
  try { s.send(Buffer.from(JSON.stringify({t:'ping',ts:start})+'\n'), port, h, ()=>{}); } catch { fin({ping:-1,online:false}); }
  setTimeout(() => fin({ping:-1,online:false}), 1500);
}));

ipcMain.handle('master:getServers', async () => new Promise(resolve => {
  try {
    const url = (fxServerInfo?.platformUrl) || 'http://127.0.0.1:22003';
    const http = require('http');
    const req = http.get(url+'/servers', res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve([]);} });
    });
    req.setTimeout(3000, () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
  } catch { resolve([]); }
}));

// ---------- Launch GTA + inject ----------
// Shared connect entry — used by the UI button AND the in-game F8 console (`connect <ip:port>`)
function startGameConnect(serverAddr) {
  if (!config.gtaPath) return {ok:false, error:'GTA V path not set. Go to Settings.'};
  const hasGTA = fs.existsSync(path.join(config.gtaPath,'GTA5.exe')) || fs.existsSync(path.join(config.gtaPath,'PlayGTAV.exe'));
  if (!hasGTA) return {ok:false, error:'No GTA V installation found at '+config.gtaPath};

  const lt = config.launcherType === 'auto' ? detectLauncher(config.gtaPath) : config.launcherType;
  const launch = findLauncher(lt, config.gtaPath);
  if (!launch) return {ok:false, error:'Could not find Steam, Epic, PlayGTAV.exe, or Rockstar Launcher. GTA must be started through the platform it was bought from (ERR_NO_LAUNCHER = bare GTA5.exe blocked).'};

  const nativeDir = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(__dirname, '..', '..', 'dist-bin');
  // client-bridge must be a REAL file path (asar.unpacked). Inside asar, spawn fails silently.
  const clientBridgePath = (() => {
    const candidates = [
      // Packaged: extraResources copies bridge next to native/
      path.join(process.resourcesPath || '', 'client', 'client-bridge.js'),
      // asarUnpack fallback
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'src', 'client', 'client-bridge.js'),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'client', 'client-bridge.js'),
      // Dev
      path.join(__dirname, '..', 'client', 'client-bridge.js'),
    ];
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch {}
    }
    return candidates[0];
  })();

  const injectorPath = path.join(nativeDir, 'gtamp_injector.exe');
  const dllPath = path.join(nativeDir, 'gtamp_hook.dll');

  const host = '127.0.0.1';
  const gamePort = fxServerInfo?.gamePort || 22005;
  const effectiveAddr = serverAddr || `${host}:${gamePort}`;

  if (process.platform !== 'win32') {
    // Dev path: no Windows game — still bring up MP link + pretend-connect
    try { ensureHookTcpServer(); } catch (e) { writeLaunchDiag(['ensureHookTcpServer: ' + e.message]); }
    try { ensureMpUdp(effectiveAddr); } catch (e) { writeLaunchDiag(['ensureMpUdp failed: ' + e.message]); }
    config.lastServer = effectiveAddr; saveConfig(config);
    addToHistory({name:'(dev) '+effectiveAddr, addr:effectiveAddr, mode:'Direct', joinedAt:Date.now()});
    return {ok:true, launched:'dev mode', server:effectiveAddr, launcherType:lt};
  }

  // v1.7.0 — FiveM-style connect flow with a real loading window.
  // Returns immediately; progress/failure is shown in the connect window.
  addToHistory({
    name: serverAddr ? 'Direct: '+serverAddr : 'GTAMP Official #1',
    addr: effectiveAddr,
    mode: serverAddr ? 'Direct' : 'Freeroam',
    joinedAt: Date.now()
  });
  config.lastServer = effectiveAddr;
  saveConfig(config);
  runConnectFlow({ launch, serverAddr, effectiveAddr });
  return { ok: true, launched: launch.kind, server: effectiveAddr, launcherType: lt, connecting: true };
}
ipcMain.handle('game:launch', (_e, {serverAddr} = {}) => startGameConnect(serverAddr));

// v1.8.0 — leave the current session (F8 console 'disconnect'/'quit', launcher Disconnect)
function disconnectSession(reason) {
  writeLaunchDiag(['disconnectSession: ' + (reason || '')]);
  try { if (mpSpawned) mpSend({ t: 'quit' }); } catch (e) { writeLaunchDiag(['quit send: ' + e.message]); }
  mpSpawned = false; mpGotOtherPlayer = false; mpNetId = null;
  try { mpRemote.clear(); } catch {}
  try { hookBroadcast({ t: 'netPedClear' }); } catch {}
  try { hookBroadcast({ t: 'conLog', msg: 'disconnected from server' + (reason ? ' (' + reason + ')' : '') }); } catch {}
  try { discordRpc.setInLauncher(); } catch {}
  try { tray && tray.setToolTip('GTAMP'); } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('game:closed', {}); }
}
ipcMain.handle('game:disconnect', (_e) => { disconnectSession('launcher'); return { ok: true }; });

function addToHistory(entry) {
  config.history = config.history || [];
  config.history = config.history.filter(h => h.addr !== entry.addr);
  config.history.unshift(entry);
  if (config.history.length > 20) config.history = config.history.slice(0, 20);
  saveConfig(config);
}

// ---------- Manual + robust auto-inject ----------
function nativeDirs() {
  const dirs = [];
  if (app.isPackaged && process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'native'));
  dirs.push(path.join(__dirname, '..', '..', 'dist-bin'));
  dirs.push(path.join(__dirname, '..', '..', '..', 'dist-bin'));
  return dirs;
}
function findNativeFile(file) {
  for (const d of nativeDirs()) {
    try { if (d && fs.existsSync(path.join(d, file))) return path.join(d, file); } catch {}
  }
  return null;
}
let injectAttempt = 0;
function runInjector(opts, onStage) {
  // v1.9.3 — the INJECTOR natively waits for process → window → settle → inject and streams
  // `stage:`/`error:` lines on stdout. No more PowerShell-per-2s polling (WerFault 0xc000012d).
  opts = opts || {};
  const dllPath = findNativeFile('gtamp_hook.dll');
  const injPath = findNativeFile('gtamp_injector.exe');
  if (!dllPath || !injPath) {
    const msg = 'Injector/DLL NOT FOUND (looked in: ' + nativeDirs().join(', ') + ')';
    console.log('[Main]', msg);
    writeLaunchDiag([msg]);
    return { ok:false, error: msg };
  }
  injectAttempt++;
  try {
    const args = ['--process','GTA5.exe','--dll',dllPath,'--timeout', String(opts.timeoutMs || 300000)];
    if (opts.waitWindow) {
      args.push('--wait-window');
      args.push('--settle-ms', String(opts.settleMs || 6000));
    }
    if (opts.alreadyRunning) args.push('--already-running'); // v1.9.5 — reused instance: skip window gate entirely
    // v1.9.5 — injector ALWAYS writes a native log (window candidates etc.) for post-mortems
    const injEnv = Object.assign({}, process.env, { GTAMP_LOG: require('path').join(require('os').tmpdir(), 'gtamp_injector.log') });
    injectorProc = spawn(injPath, args, { detached:false, stdio: ['ignore', onStage ? 'pipe' : 'ignore', 'pipe'], windowsHide:true, env: injEnv });
    if (onStage && injectorProc.stdout) {
      let buf = '';
      injectorProc.stdout.setEncoding('utf16le'); // stage() writes wide chars
      injectorProc.stdout.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const raw of lines) {
          const l = raw.replace(/^ /, '').replace(/[^\x20-\x7E]/g, '').trim();
          if (!l) continue;
          writeLaunchDiag(['injector: ' + l]);
          try { onStage(l); } catch {}
        }
      });
    } else {
      injectorProc.unref();
    }
    injectorProc.on('error', e => writeLaunchDiag(['injector process error: ' + e.message]));
    // v1.9.4 — never let stdout parsing be the only signal: injector EXITING is also an outcome.
    injectorProc.on('exit', (code) => {
      try { if (onStage) onStage(code === 0 ? 'stage:injected' : 'error:inject-failed exit=' + code); } catch {}
    });
    writeLaunchDiag(['spawning injector (attempt ' + injectAttempt + ', waitWindow=' + !!opts.waitWindow + ')', injPath, dllPath]);
    return { ok:true, injector: injPath, dll: dllPath, attempt: injectAttempt };
  } catch (e) {
    console.error('[Main] injector spawn error:', e);
    writeLaunchDiag(['injector spawn exception: ' + e.message]);
    return { ok:false, error: e.message };
  }
}
ipcMain.handle('game:inject', () => runInjector());

ipcMain.handle('history:add', (_e, entry) => { addToHistory(entry); return config.history; });
ipcMain.handle('bookmarks:add', (_e, srv) => {
  config.bookmarks = config.bookmarks || [];
  if (!config.bookmarks.find(b => b.addr === srv.addr)) {
    config.bookmarks.push(srv); saveConfig(config);
  }
  return config.bookmarks;
});
ipcMain.handle('bookmarks:remove', (_e, addr) => {
  config.bookmarks = (config.bookmarks||[]).filter(b => b.addr !== addr);
  saveConfig(config); return config.bookmarks;
});

// ============================================================
// HOST SERVER: spawn additional FXServer instances on demand
// ============================================================
ipcMain.handle('server:hostStart', async (_e, opts = {}) => {
  try {
    const { FXServer } = require(path.join(__dirname,'..','fxserver','index.js'));
    const fx = new FXServer({
      name: opts.name || 'My GTAMP Server',
      maxPlayers: opts.max || 32,
      gamemode: opts.mode || 'freeroam',
      port: opts.port || 0,
      lanOnly: !!opts.lan,
      isPublic: !!opts.public,
      description: opts.desc || ''
    });
    const info = await fx.start();
    hostedServers.push({ fx, info, name: opts.name, port: info.gamePort });
    return { ok: true, port: info.gamePort, platformPort: info.platformPort, resourcePort: info.resourcePort };
  } catch (e) {
    console.error('[Main] hostStart failed:', e);
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('server:hostStop', async () => {
  try {
    const last = hostedServers.pop();
    if (last && last.fx && typeof last.fx.stop === 'function') {
      await last.fx.stop();
    }
    return { ok: true };
  } catch (e) {
    console.error('[Main] hostStop failed:', e);
    return { ok: false, error: e.message };
  }
});

// ---- Hook control proxy (TCP client to bridge on 127.0.0.1:22102) ----
function hookConnect() {
  const tryConnect = () => {
    if (hookClient && !hookClient.destroyed) return;
    const c = net.createConnection({ host:'127.0.0.1', port:22102 }, () => {
      hookConnected = true;
      mainWindow?.webContents.send('hook:status', { connected:true });
    });
    let buf = '';
    c.on('data', d => {
      buf += d.toString('utf8');
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        try { mainWindow?.webContents.send('hook:event', JSON.parse(l)); } catch {}
      }
    });
    c.on('close', () => {
      hookConnected = false; hookClient = null;
      mainWindow?.webContents.send('hook:status', { connected:false });
      setTimeout(tryConnect, 1000);
    });
    c.on('error', () => {});
    hookClient = c;
  };
  setTimeout(tryConnect, 2000);
}
ipcMain.handle('hook:send', (_e, obj) => {
  if (!hookClient || !hookClient.writable) return {ok:false, error:'not connected'};
  try { hookClient.write(JSON.stringify(obj) + '\n'); return {ok:true}; }
  catch(e) { return {ok:false, error:e.message}; }
});
ipcMain.handle('hook:status', () => ({ connected: hookConnected }));
ipcMain.handle('discord:status', () => discordRpc.status());
ipcMain.handle('discord:set', (_e, partial) => { try { discordRpc.setPresence(partial || {}); return { ok:true }; } catch(e){ return { ok:false, error:e.message }; } });
