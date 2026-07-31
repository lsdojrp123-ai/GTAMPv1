// Chat resource - server side
on('chatMessage', (player, msg) => {
  // Command routing: /cmd args...
  if (msg.startsWith('/')) {
    const parts = msg.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    emit('cmd:' + cmd, player, args);
  }
});

RegisterCommand('me', (src, args) => {
  const p = src;
  if (!p) return;
  const text = args.join(' ');
  emitNet('chat', -1, { type: 'me', name: p.name, msg: '* ' + text });
});

RegisterCommand('do', (src, args) => {
  const p = src;
  if (!p) return;
  const text = args.join(' ');
  emitNet('chat', -1, { type: 'do', name: p.name, msg: '* ' + text + ' (( ' + p.name + ' ))' });
});

RegisterCommand('ooc', (src, args) => {
  const p = src;
  if (!p) return;
  emitNet('chat', -1, { type: 'ooc', name: p.name, msg: '((' + args.join(' ') + '))' });
});

on('playerJoined', (player) => {
  emitNet('chat', -1, { type: 'system', msg: `* ${player.name} joined the server` });
});
on('playerDropped', (player) => {
  emitNet('chat', -1, { type: 'system', msg: `* ${player.name} left the server` });
});

print('chat resource loaded');