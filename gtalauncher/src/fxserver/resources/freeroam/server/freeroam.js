// Freeroam gamemode - v1.6.0: Phase 6 join/leave peds + Phase 7 chat relay.
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
const BOT_MODEL = 'mp_m_freemode_01';
let botSpawned = false;
let botAngle = 0;
const botPos = { x: -295, y: -1340, z: 31.3 };
let botTicker = null;

function startBot() {
  if (botTicker) return;
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
    let h = botAngle * 180/Math.PI + 90;
    h = ((h % 360) + 360) % 360; // keep heading in 0..360 like GTA/FiveM
    if (typeof broadcast === 'function') {
      broadcast({ t:'playerPos', netId:BOT_ID, name:BOT_NAME, model:BOT_MODEL,
                  x:px, y:py, z:botPos.z, h:h, health:200, inVeh:0 });
    }
  }, 66); // ~15Hz
  console.log('[freeroam] test bot started (netId=9001, walking in circle at airport)');
}

on('playerSpawned', (player) => {
  player.money = player.money || 5000;
  console.log(`[freeroam] ${player.name} spawned (#${player.netId})`);
  sendChat(player, `Welcome ${player.name}! Remote players sync FiveM-style (peds, nametags, blips). F8 chat.`);

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

RegisterCommand('spawncop', (src) => {
  if (!src || !src.endpoint) return;
  src.send({ t:'spawnPed', src:'SRV', model:'s_m_y_cop_01', pedType:6, offset:true });
  sendChat(src, 'Spawning a cop in front of you (server-originated)...');
});

print('freeroam v1.6.0 loaded - Phase 6 remote lifecycle + Phase 7 chat');
