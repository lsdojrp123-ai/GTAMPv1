// Chat NUI - runs inside in-game browser overlay
const msgs = document.getElementById('chat-msgs');
const input = document.getElementById('chat-input');

window.addEventListener('message', (e) => {
  if (e.data.type === 'chat:focus') {
    input.style.display = 'block';
    input.focus();
  } else if (e.data.type === 'chat:add') {
    addMessage(e.data);
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && input.value.trim()) {
    fetch(`https://${GetParentResourceName()}/chatMsg`, {
      method: 'POST', body: JSON.stringify({ msg: input.value })
    });
    input.value = ''; input.style.display = 'none';
  } else if (e.key === 'Escape') {
    input.value = ''; input.style.display = 'none';
  }
});

function addMessage(d) {
  const div = document.createElement('div');
  div.className = 'msg ' + (d.type || '');
  if (d.type !== 'system') {
    const span = document.createElement('span');
    span.className = 'chat-name';
    span.textContent = (d.name || 'Console') + ':';
    div.appendChild(span);
  }
  div.appendChild(document.createTextNode(d.msg || ''));
  msgs.insertBefore(div, msgs.firstChild);
  while (msgs.children.length > 100) msgs.removeChild(msgs.lastChild);
}

function GetParentResourceName() { return 'chat'; }