// Freeroam client - v1.4.3: handles server welcomeCop event
onNet('money', (amt) => {
  sendNuiMessage('hud:money', amt);
});

onNet('welcomeCop', (info) => {
  console.log('[freeroam client] welcomeCop event:', JSON.stringify(info));
  sendNuiMessage('toast', { text: 'Server spawned a welcome cop!', color: '#50d050' });
});

RegisterCommand('kill', () => {
  // Hook-side native not wired yet; this is a no-op placeholder
  sendNuiMessage('toast', { text: '/kill not yet hooked', color: '#d05050' });
});

print('freeroam client v1.4.3 loaded');
