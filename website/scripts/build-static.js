// Build a fully static, self-contained GTAMP website you can open by
// double-clicking website/static/index.html — no server required.
// Run: node scripts/build-static.js
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { seed } = require('../lib/seed');
seed();

const store = require('../lib/store');
const settings = store.load('settings', {});
const users = store.load('users', []);
const badges = store.load('badges', []);
const cats = store.load('forum_categories', []);
const posts = store.load('forum_posts', []);
const replies = store.load('forum_replies', []);
const assets = store.load('assets', []);
const docs = store.load('docs', []);
const artifacts = store.load('artifacts', []);

// Bake some sample data so the static site doesn't look empty.
const sampleServers = [
  { id: 1, name: 'GTAMP Official #1', desc: 'Bundled freeroam server with TestBot.', mode: 'Freeroam', players: 2, maxPlayers: 64, tags: ['freeroam', 'community'], upvotes: 12 },
  { id: 2, name: "Night City RP", desc: 'Serious roleplay server.', mode: 'Roleplay', players: 18, maxPlayers: 128, tags: ['roleplay'], upvotes: 45 },
  { id: 3, name: 'Drift Kings', desc: 'Drifting and racing.', mode: 'Drift / Racing', players: 9, maxPlayers: 32, tags: ['drift', 'racing'], upvotes: 30 },
  { id: 4, name: 'Cops & Robbers', desc: 'PvP cops and robbers.', mode: 'Deathmatch', players: 11, maxPlayers: 32, tags: ['pvp', 'cops'], upvotes: 22 }
];
const sampleAssets = assets.length ? assets : [
  { id: 1, title: 'Realistic Car Pack', desc: '10 fully tuned vehicles.', price: 12.99, cat: 'car', downloads: 340, ownerId: 1 },
  { id: 2, title: 'Advanced Job System', desc: 'Framework for jobs and crews.', price: 0, cat: 'script', downloads: 900, ownerId: 2 },
  { id: 3, title: 'City Hall Map', desc: 'Detailed interior map.', price: 8.99, cat: 'map', downloads: 120, ownerId: 3 }
];
const samplePosts = posts.length ? posts : [
  { id: 1, cat: 'announcements', title: 'GTAMP v1.9.7 released', body: 'In-game connect panel, F8 console, T chat — the full FiveM-style join flow is live.', uid: 1, at: Date.now() },
  { id: 2, cat: 'client-support', title: 'ERR_NO_LAUNCHER fix', body: 'Make sure you launch through the platform you bought GTA on.', uid: 2, at: Date.now() },
  { id: 3, cat: 'scripting', title: 'Your first script', body: 'Check the docs — it only takes a few lines to make things happen.', uid: 3, at: Date.now() }
];
const sampleReplies = replies.length ? replies : [{ id: 1, pid: 2, uid: 4, body: 'That fixed it for me, thanks!', at: Date.now() }];

function live() { return sampleServers; }

const base = { settings, badges, page: '/' };
const viewsDir = path.join(__dirname, '..', 'views');
const outDir = path.join(__dirname, '..', 'static');
fs.mkdirSync(outDir, { recursive: true });

