// Chat client script - runs on the client via the in-client JS VM
// The runtime registers 'onNet' which listens for server-emitted events.
onNet('chat', (data) => {
  // Forward to NUI
  sendNuiMessage('chat:add', data);
});

// Register T key to toggle chat input (client-side key handler)
RegisterKeyMapping('t', 'Toggle chat', 'keyboard', 'T');
RegisterCommand('t', () => {
  sendNuiMessage('chat:focus', {});
});

print('chat client loaded');