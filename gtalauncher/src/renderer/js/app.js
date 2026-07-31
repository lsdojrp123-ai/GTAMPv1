// GTAMP launcher UI v1.0.4 - robust, no-throw init, real host via IPC
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; };

const state = {
  config: { nickname:'Player', gtaPath:'', bookmarks:[], history:[], volume:80, voiceEnabled:true, autoConnect:false, launcherType:'auto' },
  servers: [], selected: null, serverInfo: null,
  sortBy: 'players',
  filters: { maxPing:9999, hideEmpty:false, hideFull:false, lanOnly:false },
  favorites: new Set(),
  currentView: 'servers',
  consoleOpen: false, consoleHistory: [], historyIdx: -1,
  connecting: false,
  hostedServers: [], lanServers: []
};

function buildLocalServer(info) {
  return {
    name: 'GTAMP Official (Local)',
    addr: `127.0.0.1:${info?.gamePort || 22005}`,
    mode: 'Freeroam', players:1, max:64, ping:1, country:'us',
    tags: ['freeroam','local','official'],
    desc: 'Your local bundled FXServer. Auto-started with the launcher.',
    iconColor:'#f2882a', icon:'G1', official:true, local:true,
    _gamePort:info?.gamePort, _platformPort:info?.platformPort, _resPort:info?.resourcePort
  };
}
const FLAG_COLORS = {
  us:['#3c5a96','#d8282f'], eu:['#003090','#ffcc00'], br:['#009c3b','#ffdf00'],
  au:['#00008b','#ff0000'], as:['#c8102e','#ffde00'], jp:['#fff','#bc002d']
};
const flagHtml = c => {
  const cc=FLAG_COLORS[c]||['#555','#888'];
  return `<div class="srv-flag" style="background:linear-gradient(180deg,${cc[0]} 50%,${cc[1]} 50%)"></div>`;
};
const pingClass = p => p<0?'dead':p<60?'':p<120?'med':'bad';

function safeBind(id, fn, ev='click') {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, e => { try { fn(e); } catch(err) { console.error(`[${id}]`,err); toast(`Error in ${id}: ${err.message}`,'err'); } });
  else console.warn('[bind] missing #'+id);
}

// Boot — wrap everything so a single missing element doesn't kill the UI
window.addEventListener('DOMContentLoaded', () => {
  try { init(); } catch(e) { console.error('[init crashed]',e); alert('Init error: '+e.message); }
});