function render(view, data, outName) {
  return ejs.renderFile(path.join(viewsDir, view + '.ejs'), { ...base, ...data }, { views: viewsDir, filename: path.join(viewsDir, view + '.ejs') })
    .then(html => {
      const depth = outName.split('/').length - 1;
      const up = depth === 0 ? './' : '../'.repeat(depth);
      const fixed = html.replace(/(href|action|src)=("|')(\/[^"']*)\2/g, (m, attr, q, p) => {
        if (p === '/') return attr + '=' + q + up + 'index.html' + q;
        if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/img/')) return attr + '=' + q + up + p.slice(1) + q;
        if (p.startsWith('http')) return m;
        if (p.startsWith('/download/')) return attr + '=' + q + up + p.replace('/download/', '') + q;
        if (p.startsWith('/artifacts/') || p.startsWith('/api/')) return attr + '=' + q + '#' + q;
        // POST form targets can't work in a static (file://) build — neutralize
        if (attr === 'action' && (p === '/login' || p === '/register' || p.startsWith('/keymaster/') || p.startsWith('/admin/') || /\/(new|reply|publish)$/.test(p))) return attr + '=' + q + '#' + q;
        if (p === '/logout') return attr + '=' + q + up + 'index.html' + q;
        const t = p.replace(/^\//, '');
        if (/^forum\/thread\/\d+$/.test(t)) return attr + '=' + q + up + t.replace('thread/', 'thread-') + '.html' + q;
        return attr + '=' + q + up + t + '.html' + q;
      });
      fs.mkdirSync(path.dirname(path.join(outDir, outName)), { recursive: true });
      fs.writeFileSync(path.join(outDir, outName), fixed);
    });
}

function serverRow(s) {
  const tags = (s.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
  return `<div class="server-row" onclick="location='servers/${s.id}.html'">
    <div class="server-icon">${(s.name || 'S')[0]}</div>
    <div class="server-info"><div class="name"><span class="live-dot"></span>${s.name}</div>
    <div class="desc">${s.desc || ''}</div></div>
    <div class="server-meta"><div class="players">${s.players}/${s.maxPlayers} players</div>
    <div class="tags">${tags}</div></div></div>`;
}

(async () => {
  await render('index', { user: null, liveCount: live().length, livePlayers: live().reduce((a, s) => a + s.players, 0) }, 'index.html');
  // servers page renders rows client-side from the baked window.__sample (works offline)
  await render('servers', { user: null, sampleServers: live() }, 'servers.html');
  await render('forum', { user: null, cats, posts: samplePosts, usersMap: { 1: { username: 'GTAMP_Team' }, 2: { username: 'ServerHost' }, 3: { username: 'Scripter' }, 4: { username: 'Community' } } }, 'forum.html');
  await render('marketplace', { user: null, assets: sampleAssets, usersMap: { 1: { username: 'GTAMP_Team' }, 2: { username: 'Scripter' }, 3: { username: 'Mapper' } } }, 'marketplace.html');
  await render('docs', { user: null, docs }, 'docs.html');
  await render('support', { user: null }, 'support.html');
  await render('run_server', { user: null, artifacts }, 'run-server.html');
  await render('login', { user: null, error: null }, 'login.html');
  await render('register', { user: null, error: null }, 'register.html');
  const legalStatic = {
    terms: { title: 'GTAMP License Agreement', body: `<p>By downloading or using GTAMP ("the software"), you agree to these terms.</p><p><b>1. License.</b> We grant you a personal, non-exclusive, non-transferable license to install and use GTAMP to play and host community multiplayer servers for Grand Theft Auto V.</p><p><b>2. Requirements.</b> You must own a legitimate PC copy of Grand Theft Auto V. GTAMP does not include, replace, or modify any game files.</p><p><b>3. Online conduct.</b> Server owners set their own rules. Cheating, harassment, and unlawful activity may get you banned from individual servers or the platform.</p><p><b>4. No affiliation.</b> GTAMP is not affiliated with, endorsed by, or connected to Rockstar Games, Take-Two Interactive, or Cfx.re.</p><p><b>5. Warranty.</b> GTAMP is provided "as is", without warranty of any kind. Use it at your own risk.</p>` },
    privacy: { title: 'Privacy Policy', body: `<p>GTAMP collects the minimum data needed to run the platform.</p><p><b>Accounts.</b> If you register, we store your username and a hashed password. We never store plaintext passwords.</p><p><b>Play presence.</b> The GTAMP launcher periodically pings this website so we can show live "players online" counts and your server in the Server List. These reports contain no personal data beyond your server name and player count.</p><p><b>Cookies.</b> We use a single session cookie to keep you signed in. See the <a href="cookies.html">Cookie Policy</a> for details.</p><p><b>Sharing.</b> We do not sell or share your personal information with third parties.</p>` },
    cookies: { title: 'Cookie Policy', body: `<p>GTAMP uses one strictly-necessary cookie:</p><p><b>Session cookie.</b> Keeps you signed in between page loads. It contains an opaque session ID, expires when you log out or after a period of inactivity, and is not used for tracking or advertising.</p><p><b>Cookie settings.</b> Because we only use this essential cookie, there is nothing to opt out of — if you block it, login simply won't persist. You can clear it any time from your browser settings.</p>` }
  };
  for (const [slug, doc] of Object.entries(legalStatic)) await render('legal', { user: null, title: doc.title, body: doc.body }, slug + '.html');
  await render('keymaster', {
    user: { id: 1, username: 'DemoUser' }, licenses: [{ key: 'GTAMP-DEMO-0001', type: 'server' }],
    assets: [{ id: 1, title: 'Realistic Car Pack', price: 12.99, published: true }]
  }, 'keymaster.html');

  const sampleUsers = { 1: { username: 'GTAMP_Team' }, 2: { username: 'ServerHost' }, 3: { username: 'Scripter' }, 4: { username: 'Community' } };
  const replyCounts = {};
  sampleReplies.forEach(r => { replyCounts[r.pid] = (replyCounts[r.pid] || 0) + 1; });

  for (const d of docs) await render('doc', { user: null, doc: d, docs, activeDoc: d }, 'docs/' + d.id + '.html');
  for (const c of cats) await render('forum_cat', { user: null, cat: c, posts: samplePosts.filter(p => p.cat === c.id), usersMap: sampleUsers, replyCounts }, 'forum/' + c.id + '.html');
  for (const p of samplePosts) await render('thread', { user: null, post: p, replies: sampleReplies.filter(r => r.pid === p.id), cat: cats.find(c => c.id === p.cat), usersMap: sampleUsers }, 'forum/thread-' + p.id + '.html');
  for (const s of live()) await render('server', { user: null, srv: s }, 'servers/' + s.id + '.html');
  for (const a of sampleAssets) await render('marketplace_item', { user: null, asset: a, author: { username: 'Author' } }, 'marketplace/' + a.id + '.html');

  const pubDir = path.join(__dirname, '..', 'public');
  fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
  // copy CSS with image URLs re-pointed relative to css/ for file:// use
  let cssOut = fs.readFileSync(path.join(pubDir, 'css', 'style.css'), 'utf8');
  cssOut = cssOut.replace(/url\("\/img\//g, 'url("../img/');
  fs.writeFileSync(path.join(outDir, 'css', 'style.css'), cssOut);
  fs.copyFileSync(path.join(pubDir, 'js', 'main.js'), path.join(outDir, 'js', 'main.js'));
  const imgDir = path.join(pubDir, 'img');
  if (fs.existsSync(imgDir)) {
    fs.mkdirSync(path.join(outDir, 'img'), { recursive: true });
    for (const f of fs.readdirSync(imgDir)) fs.copyFileSync(path.join(imgDir, f), path.join(outDir, 'img', f));
  }
  try {
    const exe = path.join(__dirname, '..', '..', 'GTAMP-Launcher-v1.9.7.exe');
    if (fs.existsSync(exe)) fs.copyFileSync(exe, path.join(outDir, 'GTAMP-Launcher-v1.9.7.exe'));
  } catch (e) {}
  fs.writeFileSync(path.join(outDir, 'sample-servers.json'), JSON.stringify({ servers: live() }));
  fs.writeFileSync(path.join(outDir, 'launcher-version.json'), JSON.stringify({ version: '1.9.7', url: '/download/GTAMP-Launcher-v1.9.7.exe' }));

  console.log('Static site built at ' + outDir);
  console.log('Open ' + path.join(outDir, 'index.html'));
})();
