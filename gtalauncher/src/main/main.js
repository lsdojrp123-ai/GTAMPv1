// src/main/main.js - GTAMP Launcher main process
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
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

function findLauncher(launcherType, gtaPath) {
  const playGTA = path.join(gtaPath, 'PlayGTAV.exe');
  // Boot GTA into offline borderless windowed story mode. This prevents:
  //   - boot into GTA Online (no -StraightIntoFreemode)
  //   - exclusive fullscreen from blocking our overlay (we need -windowed + no -fullscreen)
  const w = config.windowed !== false; // default true so overlay works
  const offArgs = ['-scOfflineOnly','-disablenetwork','-nostraighttofreemode','-borderless'];
  if (w) offArgs.push('-windowed');
  if (fs.existsSync(playGTA)) return { exe: playGTA, args: offArgs, kind: 'playgtav' };
  if (launcherType === 'steam')
    return { exe: 'cmd.exe', args:['/c','start','steam://rungameid/271590//-scOfflineOnly/-windowed'], kind:'steam' };
  if (launcherType === 'epic')
    return { exe: 'cmd.exe', args:['/c','start','com.epicgames.launcher://apps/9d2d0eb6f1c04d4b8b86e2ce4f4f584b%3A9d2d0eb6f1c04d4b8b86e2ce4f4f584b%3AHeather?action=launch&silent=true'], kind:'epic' };
  try {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const pre of [pf, pf86]) {
      const rgl = path.join(pre, 'Rockstar Games','Launcher','Launcher.exe');
      if (fs.existsSync(rgl)) return { exe: rgl, args:['-scOfflineOnly'], kind:'rockstar' };
    }
  } catch {}
  const gl = path.join(gtaPath, 'GTAVLauncher.exe');
  if (fs.existsSync(gl)) return { exe: gl, args:['-scOfflineOnly'], kind:'gtavlauncher' };
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
}

// ---------- IPC ----------
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e,p) => { config = {...config, ...p}; saveConfig(config); return config; });
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
  if (!launch) return {ok:false, error:'Could not find a launcher.'};

  const nativeDir = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(__dirname, '..', '..', 'dist-bin');
  const clientBridgePath = path.join(__dirname, '..', 'client', 'client-bridge.js');

  const injectorPath = path.join(nativeDir, 'gtamp_injector.exe');
  const dllPath = path.join(nativeDir, 'gtamp_hook.dll');

  const host = '127.0.0.1';
  const gamePort = fxServerInfo?.gamePort || 22005;
  const resPort = fxServerInfo?.resourcePort || 22010;
  const platformUrl = fxServerInfo?.platformUrl || 'http://127.0.0.1:22003';
  const effectiveAddr = serverAddr || `${host}:${gamePort}`;

  // Start client bridge
  try {
    if (bridgeProc && !bridgeProc.killed) bridgeProc.kill();
    bridgeProc = spawn(process.execPath, [clientBridgePath], {
      env: {
        ...process.env,
        GTAMP_SERVER: effectiveAddr,
        GTAMP_NICK: config.nickname || 'Player',
        GTAMP_RES_PORT: String(resPort),
        GTAMP_PLATFORM_URL: platformUrl,
        GTAMP_CACHE_DIR: path.join(fivemStyleDataDir, 'cache'),
        ELECTRON_RUN_AS_NODE: '1'
      },
      detached: true, stdio: isDev ? 'inherit' : 'ignore', windowsHide: true
    });
    bridgeProc.unref();
    bridgeProc.on('error', e => console.error('[Main] bridge error:', e.message));
  } catch (e) { console.error('[Main] bridge spawn error:', e); }

  if (process.platform !== 'win32') {
    config.lastServer = effectiveAddr; saveConfig(config);
    addToHistory({name:'(dev) '+effectiveAddr, addr:effectiveAddr, mode:'Direct', joinedAt:Date.now()});
    return {ok:true, launched:'dev mode', server:effectiveAddr, launcherType:lt};
  }

  try {
    const useShell = launch.kind === 'steam' || launch.kind === 'epic';
    gameProc = spawn(launch.exe, launch.args, {
      cwd: fs.existsSync(launch.exe) && !launch.exe.toLowerCase().endsWith('cmd.exe') ? path.dirname(launch.exe) : config.gtaPath,
      detached: true, stdio:'ignore', shell: useShell, windowsHide:false
    });
    gameProc.unref();
    gameProc.on('error', e => console.error('[Main] game launch error:', e.message));

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
    const injectDelayMs = 15000;
    setTimeout(() => {
      try {
        if (fs.existsSync(injectorPath) && fs.existsSync(dllPath)) {
          writeLaunchDiag(['spawning injector now', injectorPath, dllPath]);
          injectorProc = spawn(injectorPath, ['--process','GTA5.exe','--dll',dllPath,'--timeout','120000'],
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
    return { ok:true, launched: launch.kind, server:effectiveAddr, launcherType:lt,
             injectScheduled: fs.existsSync(injectorPath)&&fs.existsSync(dllPath) };
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
const net = require('net');
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
