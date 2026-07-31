// src/fxserver/runtimes/index.js
/**
 * Script runtimes - per-resource isolation.
 *
 * FiveM runs every resource in its own VM sandbox. We support:
 *  - Lua (using fengari-web, a pure-JS Lua implementation - so we don't need C)
 *  - JavaScript (Node vm sandbox per resource)
 * Each resource gets its own global `exports`, `on`, `onNet`, `emit`, `emitNet`,
 * `RegisterCommand`, etc.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const LUA_ENABLED = (() => {
  try { require.resolve('fengari'); return true; } catch { return false; }
})();

class ResourceContext {
  constructor(name, dir, events, em, pm, vmgr, db, sendToAll) {
    this.name = name;
    this.dir = dir;
    this.events = events;
    this.em = em;
    this.pm = pm;
    this.vmgr = vmgr;
    this.db = db;
    this.sendToAll = sendToAll;
    this.exports = {};
    this.scripts = [];
    this.running = false;
    this._jsVm = null;
    this._luaState = null;
  }

  _buildApi(client = false) {
    const ctx = this;
    return {
      source: -1, // set per invocation
      GetPlayerName: (src) => {
        const p = ctx.pm.get(src); return p ? p.name : 'unknown';
      },
      GetPlayers: () => ctx.pm.getAll().map(p => p.netId),
      GetEntityCoords: (e) => { const ent = ctx.em.get(e); return ent ? ent.pos : {x:0,y:0,z:0}; },
      GetPlayerPed: (src) => { const p = ctx.pm.get(src); return p ? p.ped.id : 0; },
      CreateVehicle: (model, x, y, z, h, net, b) => {
        const v = ctx.vmgr.create(model, {x,y,z});
        ctx.sendToAll({ t: 'createVehicle', entity: v });
        return v.id;
      },
      on: (name, fn) => {
        ctx.events.on(name, ctx.name, (...args) => {
          // If first arg is a Player, set source to that netId but do NOT strip the arg
          const first = args[0];
          if (first && typeof first === 'object' && first.netId != null) {
            ctx.api.source = first.netId;
          } else {
            ctx.api.source = -1;
          }
          fn(...args);
          ctx.api.source = -1;
        });
      },
      onNet: (name, fn) => {
        ctx.events.on(name, ctx.name, (...args) => {
          const first = args[0];
          if (first && typeof first === 'object' && first.netId != null) {
            ctx.api.source = first.netId;
          } else {
            ctx.api.source = -1;
          }
          fn(...args);
          ctx.api.source = -1;
        });
      },
      emit: (name, ...args) => ctx.events.emit(name, null, ...args),
      emitNet: (name, target, ...args) => {
        if (target === -1 || target == null) ctx.events.emitNet(name, -1, ...args);
        else {
          const p = typeof target === 'number' ? ctx.pm.get(target) : target;
          if (p) ctx.events.emitNet(name, p, ...args);
        }
      },
      // Raw broadcast to all clients (for fake bots, custom packets)
      broadcast: (pkt) => { if (ctx.sendToAll) ctx.sendToAll(pkt, false); },
      RegisterCommand: (name, fn) => {
        ctx.events.on('cmd:' + name, ctx.name, (src, args) => fn(src, args));
      },
      print: (...a) => console.log(`[${ctx.name}]`, ...a),
      exports: this.exports,
      Citizen: { await: (p) => p, Wait: (ms) => new Promise(r => setTimeout(r, ms)) },
      setTimeout, setInterval, clearTimeout, clearInterval,
      console,
      require: (m) => {
        if (m === 'crypto') return require('crypto');
        throw new Error(`Cannot require('${m}') in resource sandbox`);
      },
      crypto: (() => { try { return require('crypto'); } catch { return {}; } })(),
      SendNUIMessage: (data) => {
        // NUI message forward - handled by client
      },
      RegisterKeyMapping: () => {},
      SetEntityCoords: () => {},
      SetEntityHealth: () => {},
      PlayerPedId: () => 0,
      GetParentResourceName: () => ctx.name
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[Resource] Starting '${this.name}'...`);
    const manifest = this._loadManifest();
    this._lastManifest = manifest;
    if (!manifest) { console.warn(`[Resource] ${this.name}: no fxmanifest.lua`); return; }

    for (const f of (manifest.server_scripts || [])) {
      const file = path.join(this.dir, f);
      if (fs.existsSync(file)) this._runJs(file);
    }
    for (const f of (manifest.client_scripts || [])) {
      // Client scripts are sent to the client to run in their own JS runtime
      const file = path.join(this.dir, f);
      if (fs.existsSync(file)) {
        this.scripts.push({ name: f, source: fs.readFileSync(file, 'utf8') });
      }
    }
    this.events.emit('onResourceStart', null, this.name);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.events.removeForResource(this.name);
    this.events.emit('onResourceStop', null, this.name);
    console.log(`[Resource] Stopped '${this.name}'`);
  }

  _loadManifest() {
    const p1 = path.join(this.dir, 'fxmanifest.lua');
    const p2 = path.join(this.dir, '__resource.lua');
    const file = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
    if (!file) return null;
    const src = fs.readFileSync(file, 'utf8');
    return this._parseManifest(src);
  }

  // Very small fxmanifest parser: understands `key 'val'` and `key {'a','b'}`
  _parseManifest(src) {
    const m = {};
    const lines = src.split(/\r?\n/);
    let currentKey = null, currentArr = null;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || l.startsWith('--')) continue;
      // start of array
      const arrm = l.match(/^(\w+)\s*\{/);
      if (arrm) {
        currentKey = arrm[1];
        currentArr = m[currentKey] = [];
        // Inline string values on same line
        const rest = l.slice(arrm[0].length);
        for (const sm of rest.matchAll(/'([^']+)'/g)) currentArr.push(sm[1]);
        if (l.includes('}')) { currentKey = null; currentArr = null; }
        continue;
      }
      if (currentArr && l.includes('}')) {
        for (const sm of l.matchAll(/'([^']+)'/g)) currentArr.push(sm[1]);
        currentKey = null; currentArr = null; continue;
      }
      if (currentArr) {
        for (const sm of l.matchAll(/'([^']+)'/g)) currentArr.push(sm[1]);
        continue;
      }
      const kv = l.match(/^(\w+)\s+'([^']+)'/);
      if (kv) m[kv[1]] = kv[2];
    }
    return m;
  }

  _runJs(file) {
    const src = fs.readFileSync(file, 'utf8');
    this.api = this._buildApi();
    if (!this._jsVm) {
      this._jsVm = vm.createContext(this.api);
    }
    try {
      vm.runInContext(src, this._jsVm, { filename: file });
    } catch (e) {
      console.error(`[${this.name}] ${file}: ${e.message}`);
    }
  }
}

class RuntimeManager {
  constructor(resourcesRoot, events, em, pm, vmgr, db, sendToAll, resourcePort = 0) {
    this.root = resourcesRoot;
    this.events = events;
    this.em = em; this.pm = pm; this.vmgr = vmgr; this.db = db;
    this.sendToAll = sendToAll;
    this.resourcePort = resourcePort;
    this.resources = new Map();
    this.resourceDirs = new Map(); // name -> absolute dir
  }

  // Walk a directory and return relative file list with sizes (for resource manifest)
  _walk(dir, prefix = '') {
    const out = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          out.push(...this._walk(full, rel));
        } else {
          try { out.push({ path: rel, size: fs.statSync(full).size }); } catch {}
        }
      }
    } catch {}
    return out;
  }

  discover() {
    if (!fs.existsSync(this.root)) return;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      const r = new ResourceContext(entry.name, dir, this.events, this.em,
                                    this.pm, this.vmgr, this.db, this.sendToAll);
      this.resources.set(entry.name, r);
      this.resourceDirs.set(entry.name, dir);
    }
  }

  startAll() {
    for (const r of this.resources.values()) r.start();
  }

  stopAll() {
    for (const r of this.resources.values()) r.stop();
  }

  get(name) { return this.resources.get(name); }

  start(name) {
    const r = this.resources.get(name);
    if (r) r.start();
  }
  stop(name) {
    const r = this.resources.get(name);
    if (r) r.stop();
  }
  restart(name) { this.stop(name); this.start(name); }

  gatherClientScripts() {
    const out = {};
    for (const r of this.resources.values()) {
      if (r.scripts.length) out[r.name] = r.scripts;
    }
    return out;
  }

  // Return manifest of all resource NUI/file data (for STAGE 6 resource discovery).
  // Client can HTTP GET /res/<resName>/<file> from the resource server.
  gatherResourceFiles() {
    const out = {};
    for (const [name, dir] of this.resourceDirs) {
      // Only list resources with NUI pages or client files
      const r = this.resources.get(name);
      const manifest = r && r._lastManifest ? r._lastManifest : null;
      // Walk client-side-relevant subdirs
      const files = [];
      for (const sub of ['html', 'nui', 'client', 'stream', 'data', 'web']) {
        const sd = path.join(dir, sub);
        if (fs.existsSync(sd) && fs.statSync(sd).isDirectory()) {
          for (const f of this._walk(sd, sub)) files.push(f);
        }
      }
      // Include any client_scripts in manifest at root
      if (r && r.scripts) {
        for (const s of r.scripts) {
          const fp = path.join(dir, s.name);
          try { if (fs.existsSync(fp)) files.push({ path: s.name, size: fs.statSync(fp).size }); } catch {}
        }
      }
      if (files.length || (manifest && (manifest.ui_page || manifest.nui_page))) {
        out[name] = {
          files,
          ui_page: manifest ? (manifest.ui_page || manifest.nui_page || null) : null,
          baseUrl: `http://127.0.0.1:${this.resourcePort}/res/${name}/`
        };
      }
    }
    return out;
  }
}

module.exports = { RuntimeManager, LUA_ENABLED };