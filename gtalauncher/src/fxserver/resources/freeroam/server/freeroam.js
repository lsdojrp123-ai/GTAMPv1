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
let lastRealPlayer = null;

// Anchor for TestBot orbit — updated from first/local player position
let botAnchor = { x: botPos.x, y: botPos.y, z: botPos.z };

function startBot(aroundPlayer) {
  if (botTicker) return;
  if (aroundPlayer && aroundPlayer.ped && aroundPlayer.ped.pos) {
    botAnchor = { ...aroundPlayer.ped.pos };
    botPos.x = botAnchor.x; botPos.y = botAnchor.y; botPos.z = botAnchor.z;
  }
  botSpawned = false;
  emit('botPlayerJoin');
  const joinPos = { x: botAnchor.x + 4, y: botAnchor.y, z: botAnchor.z };
  if (typeof broadcast === 'function') {
    broadcast({ t:'playerJoin', netId:BOT_ID, name:BOT_NAME, pos:joinPos, h:0, health:200, model:BOT_MODEL, vehicle:0 });
  }
  botSpawned = true;
  botAngle = 0;
  botTicker = setInterval(() => {
    // Prefer last known real player position (updated in playerSpawned + player pos ticks)
    if (lastRealPlayer && lastRealPlayer.ped && lastRealPlayer.ped.pos) {
      botAnchor = { ...lastRealPlayer.ped.pos };
    }
    botAngle += 0.03;
    const px = botAnchor.x + Math.cos(botAngle) * 5;
    const py = botAnchor.y + Math.sin(botAngle) * 5;
    const pz = botAnchor.z;
    let h = botAngle * 180/Math.PI + 90;
    h = ((h % 360) + 360) % 360;
    if (typeof broadcast === 'function') {
      broadcast({ t:'playerPos', netId:BOT_ID, name:BOT_NAME, model:BOT_MODEL,
                  x:px, y:py, z:pz, h:h, health:200, inVeh:0 });
    }
  }, 66); // ~15Hz
  console.log('[freeroam] test bot started near player at', botAnchor);
}

on('playerSpawned', (player) => {
  player.money = player.money || 5000;
  lastRealPlayer = player;
  if (player.ped && player.ped.pos) botAnchor = { ...player.ped.pos };
  console.log(`[freeroam] ${player.name} spawned (#${player.netId})`);
  sendChat(player, `Welcome ${player.name}! Phase 6: remote peds + nametags. F8 chat. F11 local cop.`);

  if (!botTicker) {
    setTimeout(() => {
      startBot(player);
      sendChat(player, 'TestBot connected — look for a freemode ped walking circles near YOU.');
    }, 3000);
  } else {
    setTimeout(() => {
      if (player.endpoint) {
        const jp = { x: botAnchor.x + 4, y: botAnchor.y, z: botAnchor.z };
        player.send({ t:'playerJoin', netId:BOT_ID, name:BOT_NAME, pos:jp, h:0, health:200, model:BOT_MODEL, vehicle:0 });
        sendChat(player, 'TestBot is nearby (orbiting players).');
      }
    }, 1500);
  }

  // Welcome cop 5m in front via client spawnPed
  setTimeout(() => {
    if (!player.endpoint) return;
    player.send({ t:'spawnPed', src:'SRV', model:'s_m_y_cop_01', pedType:6, offset:true });
    sendChat(player, 'Welcome cop spawning 5m ahead...');
  }, 5000);
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
