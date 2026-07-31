// Discord Rich Presence for GTAMP (FiveM-style "Playing" status)
// Requires a Discord Application Client ID from:
//   https://discord.com/developers/applications  → New Application → copy Application ID
// Optional: upload art assets named "gtamp" and "gta5" under Rich Presence → Art Assets.

const path = require('path');

// Built-in GTAMP Discord Application ID (used automatically when none is set in Settings).
const DEFAULT_CLIENT_ID = '1532843546640384311';

let rpc = null;
let ready = false;
let enabled = true;
let clientId = '';
let startedAt = null;
let current = {
  details: 'In launcher',
  state: 'Browsing servers',
  largeImageKey: 'gtamp',
  largeImageText: 'GTAMP Multiplayer',
  smallImageKey: undefined,
  smallImageText: undefined
};

function log(...a) {
  try { console.log('[Discord RPC]', ...a); } catch {}
}

function applyActivity() {
  if (!rpc || !ready || !enabled) return;
  try {
    const activity = {
      details: String(current.details || 'GTAMP').slice(0, 128),
      state: String(current.state || '').slice(0, 128),
      startTimestamp: startedAt || Date.now(),
      instance: false
    };
    if (current.largeImageKey) {
      activity.largeImageKey = current.largeImageKey;
      activity.largeImageText = current.largeImageText || 'GTAMP';
    }
    if (current.smallImageKey) {
      activity.smallImageKey = current.smallImageKey;
      activity.smallImageText = current.smallImageText || '';
    }
    // Buttons optional — Discord allows up to 2
    activity.buttons = [
      { label: 'GTAMP on GitHub', url: 'https://github.com/lsdojrp123-ai/GTAMPv1' }
    ];
    rpc.setActivity(activity).catch(e => log('setActivity', e.message));
  } catch (e) {
    log('applyActivity error', e.message);
  }
}

/**
 * @param {{ enabled?: boolean, clientId?: string }} opts
 */
function start(opts = {}) {
  enabled = opts.enabled !== false;
  clientId = String(opts.clientId || process.env.GTAMP_DISCORD_APP_ID || '').trim() || DEFAULT_CLIENT_ID;
  if (!enabled) {
    stop();
    return { ok: false, error: 'disabled' };
  }
  if (!clientId || !/^\d{17,20}$/.test(clientId)) {
    log('No valid Discord Application ID. Set Settings → Discord App ID (from discord.com/developers).');
    return { ok: false, error: 'missing_app_id' };
  }
  if (rpc) {
    applyActivity();
    return { ok: true, already: true };
  }
  let DiscordRPC;
  try {
    DiscordRPC = require('discord-rpc');
  } catch (e) {
    log('discord-rpc package missing:', e.message);
    return { ok: false, error: 'module_missing' };
  }
  try {
    DiscordRPC.register(clientId);
  } catch {}
  rpc = new DiscordRPC.Client({ transport: 'ipc' });
  startedAt = Date.now();
  rpc.on('ready', () => {
    ready = true;
    log('connected as', rpc.user ? rpc.user.username : '?');
    applyActivity();
  });
  rpc.on('disconnected', () => {
    ready = false;
    log('disconnected');
  });
  rpc.login({ clientId }).catch(e => {
    log('login failed (is Discord desktop running?):', e.message);
    ready = false;
    rpc = null;
  });
  return { ok: true };
}

function setPresence( partial = {} ) {
  current = { ...current, ...partial };
  applyActivity();
}

function setInLauncher() {
  setPresence({
    details: 'In GTAMP Launcher',
    state: 'Browsing servers',
    largeImageKey: 'gtamp',
    largeImageText: 'GTAMP Multiplayer',
    smallImageKey: undefined,
    smallImageText: undefined
  });
}

function setConnecting(serverName, addr) {
  setPresence({
    details: 'Connecting…',
    state: (serverName || addr || 'server').toString().slice(0, 128),
    largeImageKey: 'gtamp',
    largeImageText: 'GTAMP'
  });
}

function setInGame(serverName, addr, playerCount) {
  const name = (serverName || 'GTAMP Server').toString().slice(0, 128);
  let state = addr ? String(addr).slice(0, 128) : 'In session';
  if (playerCount != null) state = `${playerCount} player(s) · ${state}`.slice(0, 128);
  setPresence({
    details: `Playing on ${name}`.slice(0, 128),
    state,
    largeImageKey: 'gtamp',
    largeImageText: 'GTAMP Multiplayer',
    smallImageKey: 'gta5',
    smallImageText: 'Grand Theft Auto V'
  });
}

function stop() {
  enabled = false;
  ready = false;
  try {
    if (rpc) {
      rpc.clearActivity().catch(() => {});
      rpc.destroy();
    }
  } catch {}
  rpc = null;
}

function status() {
  return {
    enabled,
    ready,
    hasClientId: !!(clientId && /^\d{17,20}$/.test(clientId)),
    clientIdSuffix: clientId ? clientId.slice(-4) : null,
    current
  };
}

module.exports = {
  start,
  stop,
  setPresence,
  setInLauncher,
  setConnecting,
  setInGame,
  status,
  applyActivity
};
