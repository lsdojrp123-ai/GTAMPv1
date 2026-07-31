// Voice chat placeholder - real implementation uses Opus + WebRTC-like media server
// In v1 we just track talk state and volume
let voiceMode = 'proximity'; // proximity | radio | phone
let talking = false;

RegisterCommand('voicemode', () => {
  voiceMode = voiceMode === 'proximity' ? 'radio' : 'proximity';
  sendNuiMessage('voice:mode', voiceMode);
});
print('voice client loaded');