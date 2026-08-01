// GTAMP Website server - Express + EJS
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const { seed } = require('./lib/seed');
seed();

const app = express();
const server = http.createServer(app);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.locals.page = req.path; next(); });
app.use(session({
  secret: process.env.GTAMP_SECRET || 'gtamp-dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// ---------- helpers ----------
function settings() { return store.load('settings', {}); }
function users() { return store.load('users', []); }
function servers() { return store.load('servers', []); }
function saveServers(s) { store.save('servers', s); }
function userById(id) { return users().find(u => String(u.id) === String(id)); }
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, badges: badgeIdsFor(u.id), created: u.created };
}
function badgeIdsFor(uid) {
  return store.load('user_badges', []).filter(b => String(b.uid) === String(uid)).map(b => b.bid);
}
function badgeDefs() { return store.load('badges', []); }
function badgeOf(id) { return badgeDefs().find(b => b.id === id); }
function requireAuth(req, res, next) { if (!req.session.uid) return res.redirect('/login'); next(); }
function requireStaff(req, res, next) {
  if (!req.session.uid) return res.redirect('/login');
  const ids = badgeIdsFor(req.session.uid);
  const staff = badgeDefs().filter(b => b.role === 'staff');
  if (!ids.some(i => staff.some(s => s.id === i))) return res.status(403).send('Staff only');
  next();
}

// ---------- Live server sync (from launcher) ----------
// Launcher POSTs its live state here; website + launcher GET it back.
app.post('/api/servers/report', (req, res) => {
  const p = req.body || {};
  if (!p || typeof p.addr !== 'string') return res.status(400).json({ error: 'missing addr' });
  const list = servers();
  let srv = list.find(s => s.addr === p.addr);
  const now = Date.now();
  if (!srv) {
    srv = {
      id: store.nextId('servers'),
      addr: p.addr,
      name: p.name || p.addr,
      desc: p.desc || '',
      mode: p.mode || 'Freeroam',
      ownerId: p.ownerId || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      createdAt: now
    };
    list.push(srv);
  }
  srv.players = Number(p.players) || 0;
  srv.maxPlayers = Number(p.maxPlayers) || 64;
  srv.ping = Number(p.ping) || 0;
  srv.model = p.model || 'gtamp';
  srv.lastSeen = now;
  srv.ip = req.ip;
  saveServers(list);
  res.json({ ok: true, id: srv.id });
});

app.get('/api/servers/live', (req, res) => {
  const cutoff = Date.now() - (1000 * 60 * 5); // 5 min stale
  const live = servers().filter(s => (s.lastSeen || 0) > cutoff).map(s => ({
    id: s.id, addr: s.addr, name: s.name, desc: s.desc, mode: s.mode,
    players: s.players, maxPlayers: s.maxPlayers, ping: s.ping, tags: s.tags, model: s.model
  }));
  res.json({ servers: live });
});

// Launcher "active" ping -> live count of launchers seen in the last 90s.
// In-memory on purpose: this is transient presence data, not state to persist.
const liveLaunchers = new Map(); // id -> lastSeen
app.post('/api/launcher/ping', (req, res) => {
  const id = String((req.body && req.body.id) || req.ip || 'anon');
  liveLaunchers.set(id, Date.now());
  res.json({ ok: true });
});
app.get('/api/launcher/active', (req, res) => {
  const cutoff = Date.now() - 90 * 1000;
  for (const [id, t] of liveLaunchers) if (t < cutoff) liveLaunchers.delete(id);
  res.json({ active: liveLaunchers.size });
});

// ---------- Download ----------
app.get('/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(__dirname, '..', 'GTAMP-Launcher-' + file);
  if (require('fs').existsSync(p)) return res.download(p);
  res.status(404).send('Not found - run `npm run dist` in gtalauncher and place the exe at repo root.');
});

// ---------- Pages ----------
app.get('/', (req, res) => {
  const live = store.load('servers', []).filter(s => (s.lastSeen || 0) > Date.now() - 5*60*1000);
  res.render('index', { user: publicUser(userById(req.session.uid)), settings: settings(), liveCount: live.length, livePlayers: live.reduce((a, s) => a + (s.players||0), 0) });
});

app.get('/servers', (req, res) => {
  res.render('servers', { user: publicUser(userById(req.session.uid)), settings: settings() });
});

