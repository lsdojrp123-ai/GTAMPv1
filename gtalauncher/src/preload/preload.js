// src/preload/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gtamp', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (p) => ipcRenderer.invoke('config:set', p),
    reset: () => ipcRenderer.invoke('config:reset')
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    message: (o) => ipcRenderer.invoke('dialog:message', o)
  },
  gta: {
    detect: () => ipcRenderer.invoke('gta:detect'),
    validate: (p) => ipcRenderer.invoke('gta:validate', p),
    launcherType: (p) => ipcRenderer.invoke('gta:launcherType', p)
  },
  server: {
    info: () => ipcRenderer.invoke('server:info'),
    ping: (addr) => ipcRenderer.invoke('server:ping', addr),
    getList: () => ipcRenderer.invoke('master:getServers'),
    hostStart: (opts) => ipcRenderer.invoke('server:hostStart', opts),
    hostStop: () => ipcRenderer.invoke('server:hostStop')
  },
  game: { launch: (opts) => ipcRenderer.invoke('game:launch', opts) },
  shell: { open: (url) => ipcRenderer.invoke('shell:open', url) },
  history: { add: (e) => ipcRenderer.invoke('history:add', e) },
  bookmarks: {
    add: (s) => ipcRenderer.invoke('bookmarks:add', s),
    remove: (a) => ipcRenderer.invoke('bookmarks:remove', a)
  },
  datadir: {
    get: () => ipcRenderer.invoke('datadir:get'),
    open: (sub) => ipcRenderer.invoke('datadir:open', sub),
    clearCache: () => ipcRenderer.invoke('cache:clear')
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    relaunch: () => ipcRenderer.invoke('app:relaunch')
  },
  discord: {
    status: () => ipcRenderer.invoke('discord:status'),
    set: (p) => ipcRenderer.invoke('discord:set', p)
  },
  hook: {
    status: () => ipcRenderer.invoke('hook:status'),
    send: (obj) => ipcRenderer.invoke('hook:send', obj)
  },
  on: (channel, cb) => {
    const allowed = ['game:status', 'master:update', 'server:info', 'hook:status', 'hook:event'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, ...a) => cb(...a));
  }
});