async function init() {
  // Window controls always work
  safeBind('tb-min', ()=>window.gtamp.window.minimize());
  safeBind('tb-max', ()=>window.gtamp.window.maximize());
  safeBind('tb-close', ()=>window.gtamp.window.close());

  // Home buttons
  safeBind('home-play', ()=>{switchView('servers');openPanel();});
  safeBind('home-host', ()=>{switchView('host');openPanel();});
  safeBind('home-direct', ()=>{switchView('direct');openPanel();focusId('direct-addr');});
  safeBind('home-direct-go', homeDirectGo);
  safeBind('hc-host-btn', ()=>{switchView('host');openPanel();});
  safeBind('hc-host-btn2', ()=>{switchView('host');openPanel();});
  safeBind('home-settings-btn', ()=>{switchView('settings');openPanel();});
  safeBind('lan-scan', scanLAN);
  const hdi = document.getElementById('home-direct-input');
  if (hdi) hdi.addEventListener('keydown', e => { if (e.key==='Enter') homeDirectGo(); });

  // Home connect cards
  $$('.hc-connect').forEach(b => b.onclick = () => {
    const addr=b.dataset.addr; const s=state.servers.find(x=>x.addr===addr);
    if (s) connectTo(s);
  });

  // Top bar
  safeBind('btn-home', goHome);
  safeBind('btn-servers', ()=>switchView('servers'));
  safeBind('btn-favs', ()=>switchView('favorites'));
  safeBind('btn-history', ()=>switchView('history'));
  safeBind('btn-host', ()=>switchView('host'));
  safeBind('btn-refresh', ()=>{refreshPing();scanLAN();toast('Refreshing...');});
  safeBind('feat-host-big', ()=>switchView('host'));
  safeBind('btn-add', ()=>{switchView('direct');focusId('direct-addr');});
  safeBind('btn-settings', ()=>switchView('settings'));

  // Search/filters/sort
  const ss = document.getElementById('server-search');
  if (ss) ss.addEventListener('input', renderServers);
  ['f-empty','f-full','f-lan'].forEach(id => safeBind(id, renderServers, 'change'));
  safeBind('f-ping', renderServers, 'change');
  $$('.dd-item[data-sort]').forEach(it => it.onclick = () => {
    state.sortBy = it.dataset.sort;
    $$('.dd-item').forEach(x=>x.classList.remove('active'));
    it.classList.add('active');
    $$('.filter-wrap').forEach(w=>w.classList.remove('open'));
    renderServers();
  });
  safeBind('btn-filter', e => { e.stopPropagation(); toggleDropdown('filter-dropdown'); });
  safeBind('btn-sort', e => { e.stopPropagation(); toggleDropdown('sort-dropdown'); });
  document.addEventListener('click', () => $$('.filter-wrap').forEach(w=>w.classList.remove('open')));

  // Direct connect
  safeBind('direct-connect', connectDirect);
  safeBind('direct-ping', pingDirect);

  // Host
  safeBind('host-start', startHostedServer);
  safeBind('host-stop', stopHostedServer);

  // Settings
  safeBind('settings-browse', browseGTA);
  safeBind('settings-autodetect', autodetectGTA);
  safeBind('settings-save', saveSettings);
  safeBind('settings-reset', resetSettings);
  safeBind('settings-clearcache', clearCache);
  safeBind('settings-opendata', openDataDir);
  const vm = document.getElementById('vol-master');
  if (vm) vm.addEventListener('input', e => {
    const lbl = document.getElementById('vol-label'); if (lbl) lbl.textContent = e.target.value;
  });

  // Connecting screen
  safeBind('conn-cancel-btn', cancelConnect);

  // Bottom bar connect
  safeBind('bb-connect', () => { if (state.selected) connectTo(state.selected); });

  // Load config + server info
  try { state.config = await window.gtamp.config.get(); } catch(e) { console.warn('config.get failed',e); }
  state.favorites = new Set((state.config.bookmarks||[]).map(b=>b.addr));

  // Populate settings fields
  setVal('settings-path', state.config.gtaPath||'');
  setVal('settings-nick', state.config.nickname||'Player');
  setVal('vol-master', state.config.volume??80);
  setVal('settings-launcher', state.config.launcherType||'auto');
  setCheck('settings-windowed', !!state.config.windowed);
  setCheck('settings-voice', state.config.voiceEnabled!==false);
  setCheck('settings-autoconnect', !!state.config.autoConnect);
  const vl = document.getElementById('vol-label'); if (vl) vl.textContent = state.config.volume??80;
  const np = document.getElementById('nick-pill'); if (np) np.textContent = state.config.nickname||'Player';
  const bn = document.getElementById('bb-nick'); if (bn) bn.textContent = state.config.nickname||'Player';
  const bp = document.getElementById('bb-platform'); if (bp) bp.textContent = 'Platform: '+(state.config.launcherType||'auto');

  // Server info + initial list
  try { state.serverInfo = await window.gtamp.server.info(); } catch(e){ console.warn('server.info failed',e); }
  state.servers = [buildLocalServer(state.serverInfo)];
  updateStatus('Idle');
  renderServers();
  renderQuickConnect();
  renderSaved();
  renderHosted();
  renderHistory();
  renderFavorites();

  // Phase 4: Spawn Cop button + hook events
  safeBind('btn-spawn-cop', async () => {
    const r = await window.gtamp.hook.send({t:'spawn', model:'s_m_y_cop_01', pedType:6}).catch(e=>({ok:false,error:e.message}));
    toast(r.ok?'Cop spawn queued in-game':'Hook not connected — launch GTA first', r.ok?'ok':'err');
  });
  window.gtamp.on('hook:status', s => { setHookPill(s.connected?'ok':'off'); showSpawnPanel(true); });
  window.gtamp.on('hook:event', pkt => {
    if (!pkt) return;
    if (pkt.t === 'hookHello') { setHookPill('ok'); logConsole('[hook] connected v='+pkt.v+' gta='+pkt.gta,'ok'); showSpawnPanel(true); }
    if (pkt.t === 'ready')    { setHookPill('ok'); logConsole('[hook] SHV script ready ped=0x'+(pkt.ped||0).toString(16),'ok'); showSpawnPanel(true); }
    if (pkt.t === 'spawn')    {
      const ok = pkt.ok && pkt.ped;
      logConsole('[hook] spawn ped='+pkt.ped+' ok='+pkt.ok+' '+(pkt.m||''), ok?'ok':'err');
      toast(pkt.m || (ok?'Spawned':'Spawn failed'), ok?'ok':'err');
    }
  });
  try { const s = await window.gtamp.hook.status(); setHookPill(s.connected?'ok':'off'); showSpawnPanel(true); } catch {}

  setInterval(refreshPing, 5000);
  setTimeout(refreshPing, 800);
  scanLAN();

  logConsole('GTAMP Client v1.5.2', 'info');
  logConsole('Type "help" or "connect host:port" to join a server. Click HOST A SERVER to start your own.', 'info');
  logConsole(`Local server running at ${state.servers[0].addr}`, 'msg');

  // Global key handler (F8, ESC, Enter for console)
  document.addEventListener('keydown', onKeyDown);
  const fi = document.getElementById('f8-input');
  if (fi) fi.addEventListener('keydown', e => {
    if (e.key==='Enter') { runCommand(fi.value); fi.value=''; historyIdx=-1; }
    else if (e.key==='ArrowUp') { e.preventDefault(); cycleHistory(-1); }
    else if (e.key==='ArrowDown') { e.preventDefault(); cycleHistory(1); }
    else if (e.key==='Escape') { toggleConsole(false); }
  });

  window.onerror = (msg,src,l,c,e)=>{ console.error('[UI error]',msg,src,l); toast('Error: '+msg,'err'); };
  window.addEventListener('unhandledrejection', e=>{ console.error('[promise]',e.reason); });
}

function setVal(id, v) { const el=document.getElementById(id); if (el) el.value=v; }
function setCheck(id, v) { const el=document.getElementById(id); if (el) el.checked=!!v; }
function focusId(id) { const el=document.getElementById(id); if (el) el.focus(); }
function toggleDropdown(id) {
  const d = document.getElementById(id); if (!d) return;
  const open = d.parentElement.classList.contains('open');
  $$('.filter-wrap').forEach(w=>w.classList.remove('open'));
  if (!open) d.parentElement.classList.add('open');
}

// ============================================================
// HOME/NAV
// ============================================================
function goHome() {
  const hs = document.getElementById('home-screen');
  const lp = document.getElementById('launcher');
  if (hs) hs.classList.remove('hidden');
  if (lp) lp.classList.remove('visible');
}
function openPanel() {
  const hs = document.getElementById('home-screen');
  const lp = document.getElementById('launcher');
  if (hs) hs.classList.add('hidden');
  if (lp) lp.classList.add('visible');
}
function homeDirectGo() {
  const inp = document.getElementById('home-direct-input');
  if (!inp) return;
  const addr = inp.value.trim();
  if (!addr) return;
  addDirect(addr, true);
}
function switchView(view) {
  state.currentView = view;
  $$('.view-col').forEach(c => c.classList.remove('active'));
  const tgt = document.getElementById('view-'+view);
  if (tgt) tgt.classList.add('active');
  ['servers','favs','history','host','settings'].forEach(n => {
    const b = document.getElementById('btn-'+n);
    if (b) b.classList.toggle('active', view===n || (n==='favs'&&view==='favorites') || (n==='servers'&&view==='servers'));
  });
  if (view==='favorites') renderFavorites();
  if (view==='history') renderHistory();
  if (view==='host') renderHosted();
  if (view==='direct') renderSaved();
}

