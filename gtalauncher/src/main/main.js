// src/main/main.js - GTAMP Launcher main process
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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
      break;
    }
    case 'spawn': {
      mpSpawned = true;
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
  });
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
          } else if (m.t === 'ready') {
            writeLaunchDiag(['hook SHV ready ped=' + m.ped]);
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
                health: 200,
                model: 'mp_m_freemode_01'
              });
            }
            if (!mpGotOtherPlayer) startSoloBot();
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
  discordAppId: '', // Discord Developer Portal Application ID
  voiceEnabled: true,
  ptt: true,
  voiceVolume: 70,
  volume: 80,
  bookmarks: [],
  history: [],
  launcherType: 'auto',
  masterServerUrl: 'http://127.0.0.1:22003',
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

// ---------- Window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 780, minWidth: 1024, minHeight: 640,
    backgroundColor: '#0a0a0f', frame: false, title: 'GTAMP',
    icon: path.join(__dirname,'..','..','build','icon.png'),
    webPreferences: {
      preload: path.join(__dirname,'..','preload','preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname,'..','renderer','index.html'));
  if (isDev || config.devTools) mainWindow.webContents.openDevTools({mode:'detach'});
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', () => {
    if (fxServerInfo) mainWindow.webContents.send('server:info', fxServerInfo);
  });
}

// ---------- Lifecycle ----------
app.whenReady().then(async () => {
  try { ensureHookTcpServer(); } catch (e) { console.error(e); }
  // Discord Rich Presence (Playing GTAMP)
  try {
    const dr = discordRpc.start({
      enabled: config.discordRpc !== false,
      clientId: config.discordAppId || process.env.GTAMP_DISCORD_APP_ID || ''
    });
    if (dr.ok) discordRpc.setInLauncher();
    else writeLaunchDiag(['Discord RPC: ' + (dr.error || 'off') + ' — set Discord App ID in Settings']);
  } catch (e) { console.error('[Main] discord rpc', e); }
  ensureDataDirs();
  if (!config.gtaPath) {
    try { const d = await detectGTAPath(); if (d) { config.gtaPath = d; saveConfig(config); } } catch {}
  }
  try {
    const { FXServer } = require(path.join(__dirname,'..','fxserver','index.js'));
    const fx = new FXServer({ port: 22005, platformPort: 22003, name: 'GTAMP Official (Local)' });
    fxServerInfo = await fx.start();
    console.log('[Main] FXServer up:', fxServerInfo);
  } catch (e) {
    console.error('[Main] FXServer failed:', e);
    fxServerInfo = { gamePort:22005, platformPort:22003, resourcePort:22010, platformUrl:'http://127.0.0.1:22003', error:e.message };
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length===0) createWindow(); });
});
app.on('window-all-closed', () => { cleanup(); if (process.platform!=='darwin') app.quit(); });
app.on('before-quit', cleanup);
Menu.setApplicationMenu(null);

