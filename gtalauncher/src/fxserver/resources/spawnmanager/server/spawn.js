// Simple spawn manager - set spawn points and teleport players
const spawnPoints = [
  { x: 0, y: 0, z: 72 }
];

on('playerJoined', (player) => {
  setTimeout(() => {
    emitNet('spawnPlayer', player, player.ped.pos);
  }, 500);
});

RegisterCommand('setspawn', (src, args) => {
  if (!src) return;
  spawnPoints.push({ ...src.ped.pos });
  emitNet('chat', src, { type: 'system', msg: 'Spawn point set at your location' });
});

RegisterCommand('tpcoords', (src, args) => {
  if (!src || args.length < 3) return;
  const [x,y,z] = args.map(Number);
  src.ped.pos = { x, y, z };
  emitNet('teleport', src, { x, y, z });
});
print('spawnmanager loaded');