app.get('/servers/:id', (req, res) => {
  const srv = servers().find(s => Number(s.id) === Number(req.params.id));
  if (!srv) return res.status(404).send('Server not found');
  res.render('server', { user: publicUser(userById(req.session.uid)), settings: settings(), srv });
});

// ---------- Upvotes (boost) ----------
app.post('/api/servers/:id/upvote', (req, res) => {
  if (!req.session.uid) return res.status(401).json({ error: 'login' });
  const list = servers();
  const srv = list.find(s => Number(s.id) === Number(req.params.id));
  if (!srv) return res.status(404).json({ error: 'notfound' });
  const up = store.load('upvotes', []);
  const existing = up.find(u => String(u.uid) === String(req.session.uid) && Number(u.sid) === Number(srv.id));
  if (existing) return res.status(400).json({ error: 'already' });
  up.push({ uid: req.session.uid, sid: srv.id, at: Date.now(), boost: 1 });
  store.save('upvotes', up);
  srv.upvotes = (srv.upvotes || 0) + 1;
  saveServers(list);
  res.json({ ok: true, upvotes: srv.upvotes });
});

// ---------- Tags (server owners) ----------
app.post('/api/servers/:id/tags', (req, res) => {
  if (!req.session.uid) return res.status(401).json({ error: 'login' });
  const list = servers();
  const srv = list.find(s => Number(s.id) === Number(req.params.id));
  if (!srv) return res.status(404).json({ error: 'notfound' });
  if (String(srv.ownerId) !== String(req.session.uid)) return res.status(403).json({ error: 'not owner' });
  const t = Array.isArray(req.body.tags) ? req.body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 5) : [];
  srv.tags = t;
  saveServers(list);
  res.json({ ok: true, tags: t });
});

// ---------- Auth ----------
app.get('/login', (req, res) => res.render('login', { user: null, error: null, settings: settings() }));
app.get('/register', (req, res) => res.render('register', { user: null, error: null, settings: settings() }));
app.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.render('register', { user: null, error: 'Username + password (min 6 chars) required', settings: settings() });
  }
  const list = users();
  if (list.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.render('register', { user: null, error: 'Username taken', settings: settings() });
  }
  const user = { id: store.nextId('users'), username, email: email || '', pass: bcrypt.hashSync(password, 10), created: Date.now() };
  list.push(user);
  store.save('users', list);
  // grant early adopter badge
  const ub = store.load('user_badges', []); ub.push({ uid: user.id, bid: 'b_early' }); store.save('user_badges', ub);
  req.session.uid = user.id;
  res.redirect('/');
});
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const list = users();
  const user = list.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.pass)) {
    return res.render('login', { user: null, error: 'Invalid credentials', settings: settings() });
  }
  req.session.uid = user.id;
  res.redirect('/');
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ---------- Forum ----------
app.get('/forum', (req, res) => {
  const cats = store.load('forum_categories', []);
  const posts = store.load('forum_posts', []);
  res.render('forum', { user: publicUser(userById(req.session.uid)), settings: settings(), cats, posts });
});
app.get('/forum/:cat', (req, res) => {
  const cats = store.load('forum_categories', []);
  const cat = cats.find(c => c.id === req.params.cat);
  if (!cat) return res.status(404).send('Category not found');
  const posts = store.load('forum_posts', []).filter(p => p.cat === cat.id);
  res.render('forum_cat', { user: publicUser(userById(req.session.uid)), settings: settings(), cat, posts });
});
app.get('/forum/thread/:id', (req, res) => {
  const posts = store.load('forum_posts', []);
  const post = posts.find(p => Number(p.id) === Number(req.params.id));
  if (!post) return res.status(404).send('Thread not found');
  const replies = store.load('forum_replies', []).filter(r => Number(r.pid) === post.id);
  res.render('thread', { user: publicUser(userById(req.session.uid)), settings: settings(), post, replies });
});
app.post('/forum/:cat/new', requireAuth, (req, res) => {
  const { title, body } = req.body;
  const posts = store.load('forum_posts', []);
  const post = { id: store.nextId('forum_posts'), cat: req.params.cat, title: title || 'untitled', body: body || '', uid: req.session.uid, at: Date.now() };
  posts.push(post); store.save('forum_posts', posts);
  res.redirect('/forum/thread/' + post.id);
});
app.post('/forum/thread/:id/reply', requireAuth, (req, res) => {
  const replies = store.load('forum_replies', []);
  replies.push({ id: store.nextId('forum_replies'), pid: Number(req.params.id), uid: req.session.uid, body: req.body.body || '', at: Date.now() });
  store.save('forum_replies', replies);
  res.redirect('/forum/thread/' + req.params.id);
});

