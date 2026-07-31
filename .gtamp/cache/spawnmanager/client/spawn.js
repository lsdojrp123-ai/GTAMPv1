onNet('spawnPlayer', (pos) => {
  // Request local player spawn at pos
  sendNuiMessage('spawn', pos);
});

onNet('teleport', (pos) => {
  SetEntityCoords(PlayerPedId(), pos.x, pos.y, pos.z, false, false, false, false);
});
print('spawnmanager client loaded');