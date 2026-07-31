const store = require('./store');

function defaultBadges() {
  return [
    { id: 'b_verified',  name: 'Verified',  desc: 'Official GTAMP team / confirmed identity', icon: '✔', color: '#3ddc84', role: 'staff' },
    { id: 'b_staff',     name: 'Staff',     desc: 'Member of the GTAMP team', icon: '🛠', color: '#8b6cff', role: 'staff' },
    { id: 'b_admin',     name: 'Administrator', desc: 'GTAMP administrator', icon: '⚙', color: '#e05050', role: 'staff' },
    { id: 'b_dev',       name: 'Developer', desc: 'Contributed code to GTAMP', icon: '⌨', color: '#6ac6ff', role: 'achievement' },
    { id: 'b_founder',   name: 'Founder',   desc: 'Founded / owns GTAMP', icon: '★', color: '#ffb83d', role: 'staff' },
    { id: 'b_host_1',    name: 'Server Host', desc: 'Hosted a public server for 7 days', icon: '🖥', color: '#30a060', role: 'achievement' },
    { id: 'b_host_2',    name: 'Dedicated Host', desc: 'Hosted a public server for 30 days', icon: '🖥', color: '#30c080', role: 'achievement' },
    { id: 'b_author_1',  name: 'Author',    desc: 'Published 1 marketplace asset', icon: '📦', color: '#a050e0', role: 'achievement' },
    { id: 'b_author_5',  name: 'Prolific Author', desc: 'Published 5 marketplace assets', icon: '📦', color: '#c070ff', role: 'achievement' },
    { id: 'b_patron',    name: 'Patron',    desc: 'Boosted a server via upvotes', icon: '💜', color: '#e05aa0', role: 'patron' },
    { id: 'b_early',     name: 'Early Adopter', desc: 'Joined GTAMP during early access', icon: '🚀', color: '#6ac6ff', role: 'achievement' },
    { id: 'b_contributor', name: 'Community Contributor', desc: 'Helped others on the forum', icon: '💬', color: '#8ab0ff', role: 'achievement' }
  ];
}

function defaultForumCategories() {
  return [
    { id: 'announcements', name: 'Announcements', desc: 'GTAMP news and updates', role: 'announce' },
    { id: 'general',       name: 'General Discussion', desc: 'Talk about GTAMP and multiplayer' },
    { id: 'gtamp-discussion', name: 'GTAMP Discussion', desc: 'Discussion about GTAMP itself' },
    { id: 'client-support',  name: 'GTAMP Client Support', desc: 'Help with the launcher and client' },
    { id: 'server-support',  name: 'Server Support', desc: 'Help running your own server' },
    { id: 'scripting',       name: 'Scripting', desc: 'Lua/JS scripting help' },
    { id: 'showcases',       name: 'Showcases', desc: 'Show off your servers and assets' },
    { id: 'marketplace-talk', name: 'Marketplace', desc: 'Buy, sell, and discuss assets' }
  ];
}

function defaultSettings() {
  return {
    siteName: 'GTAMP',
    tagline: 'FiveM-style GTA V multiplayer',
    version: '1.6.0',
    downloadUrl: '/download/GTAMP-Launcher-v1.6.0.exe',
    activeLauncherCount: 0,
    liveServers: [],
    upvoteBasePriceUsd: 0.50
  };
}

function defaultDocs() {
  return [
    { id: 'getstarted', cat: 'Getting Started', title: 'Getting Started', body: 'Install, launch, and connect to your first server.' },
    { id: 'install', cat: 'Getting Started', title: 'How to Install GTAMP', body: 'Download the launcher, install ScriptHookV, and run.' },
    { id: 'runserver', cat: 'Running a Server', title: 'Run Your Own Server', body: 'Create a server and install the FXServer artifacts.' },
    { id: 'artifacts', cat: 'Running a Server', title: 'Installing Artifacts', body: 'Download and set up the server artifacts.' },
    { id: 'resources', cat: 'Running a Server', title: 'Adding Resources', body: 'Add resources to your server.' },
    { id: 'scripting', cat: 'Scripting', title: 'Scripting Basics', body: 'Write your first Lua/JS script.' },
    { id: 'keymaster', cat: 'Keymaster', title: 'Using the Keymaster', body: 'Manage your server license keys.' },
    { id: 'faq', cat: 'Support', title: 'FAQ', body: 'Common questions answered.' }
  ];
}

function defaultArtifacts() {
  return [
    { version: '1.6.0', platform: 'Windows', url: '/artifacts/gtamp-server-windows.zip', note: 'Recommended' },
    { version: '1.6.0', platform: 'Linux', url: '/artifacts/gtamp-server-linux.tar.gz', note: '' }
  ];
}

function seed() {
  store.ensure('badges', defaultBadges());
  store.ensure('forum_categories', defaultForumCategories());
  store.ensure('settings', defaultSettings());
  store.ensure('docs', defaultDocs());
  store.ensure('artifacts', defaultArtifacts());
  store.ensure('users', []);
  store.ensure('servers', []);
  store.ensure('upvotes', []);
  store.ensure('forum_posts', []);
  store.ensure('forum_replies', []);
  store.ensure('assets', []);
  store.ensure('licenses', []);
  store.ensure('user_badges', []);
}

module.exports = { seed };