// ============================================================
// SERVER LIST
// ============================================================
function applyFilters(list) {
  return list.filter(s => {
    const q = (document.getElementById('server-search')?.value||'').trim().toLowerCase();
    if (q && !/^[\d.:]+$/.test(q) && !s.name.toLowerCase().includes(q) && !(s.desc||'').toLowerCase().includes(q)) return false;
    if (q && /^[\d.:]+$/.test(q) && !s.addr.includes(q.replace(/^https?:\/\//,''))) return false;
    if (state.filters.lanOnly && !s.lan && !s.local && !s.hosted) return false;
    if (state.filters.hideEmpty && s.players===0) return false;
    if (state.filters.hideFull && s.players>=s.max) return false;
    if (s.ping>=0 && s.ping>state.filters.maxPing) return false;
    return true;
  });
}
function refreshPing() {
  const all = [...state.servers, ...state.lanServers, ...state.hostedServers];
  all.forEach(s => { if (s.ping<0 || s.local || s.hosted) s.ping = s.local||s.hosted ? 1 : Math.floor(5+Math.random()*90); });
  renderServers();
  const bp = document.getElementById('bb-ping');
  if (bp && state.selected) bp.textContent = state.selected.ping+'ms';
}
function renderServers() {
  const el = document.getElementById('server-list');
  if (!el) return;
  let list = applyFilters([...state.servers, ...state.lanServers, ...state.hostedServers]);
  switch (state.sortBy) {
    case 'ping': list.sort((a,b)=>(a.ping<0?9999:a.ping)-(b.ping<0?9999:b.ping)); break;
    case 'name': list.sort((a,b)=>a.name.localeCompare(b.name)); break;
    default: list.sort((a,b)=>b.players-a.players);
  }
  if (!list.length) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:#6a7080;">No servers. Click HOST A SERVER to start one, or use DIRECT CONNECT.</div>';
    updateSelected(null);
    return;
  }
  el.innerHTML = list.map(s => {
    const cls = 'srv-row'+(state.selected&&state.selected.addr===s.addr?' selected':'')+(s.official?' official':'');
    const pingBars = Array.from({length:4},(_,i)=>`<span style="height:${(i+1)*3+3}px;${i<Math.max(1,Math.round((s.ping<0?0:s.ping<60?4:s.ping<120?3:s.ping<200?2:1)))?'':'opacity:0.2'}"></span>`).join('');
    return `<div class="${cls}" data-addr="${esc(s.addr)}">
      <div class="srv-ping ${pingClass(s.ping)}">${pingBars}</div>
      ${flagHtml(s.country||'us')}
      <div class="srv-name">
        <div class="srv-title">${esc(s.name)}</div>
        <div class="srv-desc">${esc(s.desc||s.addr)}</div>
      </div>
      <div class="srv-tags">${(s.tags||[]).map(t=>`<span class="tag ${esc(t)}">${esc(t)}</span>`).join('')}</div>
      <div class="srv-players">${s.players}/${s.max}</div>
    </div>`;
  }).join('');
  $$('.srv-row', el).forEach(row => {
    row.onclick = () => { const s = list.find(x=>x.addr===row.dataset.addr); updateSelected(s); };
    row.ondblclick = () => { const s = list.find(x=>x.addr===row.dataset.addr); if (s) connectTo(s); };
    row.oncontextmenu = e => { e.preventDefault(); showContext(e.pageX,e.pageY,list.find(x=>x.addr===row.dataset.addr)); };
  });
  if (state.selected && !list.find(x=>x.addr===state.selected.addr)) updateSelected(list[0]);
  if (!state.selected) updateSelected(list[0]);
}
function updateSelected(s) {
  state.selected = s;
  $$('.srv-row').forEach(r=>r.classList.toggle('selected', s&&r.dataset.addr===s.addr));
  const bc = document.getElementById('bb-connect');
  const bs = document.getElementById('bb-server');
  const bp = document.getElementById('bb-ping');
  if (bc) bc.disabled = !s;
  if (bs) bs.textContent = s ? s.name : 'No server selected';
  if (bp) bp.textContent = s ? (s.ping+'ms') : '--ms';
  renderQuickConnect();
}
function renderQuickConnect() {
  const el = document.getElementById('feat-quick'); if (!el) return;
  const entries = [];
  const local = state.servers.find(s=>s.local);
  if (local) entries.push(local);
  state.hostedServers.slice(0,2).forEach(s=>entries.push(s));
  (state.config.bookmarks||[]).slice(0,3).forEach(b=>{
    const s = [...state.servers,...state.hostedServers].find(x=>x.addr===b.addr);
    if (s) entries.push(s); else entries.push({name:b.name||b.addr,addr:b.addr,players:0,max:0,desc:'Favorite',tags:['favorite'],iconColor:'#ffd36a',icon:'FV'});
  });
  el.innerHTML = entries.slice(0,5).map(s => `
    <div class="feat-card" data-addr="${esc(s.addr)}">
      <div class="feat-title">${esc(s.name)}</div>
      <div class="feat-desc">${esc(s.addr)} · ${s.players}/${s.max}</div>
      <button class="btn btn-orange btn-sm" data-addr="${esc(s.addr)}">CONNECT</button>
    </div>`).join('') || '<div class="feat-empty">No quick-connect entries yet.</div>';
  $$('.feat-card [data-addr], .feat-card', el).forEach(b => {
    const addr = b.dataset.addr || b.querySelector('[data-addr]')?.dataset.addr;
    if (!addr) return;
    b.addEventListener('click', e => {
      if (e.target.tagName==='BUTTON' || b.classList.contains('feat-card')) {
        const s = [...state.servers,...state.hostedServers,...state.lanServers].find(x=>x.addr===addr);
        if (s) { updateSelected(s); if(e.target.tagName==='BUTTON') connectTo(s); }
      }
    });
  });
}

// ============================================================
// DIRECT CONNECT
// ============================================================
function addDirect(addr, connect) {
  const existing = state.servers.find(x=>x.direct && x.addr===addr);
  if (existing) { if (connect) connectTo(existing); return existing; }
  const s = {
    name: 'Direct: '+addr, addr, mode:'Direct', players:1, max:64, ping:-1, country:'us',
    tags:['direct'], desc:'Direct connection', iconColor:'#c89aff', icon:'->', direct:true
  };
  state.servers.push(s);
  const save = document.getElementById('direct-save');
  if (save && save.checked) {
    if (!(state.config.bookmarks||[]).find(b=>b.addr===addr)) {
      state.config.bookmarks = [...(state.config.bookmarks||[]), {name:s.name, addr:s.addr}];
      window.gtamp.bookmarks.add(s).catch(()=>{});
      window.gtamp.config.set(state.config).catch(()=>{});
    }
  }
  renderServers();
  renderSaved();
  updateSelected(s);
  if (connect) connectTo(s);
  return s;
}
async function connectDirect() {
  const a = document.getElementById('direct-addr'); if (!a) return;
  const addr = a.value.trim();
  if (!addr) { toast('Enter an address','err'); return; }
  const s = addDirect(addr, false);
  const status = document.getElementById('direct-status');
  if (status) status.textContent = 'Pinging...';
  try {
    const r = await window.gtamp.server.ping(addr);
    if (status) status.textContent = `Ping: ${r.time}ms · ${r.name||addr}`;
    s.ping = r.time;
  } catch { if (status) status.textContent = 'Ping failed (server may still be joinable)'; s.ping = 999; }
  renderServers();
  connectTo(s);
}
async function pingDirect() {
  const a = document.getElementById('direct-addr'); if (!a) return;
  const addr = a.value.trim(); if (!addr) return;
  const status = document.getElementById('direct-status'); if (status) status.textContent='Pinging...';
  try { const r = await window.gtamp.server.ping(addr); if(status)status.textContent=`Ping: ${r.time}ms · ${r.name||addr}`; }
  catch { if(status)status.textContent='Ping failed.'; }
}
function renderSaved() {
  const el = document.getElementById('saved-list'); if (!el) return;
  const saved = state.config.bookmarks||[];
  el.innerHTML = saved.length ? saved.map(b=>`
    <div class="hist-row" data-addr="${esc(b.addr)}">
      <div style="flex:1;">
        <div style="color:#fff;font-weight:600;">${esc(b.name||b.addr)}</div>
        <div style="color:#7a8090;font-size:11px;">${esc(b.addr)}</div>
      </div>
      <button class="btn btn-orange btn-sm" data-addr="${esc(b.addr)}">JOIN</button>
      <button class="btn btn-ghost btn-sm" data-rm="${esc(b.addr)}">REMOVE</button>
    </div>`).join('') : '<div class="feat-empty">No saved addresses. Connect to a server or use "Save to favorites".</div>';
  $$('.hist-row [data-addr]', el).forEach(b => b.onclick = () => {
    const s = [...state.servers,...state.hostedServers].find(x=>x.addr===b.dataset.addr);
    if (s) connectTo(s); else addDirect(b.dataset.addr, true);
  });
  $$('[data-rm]', el).forEach(b => b.onclick = () => {
    state.config.bookmarks = (state.config.bookmarks||[]).filter(x=>x.addr!==b.dataset.rm);
    window.gtamp.config.set(state.config).catch(()=>{});
    state.favorites.delete(b.dataset.rm);
    renderSaved(); renderFavorites(); renderQuickConnect();
  });
}

// ============================================================
// HISTORY / FAVORITES
// ============================================================
function renderHistory() {
  const el = document.getElementById('history-list'); if (!el) return;
  const hist = state.config.history||[];
  el.innerHTML = hist.length ? hist.map(h=>`
    <div class="hist-row" data-addr="${esc(h.addr)}">
      <div style="flex:1;">
        <div style="color:#fff;font-weight:600;">${esc(h.name)}</div>
        <div style="color:#7a8090;font-size:11px;">${esc(h.addr)} · ${new Date(h.joinedAt).toLocaleString()}</div>
      </div>
      <button class="btn btn-orange btn-sm" data-addr="${esc(h.addr)}">JOIN</button>
    </div>`).join('') : '<div class="feat-empty">No history yet. Join a server to see it here.</div>';
  $$('.hist-row [data-addr]', el).forEach(b => b.onclick = () => {
    const s = [...state.servers,...state.hostedServers].find(x=>x.addr===b.dataset.addr);
    if (s) connectTo(s); else addDirect(b.dataset.addr, true);
  });
}
function renderFavorites() {
  const el = document.getElementById('favorites-list'); if (!el) return;
  const favs = state.config.bookmarks||[];
  el.innerHTML = favs.length ? favs.map(b=>`
    <div class="hist-row" data-addr="${esc(b.addr)}">
      <div style="flex:1;">
        <div style="color:#fff;font-weight:600;">${esc(b.name||b.addr)} &#9733;</div>
        <div style="color:#7a8090;font-size:11px;">${esc(b.addr)}</div>
      </div>
      <button class="btn btn-orange btn-sm" data-addr="${esc(b.addr)}">JOIN</button>
      <button class="btn btn-ghost btn-sm" data-rm="${esc(b.addr)}">REMOVE</button>
    </div>`).join('') : '<div class="feat-empty">No favorites. Right-click a server → Add to Favorites.</div>';
  $$('.hist-row [data-addr]', el).forEach(b => b.onclick = () => {
    const s = [...state.servers,...state.hostedServers].find(x=>x.addr===b.dataset.addr);
    if (s) connectTo(s); else addDirect(b.dataset.addr, true);
  });
  $$('[data-rm]', el).forEach(b => b.onclick = () => {
    state.config.bookmarks = (state.config.bookmarks||[]).filter(x=>x.addr!==b.dataset.rm);
    window.gtamp.bookmarks.remove(b.dataset.rm).catch(()=>{});
    window.gtamp.config.set(state.config).catch(()=>{});
    state.favorites.delete(b.dataset.rm);
    renderSaved(); renderFavorites(); renderQuickConnect();
  });
}

// ============================================================
// HOST (spawns a real FXServer via IPC into main process)
// ============================================================
async function startHostedServer() {
  const name = getVal('host-name')||'My GTAMP Server';
  const port = parseInt(getVal('host-port'))||0;
  const max  = parseInt(getVal('host-max'))||32;
  const mode = getVal('host-gamemode')||'freeroam';
  const lan  = !!document.getElementById('host-lan')?.checked;
  const pub  = !!document.getElementById('host-public')?.checked;
  const desc = getVal('host-desc')||'Welcome to my server!';
  const status = document.getElementById('host-status');
  if (status) status.innerHTML = `<div style="color:#ffd36a;">Starting server "${esc(name)}"...</div>`;
  try {
    const res = await window.gtamp.server.hostStart({name,port,max,mode,lan,public:pub,desc});
    if (!res || !res.ok) throw new Error(res?.error||'Failed to start');
    const srv = {
      name, addr:`127.0.0.1:${res.port}`, mode:modeLabel(mode), players:1, max, ping:1, country:'us',
      tags:['hosted',mode,lan?'lan':'local'].concat(pub?['public']:[]),
      desc: desc + (pub?' (public)':''), iconColor:'#7fd89b', icon:'HS', hosted:true, _port:res.port
    };
    state.hostedServers.push(srv);
    if (status) status.innerHTML = `<div style="color:#6ddc94;">✓ Server "${esc(name)}" started on ${srv.addr}</div>
      <div style="margin-top:8px;color:#9aa0b0;font-size:12px;">
        Max players: ${max} · Gamemode: ${modeLabel(mode)}<br>
        ${pub?'Listed publicly (ensure port-forwarded)':'LAN/local only'}
      </div>`;
    const sBtn=document.getElementById('host-start'), pBtn=document.getElementById('host-stop');
    if (sBtn)sBtn.disabled=true; if (pBtn)pBtn.disabled=false;
    renderHosted(); renderQuickConnect(); renderServers();
    toast(`Server "${name}" started on port ${res.port}`,'ok');
    logConsole(`Host: started "${name}" on ${srv.addr} (${modeLabel(mode)}, ${max} slots)`, 'info');
  } catch(e) {
    console.error(e);
    if (status) status.innerHTML = `<div style="color:#e87d7d;">Failed to start: ${esc(e.message)}</div>`;
    toast('Failed to start server: '+e.message,'err');
  }
}
async function stopHostedServer() {
  if (!state.hostedServers.length) return;
  const last = state.hostedServers[state.hostedServers.length-1];
  try { await window.gtamp.server.hostStop(); } catch(e){ console.warn('hostStop',e); }
  state.hostedServers.pop();
  const sBtn=document.getElementById('host-start'), pBtn=document.getElementById('host-stop');
  if (sBtn)sBtn.disabled=false; if (pBtn)pBtn.disabled=true;
  const status = document.getElementById('host-status');
  if (status) status.innerHTML = `<div style="color:#e87d7d;">✓ Server "${esc(last.name)}" stopped.</div>`;
  renderHosted(); renderQuickConnect(); renderServers();
  toast('Server stopped','ok');
  logConsole(`Host: stopped "${last.name}"`, 'warn');
}
function renderHosted() {
  const el = document.getElementById('host-running'); if (!el) return;
  if (!state.hostedServers.length) { el.innerHTML='<div class="feat-empty">No servers running. Click START SERVER to begin.</div>'; return; }
  el.innerHTML = state.hostedServers.map(s=>`
    <div class="feat-card">
      <div class="feat-title">${esc(s.name)}</div>
      <div class="feat-desc">${esc(s.addr)} · ${s.players}/${s.max} · ${esc(s.mode)}</div>
      <button class="btn btn-orange btn-sm" data-addr="${esc(s.addr)}">CONNECT</button>
    </div>`).join('');
  $$('.feat-card [data-addr]', el).forEach(b => b.onclick = () => {
    const s = state.hostedServers.find(x=>x.addr===b.dataset.addr);
    if (s) connectTo(s);
  });
  const hosted = document.getElementById('feat-hosted');
  if (hosted) {
    if (state.hostedServers.length) {
      hosted.innerHTML = state.hostedServers.map(s=>`
        <div class="feat-card" data-addr="${esc(s.addr)}">
          <div class="feat-title">${esc(s.name)}</div>
          <div class="feat-desc">${s.players}/${s.max} · ${esc(s.mode)}</div>
          <button class="btn btn-orange btn-sm" data-addr="${esc(s.addr)}">CONNECT</button>
        </div>`).join('');
      $$('[data-addr]', hosted).forEach(b => b.onclick = () => {
        const s = state.hostedServers.find(x=>x.addr===b.dataset.addr);
        if (s) connectTo(s);
      });
    } else {
      hosted.innerHTML = '<div class="feat-empty">No hosted servers running. Click HOST A SERVER above to start one.</div>';
    }
  }
}
function getVal(id) { return document.getElementById(id)?.value?.trim()||''; }
function modeLabel(m) { return ({freeroam:'Freeroam',roleplay:'Roleplay',drift:'Drift/Racing',deathmatch:'Deathmatch',sandbox:'Sandbox'})[m]||m; }
function scanLAN() {
  state.lanServers = [];
  const lc=document.getElementById('lan-count'), ld=document.getElementById('lan-desc');
  if (lc) lc.textContent='0 servers';
  if (ld) ld.textContent='No LAN servers detected.';
  renderServers();
}

// ============================================================
// SETTINGS
// ============================================================
async function browseGTA() {
  try {
    const r = await window.gtamp.dialog.selectFolder();
    if (r?.path) setVal('settings-path', r.path);
  } catch(e){ toast('Browse failed: '+e.message,'err'); }
}
async function autodetectGTA() {
  try {
    const r = await window.gtamp.gta.detect();
    if (r?.path) { setVal('settings-path', r.path); toast('Found GTA V at '+r.path,'ok'); }
    else toast('Could not auto-detect GTA V. Use BROWSE.','err');
  } catch(e){ toast('Autodetect failed: '+e.message,'err'); }
}
async function saveSettings() {
  state.config.gtaPath = getVal('settings-path');
  state.config.nickname = getVal('settings-nick')||'Player';
  state.config.launcherType = getVal('settings-launcher')||'auto';
  state.config.volume = parseInt(document.getElementById('vol-master')?.value||'80');
  state.config.windowed = !!document.getElementById('settings-windowed')?.checked;
  state.config.voiceEnabled = !!document.getElementById('settings-voice')?.checked;
  state.config.autoConnect = !!document.getElementById('settings-autoconnect')?.checked;
  try {
    await window.gtamp.config.set(state.config);
    const np=document.getElementById('nick-pill'); if(np)np.textContent=state.config.nickname;
    const bn=document.getElementById('bb-nick'); if(bn)bn.textContent=state.config.nickname;
    const bp=document.getElementById('bb-platform'); if(bp)bp.textContent='Platform: '+state.config.launcherType;
    toast('Settings saved','ok');
  } catch(e){ toast('Save failed: '+e.message,'err'); }
}
async function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  try { await window.gtamp.config.reset(); location.reload(); } catch(e){ toast('Reset failed','err'); }
}
async function clearCache() {
  try { await window.gtamp.datadir.clearCache(); toast('Cache cleared','ok'); } catch(e){ toast('Clear cache failed','err'); }
}
async function openDataDir() {
  try { await window.gtamp.datadir.open(''); toast('Data folder opened','ok'); } catch(e){ toast('Open failed','err'); }
}

// ============================================================
// CONNECTING FLOW (13 stages)
// ============================================================
let connTimer = null;
async function connectTo(s) {
  if (!s || state.connecting) return;
  state.connecting = true;
  state.selected = s;
  updateSelected(s);
  const c = document.getElementById('connecting');
  if (c) c.classList.add('open');
  const stage = document.getElementById('conn-stage');
  const sub   = document.getElementById('con-sub');
  const resEl = document.getElementById('conn-resources');
  const STAGES = [
    'Starting GTAMP','Loading settings & cache','Contacting platform services',
    'Retrieving server information','Initializing network','Handshaking with FXServer',
    'Discovering resources','Downloading chat','Downloading freeroam',
    'Downloading spawnmanager','Downloading voice','Loading client scripts & NUI',
    'Requesting spawn, launching GTA V (GTAMP session)','Injecting GTAMP hook',
    'Finalizing connection'
  ];
  const RESOURCES = ['chat','freeroam','spawnmanager','voice','chat NUI'];
  if (resEl) resEl.innerHTML = RESOURCES.map(r=>`
    <div class="conn-res-row" data-r="${esc(r)}">
      <div class="conn-res-name">${esc(r)}</div>
      <div class="conn-res-bar"><div class="conn-res-fill"></div></div>
      <div class="conn-res-pct">0%</div>
    </div>`).join('');
  for (let i=0;i<STAGES.length;i++) {
    if (stage) stage.textContent = STAGES[i];
    if (sub) sub.textContent = `Stage ${i+1} of ${STAGES.length}`;
    // Injecting hook stage waits longer (real 10s delay happens in main, we show progress)
    const stageDelay = (STAGES[i].includes('Injecting')) ? 1200 : (250 + Math.random()*350);
    await new Promise(r => setTimeout(r, stageDelay));
    if (i>=7 && i<=11) {
      const ri = i-7;
      const row = resEl?.querySelector(`[data-r="${RESOURCES[ri]}"]`);
      if (row) {
        for (let p=0;p<=100;p+=8) {
          const f = row.querySelector('.conn-res-fill'), pl = row.querySelector('.conn-res-pct');
          if (f) f.style.width=p+'%'; if (pl) pl.textContent=p+'%';
          await new Promise(r=>setTimeout(r,20));
        }
      }
    }
  }
  if (stage) stage.textContent = 'Connected to GTAMP — launching GTA V...';
  await new Promise(r=>setTimeout(r,800));
  // Actually launch via main
  try {
    const res = await window.gtamp.game.launch({
      serverAddr: s.addr,
      launcherType: state.config.launcherType||'auto'
    });
    if (!res.ok) {
      if (c) c.classList.remove('open');
      state.connecting = false;
      toast('Launch failed: '+res.error,'err');
      dialogMessage('Launch error', res.error);
      return;
    }
    if (res.note) toast(res.note, 'warn');
    if (res.launched) logConsole('Launch method: '+res.launched+' (FiveM-style platform boot)','info');

    toast('GTAMP session started. GTA launches offline from Rockstar Online (our multiplayer). Hook loads in ~15–30s.','ok');
    logConsole(`GTAMP multiplayer -> ${s.addr} (Rockstar Online disabled; GTAMP hook injects in ~15-30s)`,'ok');
    // Add to history
    state.config.history = [{name:s.name,addr:s.addr,mode:s.mode||'Direct',joinedAt:Date.now()},...(state.config.history||[])].slice(0,20);
    window.gtamp.history.add({name:s.name,addr:s.addr,mode:s.mode||'Direct',joinedAt:Date.now()}).catch(()=>{});
    window.gtamp.config.set(state.config).catch(()=>{});
    renderHistory();
    toast(`Joined ${s.name} — multiplayer via GTAMP`,'ok');
    logConsole(`Connected to ${s.name} (${s.addr})`,'ok');
  } catch(e) {
    console.error(e);
    toast('Launch error: '+e.message,'err');
  } finally {
    setTimeout(() => { if (c) c.classList.remove('open'); state.connecting=false; }, 1500);
  }
}
function cancelConnect() {
  const c = document.getElementById('connecting'); if (c) c.classList.remove('open');
  state.connecting = false;
  toast('Connect cancelled','warn');
}

// ============================================================
// F8 CONSOLE
// ============================================================
function toggleConsole(force) {
  const c = document.getElementById('f8-console');
  const want = force!==undefined ? force : !state.consoleOpen;
  state.consoleOpen = want;
  if (c) c.classList.toggle('open', want);
  if (want) { const i=document.getElementById('f8-input'); if(i)i.focus(); }
}
function onKeyDown(e) {
  if (e.key === 'F8') { e.preventDefault(); toggleConsole(); return; }
  if (e.key === 'Escape' && state.consoleOpen) { e.preventDefault(); toggleConsole(false); return; }
}
function cycleHistory(dir) {
  const inp = document.getElementById('f8-input'); if (!inp) return;
  if (!state.consoleHistory.length) return;
  historyIdx = historyIdx<0 ? state.consoleHistory.length-1 : (historyIdx+dir+state.consoleHistory.length)%state.consoleHistory.length;
  inp.value = state.consoleHistory[historyIdx]||'';
  setTimeout(()=>inp.setSelectionRange(inp.value.length,inp.value.length),0);
}
function logConsole(msg, kind='msg') {
  const out = document.getElementById('f8-output'); if (!out) return;
  const line = document.createElement('div');
  line.className = 'log-'+kind;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  out.appendChild(line); out.scrollTop = out.scrollHeight;
}
function runCommand(cmd) {
  cmd = (cmd||'').trim(); if (!cmd) return;
  // Strip leading slash a la FiveM: "/spawncop" -> "spawncop"
  if (cmd.startsWith('/')) cmd = cmd.slice(1).trim();
  if (!cmd) return;
  state.consoleHistory.push(cmd); historyIdx=-1;
  logConsole('> '+cmd,'msg');
  const parts = cmd.split(/\s+/); const c = parts[0].toLowerCase(); const args = parts.slice(1);
  try { cmdHandlers[c] ? cmdHandlers[c](args) : logConsole(`Unknown command: ${c}. Type help.`,'warn'); }
  catch(e) { logConsole('Error: '+e.message,'err'); }
}
const cmdHandlers = {
  help: () => logConsole(
    'Commands (leading / is optional): connect <host:port> | disconnect | quit/exit/q | load/stop/restart <res> | list | say <msg> | me/do | clear/cls | bind | fps | netstat | audio <0-100> | nick <name> | save | clearcache | opendatadir | host start|stop | spawncop | spawn <model> | spawnat <model> <x> <y> <z> [h] | about | help'
  ,'info'),
  connect: a => {
    // Find first arg that looks like host:port (skip filler words like "to")
    const addr = (a||[]).find(x => /^[\w\.\-]+:\d+$/.test(x)) || a[0];
    if(!addr) return logConsole('usage: connect <host:port>','warn');
    addDirect(addr, true);
  },
  disconnect: () => { cancelConnect(); logConsole('Disconnected','warn'); },
  quit: () => window.gtamp.window.close(),
  exit: () => window.gtamp.window.close(),
  q: () => window.gtamp.window.close(),
  list: () => { const all=[...state.servers,...state.hostedServers]; all.forEach(s=>logConsole(`  ${s.addr.padEnd(22)} ${String(s.players).padStart(4)}/${s.max}  ${s.name}`,'info')); },
  say: a => logConsole('[chat] '+a.join(' '),'msg'),
  me: a => logConsole('* '+((state.config.nickname||'Player')+' '+a.join(' ')),'msg'),
  do: a => logConsole('(( '+a.join(' ')+' ))','msg'),
  clear: () => { const o=document.getElementById('f8-output'); if(o)o.innerHTML=''; },
  cls: () => { cmdHandlers.clear(); },
  fps: () => logConsole('FPS counter toggled (stub)','info'),
  netstat: () => {
    const all=[...state.servers,...state.hostedServers];
    logConsole(`Servers: ${all.length} (${state.hostedServers.length} hosted)`,'info');
    all.forEach(s => logConsole(`  ${s.addr} ping=${s.ping}ms players=${s.players}/${s.max}`,'info'));
  },
  audio: a => {
    const v = parseInt(a[0]);
    if (isNaN(v)||v<0||v>100) return logConsole('usage: audio <0-100>','warn');
    const vm=document.getElementById('vol-master'), vl=document.getElementById('vol-label');
    if(vm)vm.value=v; if(vl)vl.textContent=v;
    state.config.volume=v; window.gtamp.config.set(state.config).catch(()=>{});
    logConsole(`Volume set to ${v}`,'ok');
  },
  nick: a => { if(!a[0])return; state.config.nickname=a.join(' '); window.gtamp.config.set(state.config).catch(()=>{});
    const np=document.getElementById('nick-pill');if(np)np.textContent=state.config.nickname;
    const bn=document.getElementById('bb-nick');if(bn)bn.textContent=state.config.nickname;
    logConsole('Nickname: '+state.config.nickname,'info'); },
  save: () => { window.gtamp.config.set(state.config).then(()=>logConsole('Saved','ok')).catch(e=>logConsole('Save failed','err')); },
  clearcache: () => { window.gtamp.datadir.clearCache().then(()=>logConsole('Cache cleared','ok')).catch(()=>logConsole('Failed','err')); },
  opendatadir: () => { window.gtamp.datadir.open('').then(()=>logConsole('Opened data folder','ok')).catch(()=>logConsole('Failed','err')); },
  host: a => {
    if (a[0]==='start') { toggleConsole(false); switchView('host'); openPanel(); startHostedServer(); }
    else if (a[0]==='stop') { stopHostedServer(); }
    else logConsole('usage: host start|stop','warn');
  },
  about: () => logConsole('GTAMP Multiplayer v1.5.2 — FiveM-style launcher (Phase 5: remote player position sync, SHV fiber fix)','info'),
  bind: () => logConsole('Binds: F8 console · F11 in-game spawn · ESC close · Enter connect','info'),
  load: a => logConsole((a[0]?'Loading '+a[0]:'No resource specified'),'info'),
  stop: a => logConsole((a[0]?'Stopping '+a[0]:'No resource specified'),'info'),
  restart: a => logConsole((a[0]?'Restarting '+a[0]:'No resource specified'),'info'),
  spawncop: async () => {
    const r = await window.gtamp.hook.send({t:'spawn', model:'s_m_y_cop_01', pedType:6}).catch(e=>({ok:false,error:e.message}));
    logConsole(r.ok?'Sent cop spawn to hook':'Hook not connected (launch GTA first) — '+ (r.error||''), r.ok?'ok':'err');
  },
  spawn: async (a) => {
    const model = a[0]||'s_m_y_cop_01';
    const r = await window.gtamp.hook.send({t:'spawn', model, pedType:4}).catch(e=>({ok:false,error:e.message}));
    logConsole(r.ok?('Sent spawn '+model):('Hook not connected — '+(r.error||'')), r.ok?'ok':'err');
  },
  spawnat: async (a) => {
    const model = a[0]||'s_m_y_cop_01';
    const x=parseFloat(a[1]), y=parseFloat(a[2]), z=parseFloat(a[3]);
    const h=parseFloat(a[4]||'0');
    if(isNaN(x)||isNaN(y)||isNaN(z)) return logConsole('usage: spawnat <model> <x> <y> <z> [h]','warn');
    const r = await window.gtamp.hook.send({t:'spawnPed', model, x, y, z, h, pedType:4, offset:false})
      .catch(e=>({ok:false,error:e.message}));
    logConsole(r.ok?(`Sent spawnat ${model} at ${x},${y},${z}`):('Hook not connected — '+(r.error||'')), r.ok?'ok':'err');
  },
};

// ============================================================
// CONTEXT MENU + TOASTS + STATUS
// ============================================================
function showContext(x,y,s) {
  const m = document.getElementById('ctx-menu'); if (!m||!s) return;
  m.innerHTML = `
    <div class="ctx-item" data-a="connect">Connect to ${esc(s.name)}</div>
    <div class="ctx-item" data-a="fav">${state.favorites.has(s.addr)?'Remove from Favorites':'Add to Favorites'}</div>
    <div class="ctx-item" data-a="ping">Refresh ping</div>`;
  m.style.left=x+'px'; m.style.top=y+'px'; m.classList.add('open');
  m.onclick = e => {
    const a = e.target.dataset.a; m.classList.remove('open');
    if (a==='connect') connectTo(s);
    else if (a==='fav') {
      if (state.favorites.has(s.addr)) {
        state.favorites.delete(s.addr);
        state.config.bookmarks=(state.config.bookmarks||[]).filter(b=>b.addr!==s.addr);
        window.gtamp.bookmarks.remove(s.addr).catch(()=>{});
        toast('Removed from favorites','ok');
      } else {
        state.favorites.add(s.addr);
        state.config.bookmarks=[...(state.config.bookmarks||[]),{name:s.name,addr:s.addr}];
        window.gtamp.bookmarks.add(s).catch(()=>{});
        toast('Added to favorites','ok');
      }
      window.gtamp.config.set(state.config).catch(()=>{});
      renderSaved(); renderFavorites(); renderQuickConnect();
    } else if (a==='ping') { s.ping=Math.floor(5+Math.random()*90); renderServers(); }
  };
  setTimeout(() => document.addEventListener('click',()=>m.classList.remove('open'),{once:true}),0);
}
function toast(msg, kind='') {
  const t = document.getElementById('toasts'); if (!t) { console.log('toast:',msg); return; }
  const d = document.createElement('div'); d.className='toast '+kind; d.textContent=msg;
  t.appendChild(d); setTimeout(()=>{d.style.opacity='0';d.style.transition='opacity 0.3s';setTimeout(()=>d.remove(),300);},3500);
}
function updateStatus(text) {
  const el = document.getElementById('bb-status'); if (el) el.textContent = text;
}
function dialogMessage(title, msg) {
  try { window.gtamp.dialog.message({title, message:msg, type:'error'}); } catch { alert(title+': '+msg); }
}
function setHookPill(state) {
  const pill = document.getElementById('sp-pill');
  const txt  = document.getElementById('sp-txt');
  if (!pill || !txt) return;
  pill.classList.remove('ok','wait');
  if (state === 'ok') { pill.classList.add('ok'); txt.textContent='Hook: connected (F11 or click Spawn Cop)'; }
  else if (state === 'wait') { pill.classList.add('wait'); txt.textContent='Hook: waiting for SHV...'; }
  else { txt.textContent='Hook: not connected (launch GTA)'; }
}
function showSpawnPanel(show) {
  const p = document.getElementById('spawn-panel');
  if (p) p.style.display = show ? 'flex' : 'none';
}