// ---------- Support ----------
app.get('/support', (req, res) => {
  res.render('support', { user: publicUser(userById(req.session.uid)), settings: settings() });
});

// ---------- Marketplace ----------
app.get('/marketplace', (req, res) => {
  const assets = store.load('assets', []).filter(a => a.published);
  res.render('marketplace', { user: publicUser(userById(req.session.uid)), settings: settings(), assets });
});
app.get('/marketplace/:id', (req, res) => {
  const assets = store.load('assets', []);
  const asset = assets.find(a => Number(a.id) === Number(req.params.id));
  if (!asset) return res.status(404).send('Asset not found');
  res.render('marketplace_item', { user: publicUser(userById(req.session.uid)), settings: settings(), asset, author: publicUser(userById(asset.ownerId)) });
});
app.get('/keymaster', requireAuth, (req, res) => {
  const licenses = store.load('licenses', []).filter(l => String(l.uid) === String(req.session.uid));
  const assets = store.load('assets', []).filter(a => String(a.ownerId) === String(req.session.uid));
  res.render('keymaster', { user: publicUser(userById(req.session.uid)), settings: settings(), licenses, assets });
});
app.post('/keymaster/assets/new', requireAuth, (req, res) => {
  const assets = store.load('assets', []);
  const { title, desc, price, cat } = req.body;
  assets.push({ id: store.nextId('assets'), ownerId: req.session.uid, title: title || 'Untitled', desc: desc || '', price: Number(price) || 0, cat: cat || 'script', published: false, downloads: 0, at: Date.now() });
  store.save('assets', assets);
  res.redirect('/keymaster');
});
app.post('/keymaster/assets/:id/publish', requireAuth, (req, res) => {
  const assets = store.load('assets', []);
  const a = assets.find(x => Number(x.id) === Number(req.params.id) && String(x.ownerId) === String(req.session.uid));
  if (a) { a.published = true; store.save('assets', assets); }
  res.redirect('/keymaster');
});

// ---------- Docs ----------
app.get('/docs', (req, res) => {
  res.render('docs', { user: publicUser(userById(req.session.uid)), settings: settings(), docs: store.load('docs', []) });
});
app.get('/docs/:id', (req, res) => {
  const doc = store.load('docs', []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).send('Doc not found');
  res.render('doc', { user: publicUser(userById(req.session.uid)), settings: settings(), doc });
});

// ---------- Run your own server ----------
app.get('/run-server', (req, res) => {
  res.render('run_server', { user: publicUser(userById(req.session.uid)), settings: settings(), artifacts: store.load('artifacts', []) });
});

// ---------- Artifacts download ----------
app.get('/artifacts/:file', (req, res) => {
  res.status(404).send('Place your server artifact archives in website/public/artifacts/ or link them.');
});

// ---------- Admin (staff only) ----------
app.get('/admin/badges', requireStaff, (req, res) => {
  res.render('admin_badges', { user: publicUser(userById(req.session.uid)), settings: settings(), badges: badgeDefs(), users: users().map(publicUser) });
});
app.post('/admin/badges/grant', requireStaff, (req, res) => {
  const { uid, bid } = req.body;
  const ub = store.load('user_badges', []);
  if (!ub.find(b => String(b.uid) === String(uid) && b.bid === bid)) ub.push({ uid, bid });
  store.save('user_badges', ub);
  res.redirect('/admin/badges');
});
app.post('/admin/badges/remove', requireStaff, (req, res) => {
  const { uid, bid } = req.body;
  store.save('user_badges', store.load('user_badges', []).filter(b => !(String(b.uid) === String(uid) && b.bid === bid)));
  res.redirect('/admin/badges');
});

// ---------- WebSocket for live push to launcher/site ----------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const d = JSON.parse(msg.toString());
      if (d && d.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
    } catch (e) {}
  });
});
function broadcastServers() {
  const live = servers().filter(s => (s.lastSeen || 0) > Date.now() - 5*60*1000);
  const data = JSON.stringify({ t: 'servers', servers: live });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}
setInterval(broadcastServers, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('GTAMP website on http://localhost:' + PORT));
