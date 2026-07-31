// Freeroam gamemode - v1.5.0: Phase 5 remote player position sync test.
//
// Phase 4: server->client spawnPed pipeline.
// Phase 5: continuous playerPos broadcast, netPed/netPedPos/netPedDel hook commands.

function sendChat(player, msg, name='SERVER') {
  if (!player || !player.endpoint) return;
  player.send({ t: 'chat', netId: player.netId, name, msg });
}

// ---- Test bot: a fake remote player (netId=9001) that walks in a circle ----
// Tests Phase 5 pipeline (playerJoin + playerPos streaming) without needing a 2nd GTA client.
const BOT_ID = 9001;
const BOT_NAME = 'TestBot';
const BOT_MODEL = 's_m_y_cop_01';
let botSpawned = false;
let botAngle = 0;
const botPos = { x: -295, y: -1340, z: 31.3 };
let botTicker = null;

function startBot() {
  if (botTicker) return false;
  botSpawned = false;
  // Announce the bot to all existing players
  emit('botPlayerJoin');
  // Tell all current players about the bot (we use broadcast)
  if (typeof broadcast === 'function') {
    broadcast({ t:'playerJoin', netId:BOT_ID, name:BOT_NAME, pos:botPos, h:0, health:200, model:BOT_MODEL, vehicle:0 });
  }
  botSpawned = true;
  botAngle = 0;
  botTicker = setInterval(() => {
    botAngle += 0.03;
    const px = botPos.x + Math.cos(botAngle) * 4;
    const py = botPos.y + Math.sin(botAngle) * 4;
    const h = botAngle * 180/Math.PI + 90;
    if (typeof broadcast === 'function') {
      broadcast({ t:'playerPos', netId:BOT_ID, name:BOT_NAME, model:BOT_MODEL,
                  x:px, y:py, z:botPos.z, h:h, health:200, inVeh:0 });
    }
  }, 66); // ~15Hz
  console.log('[freeroam] test bot started (netId=9001, walking in circle at airport)');
  return true;
}

// Phase 6 single-client lifecycle test: emits the same definitive leave packet
// that a real disconnect produces, so the hook must delete the remote ped.
function stopBot() {
  if (!botTicker) return false;
  clearInterval(botTicker);
  botTicker = null;
  botSpawned = false;
  if (typeof broadcast === 'function') {
    broadcast({ t:'playerLeft', netId:BOT_ID, name:BOT_NAME });
  }
  console.log('[freeroam] test bot stopped (playerLeft broadcast)');
  return true;
}

on('playerSpawned', (player) => {
  player.money = player.money || 5000;
  console.log(`[freeroam] ${player.name} spawned (#${player.netId})`);
  sendChat(player, `Welcome to GTAMP freeroam, ${player.name}! Phase 5 REMOTE PLAYER SYNC active.`);

  // Start the test bot on first spawn (server-wide)
  if (!botTicker) {
    setTimeout(() => {
      startBot();
      sendChat(player, 'TestBot has connected - watch for a cop walking in circles near you!');
    }, 4000);
  } else {
    // Late-join: send the bot directly
    setTimeout(() => {
      if (player.endpoint) {
        player.send({ t:'playerJoin', netId:BOT_ID, name:BOT_NAME, pos:botPos, h:0, health:200, model:BOT_MODEL, vehicle:0 });
        sendChat(player, 'TestBot is walking in circles nearby!');
      }
    }, 2000);
  }

  // Welcome cop (offset)
  setTimeout(() => {
    if (!player.endpoint) return;
    player.send({ t:'spawnPed', src:'SRV', model:'s_m_y_cop_01', pedType:6, offset:true });
    sendChat(player, 'Spawning welcome cop #1 (5m in front)...');
  }, 7000);
});

on('playerJoined', (player) => {
  if (player.money === undefined) player.money = 5000;
  console.log(`[freeroam] ${player.name} joined, wallet=$${player.money}`);
  sendChat(player, `${player.name} joined the server.`, 'JOIN');
});

RegisterCommand('car', (src, args) => {
  if (!src) return;
  sendChat(src, '(vehicles not yet wired through hook - /spawncop works server-side)');
});

RegisterCommand('givemoney', (src, args) => {
  if (!src) return;
  const amt = parseInt(args[0]) || 1000;
  src.money += amt;
  emitNet('money', src, src.money);
  sendChat(src, `+$${amt} (wallet $${src.money})`);
});

// F8: /testbot [start|stop|restart]
// Lets one GTA client verify remote join, despawn, and respawn lifecycle behavior.
RegisterCommand('testbot', (src, args) => {
  const action = String((args && args[0]) || 'restart').toLowerCase();
  if (action === 'stop') {
    const stopped = stopBot();
    if (src) sendChat(src, stopped ? 'TestBot disconnected. Its remote ped should disappear.' : 'TestBot is already stopped.');
  } else if (action === 'start') {
    const started = startBot();
    if (src) sendChat(src, started ? 'TestBot connected. One named remote ped should appear.' : 'TestBot is already running.');
  } else {
    stopBot();
    setTimeout(() => {
      const started = startBot();
      if (src) sendChat(src, started ? 'TestBot restarted. Verify exactly one remote ped appears.' : 'TestBot restart failed.');
    }, 250);
  }
});

RegisterCommand('spawncop', (src) => {
  if (!src || !src.endpoint) return;
  src.send({ t:'spawnPed', src:'SRV', model:'s_m_y_cop_01', pedType:6, offset:true });
  sendChat(src, 'Spawning a cop in front of you (server-originated)...');
});

print('freeroam v1.5.0 loaded - Phase 5 remote player position sync');