function cleanup() {
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
ipcMain.handle('game:launch', (_e, {serverAddr} = {}) => {
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
  const resPort = fxServerInfo?.resourcePort || 22010;
  const platformUrl = fxServerInfo?.platformUrl || 'http://127.0.0.1:22003';
  const effectiveAddr = serverAddr || `${host}:${gamePort}`;

  // Built-in MP relay: hook TCP 22100 + UDP join to FX server
  try { ensureHookTcpServer(); } catch (e) { writeLaunchDiag(['ensureHookTcpServer: ' + e.message]); }
  try {
    ensureMpUdp(effectiveAddr);
    writeLaunchDiag(['MP join scheduled -> ' + effectiveAddr + ' nick=' + (config.nickname || 'Player')]);
    try {
      discordRpc.setConnecting(serverAddr || 'Local GTAMP', effectiveAddr);
    } catch {}
  } catch (e) {
    writeLaunchDiag(['ensureMpUdp failed: ' + e.message]);
  }


  if (process.platform !== 'win32') {
    config.lastServer = effectiveAddr; saveConfig(config);
    addToHistory({name:'(dev) '+effectiveAddr, addr:effectiveAddr, mode:'Direct', joinedAt:Date.now()});
    return {ok:true, launched:'dev mode', server:effectiveAddr, launcherType:lt};
  }

  try {
    // FiveM-style: platform process first, then game through platform
    if (launch.ensurePlatform) {
      ensurePlatformRunning(launch.ensurePlatform);
      // Give Steam/RGL a moment to come up before game start
      try { require('child_process').execSync('ping 127.0.0.1 -n 3 >nul', { windowsHide: true }); } catch {}
    }
    const useShell = !!launch.shell || launch.kind === 'steam-url' || launch.kind === 'epic';
    writeLaunchDiag([
      'launching kind=' + launch.kind,
      'exe=' + launch.exe,
      'args=' + JSON.stringify(launch.args || []),
      'injectWaitMs=' + (launch.injectWaitMs || 90000),
      launch.note || ''
    ]);
    gameProc = spawn(launch.exe, launch.args || [], {
      cwd: launch.cwd || config.gtaPath,
      detached: true,
      stdio: 'ignore',
      shell: useShell,
      windowsHide: false
    });
    gameProc.unref();
    gameProc.on('error', e => {
      console.error('[Main] game launch error:', e.message);
      writeLaunchDiag(['game launch error: ' + e.message]);
    });

    // Record in history
    addToHistory({
      name: serverAddr ? 'Direct: '+serverAddr : 'GTAMP Official #1',
      addr: effectiveAddr,
      mode: serverAddr ? 'Direct' : 'Freeroam',
      joinedAt: Date.now()
    });

    // Diagnostics so user can find why hook is missing (TEMP\gtamp_status.txt)
    writeLaunchDiag([
      'game:launch',
      'nativeDir=' + nativeDir,
      'injectorPath=' + injectorPath + ' exists=' + fs.existsSync(injectorPath),
      'dllPath=' + dllPath + ' exists=' + fs.existsSync(dllPath),
      'gtaPath=' + config.gtaPath,
      'server=' + effectiveAddr,
      'isPackaged=' + app.isPackaged,
      'resourcesPath=' + (process.resourcesPath || ''),
      'NOTE: hook log appears at %TEMP%\\gtamp_hook.log ONLY after DLL injects',
      'NOTE: injector log also at %TEMP%\\gtamp_injector.log'
    ]);

    // Inject after GTA process exists. 15s default (was 30s).
    const injectDelayMs = (launch && launch.injectWaitMs) || 90000;
    setTimeout(() => {
      try {
        if (fs.existsSync(injectorPath) && fs.existsSync(dllPath)) {
          writeLaunchDiag(['spawning injector now', injectorPath, dllPath]);
          injectorProc = spawn(injectorPath, ['--process','GTA5.exe','--dll',dllPath,'--timeout','180000'],
            { detached:true, stdio: isDev ? 'inherit' : 'ignore', windowsHide:true });
          injectorProc.unref();
          injectorProc.on('error', e => writeLaunchDiag(['injector process error: ' + e.message]));
        } else {
          const msg = 'Injector/DLL NOT FOUND at ' + nativeDir +
            ' — copy gtamp_hook.dll + gtamp_injector.exe into resources\\native\\';
          console.log('[Main]', msg);
          writeLaunchDiag([msg]);
        }
      } catch (e) {
        console.error('[Main] injector spawn error:', e);
        writeLaunchDiag(['injector spawn exception: ' + e.message]);
      }
    }, injectDelayMs);

    // Hook proxy for renderer (control channel)
    try { hookConnect(); } catch(e) { console.log('[Main] hookConnect err', e.message); }

    config.lastServer = effectiveAddr;
    saveConfig(config);
    return {
      ok: true,
      launched: launch.kind,
      server: effectiveAddr,
      launcherType: lt,
      injectScheduled: fs.existsSync(injectorPath) && fs.existsSync(dllPath),
      note: launch.note || null,
      injectWaitMs: launch.injectWaitMs || 90000
    };
  } catch (e) { return {ok:false, error:e.message}; }
});

function addToHistory(entry) {
  config.history = config.history || [];
  config.history = config.history.filter(h => h.addr !== entry.addr);
  config.history.unshift(entry);
  if (config.history.length > 20) config.history = config.history.slice(0, 20);
  saveConfig(config);
}

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
