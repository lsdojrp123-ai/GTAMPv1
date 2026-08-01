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
  { id: 1, cat: 'announcements', title: 'GTAMP v1.6.0 released', body: 'FiveM-style launcher, live servers, and the website are live.', uid: 1, at: Date.now() },
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
        if (p.startsWith('/css/') || p.startsWith('/js/')) return attr + '=' + q + up + p.slice(1) + q;
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
  await render('servers', { user: null }, 'servers.html');
  {
    const sp = path.join(outDir, 'servers.html');
    let shtml = fs.readFileSync(sp, 'utf8');
    const rows = live().map(serverRow).join('');
    shtml = shtml.replace('<div id="server-list"><div class="muted">Loading servers...</div></div>',
                          '<div id="server-list">' + rows + '</div>');
    fs.writeFileSync(sp, shtml);
  }
  await render('forum', { user: null, cats, posts: samplePosts }, 'forum.html');
  await render('marketplace', { user: null, assets: sampleAssets }, 'marketplace.html');
  await render('docs', { user: null, docs }, 'docs.html');
  await render('support', { user: null }, 'support.html');
  await render('run_server', { user: null, artifacts }, 'run-server.html');
  await render('login', { user: null, error: null }, 'login.html');
  await render('register', { user: null, error: null }, 'register.html');
  await render('keymaster', {
    user: { id: 1, username: 'DemoUser' }, licenses: [{ key: 'GTAMP-DEMO-0001', type: 'server' }],
    assets: [{ id: 1, title: 'Realistic Car Pack', price: 12.99, published: true }]
  }, 'keymaster.html');

  for (const d of docs) await render('doc', { user: null, doc: d }, 'docs/' + d.id + '.html');
  for (const c of cats) await render('forum_cat', { user: null, cat: c, posts: samplePosts.filter(p => p.cat === c.id) }, 'forum/' + c.id + '.html');
  for (const p of samplePosts) await render('thread', { user: null, post: p, replies: sampleReplies.filter(r => r.pid === p.id) }, 'forum/thread-' + p.id + '.html');
  for (const s of live()) await render('server', { user: null, srv: s }, 'servers/' + s.id + '.html');
  for (const a of sampleAssets) await render('marketplace_item', { user: null, asset: a, author: { username: 'Author' } }, 'marketplace/' + a.id + '.html');

  const pubDir = path.join(__dirname, '..', 'public');
  fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
  fs.copyFileSync(path.join(pubDir, 'css', 'style.css'), path.join(outDir, 'css', 'style.css'));
  fs.copyFileSync(path.join(pubDir, 'js', 'main.js'), path.join(outDir, 'js', 'main.js'));
  try {
    const exe = path.join(__dirname, '..', '..', 'GTAMP-Launcher-v1.6.0.exe');
    if (fs.existsSync(exe)) fs.copyFileSync(exe, path.join(outDir, 'GTAMP-Launcher-v1.6.0.exe'));
  } catch (e) {}
  fs.writeFileSync(path.join(outDir, 'sample-servers.json'), JSON.stringify({ servers: live() }));

  console.log('Static site built at ' + outDir);
  console.log('Open ' + path.join(outDir, 'index.html'));
})();
