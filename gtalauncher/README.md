# GTAMP Launcher

A FiveM / alt:V-style GTA V multiplayer launcher with a working UDP multiplayer proof-of-concept. Built with Electron.

![GTAMP](build/icon.png)

## Features

- 🎮 **FiveM-style dark UI** — frameless window, sidebar nav, server browser
- 🌐 **Server browser** with ping, player counts, search/sort, refresh
- ⚡ **Direct Connect** to any host:port
- ⭐ **Bookmarks** for favorite servers
- 📰 **News feed** & **Mods** panel
- ⚙️ **Settings** — GTA V auto-detect (registry + common paths), nickname, graphics, audio, network
- 🚀 **One-click PLAY** that launches GTA V with your configuration
- 🔌 **Bundled master server** (HTTP) that runs alongside the launcher
- 🎯 **Multiplayer PoC** — UDP game server with player join/leave, position sync, and chat
- 📦 **Packagable to Windows .exe** — portable .exe + NSIS installer via electron-builder

## Quick Start (Development)

```bash
# 1. Install dependencies
npm install

# 2. Run in dev mode
npm run dev

# 3. (Optional) Run an extra standalone game server on a different port
node src/server/game-server.js
# -> listens on UDP 22005; register it with the master via POST /register
```

## Packaging to Windows .exe

> **Important**: Build the .exe **on a Windows machine**. Electron downloads Windows binaries and electron-builder needs Windows to sign/package correctly. You *can* cross-compile from Linux/macOS with Wine but it's flaky — Windows is recommended.

```bash
# Produces a single-file portable .exe (no install needed) in dist/
npm run dist

# Produces an NSIS installer (Setup wizard) in dist/
npm run dist:installer
```

Artifacts will be in the `dist/` folder:
- `GTAMP Launcher-Portable-1.0.0.exe` — single file, runs anywhere
- `GTAMP Launcher-Setup-1.0.0.exe` — installs to Program Files, creates shortcuts

### If you don't have Windows right now
You can run the launcher on Linux/macOS for UI testing — game launch just won't find `GTA5.exe`. The master server + game server + client bridge all work cross-platform for testing.

## Architecture

```
gtalauncher/
├── src/
│   ├── main/            # Electron main process (window, IPC, game launch, master server)
│   │   └── main.js
│   ├── preload/         # Secure IPC bridge (contextIsolation)
│   │   └── preload.js
│   ├── renderer/        # UI (HTML/CSS/JS) - Chromium, FiveM-style dark theme
│   │   ├── index.html
│   │   ├── css/style.css
│   │   └── js/app.js
│   ├── server/          # Game server + master server (Node.js, UDP + HTTP)
│   │   └── game-server.js
│   └── client/          # Client bridge - runs alongside GTA, talks UDP to server
│       └── client-bridge.js
├── build/               # Icons, build resources
├── docs/ROADMAP.md      # How to extend this into a full multiplayer mod
└── package.json
```

### How launching works
1. User clicks PLAY → main process validates GTA V path
2. Client bridge (`client-bridge.js`) is spawned as a child process
   - Connects UDP to the selected game server with a `join` packet
   - Listens on TCP `127.0.0.1:22100` for a native DLL to feed position data
   - Exposes a WebSocket on `22101` for debug overlays
3. `GTA5.exe` is launched with optional `-windowed` flag
4. *(In production)* An injected C++ DLL connects to the bridge over TCP to send/receive entity state

### Multiplayer Protocol (PoC)
JSON lines over UDP. See `src/server/game-server.js` for full spec.

**Client → Server:**
```json
{"t":"join", "nick":"PlayerName"}
{"t":"pos", "x":120.4, "y":-500.2, "z":20.5, "h":90.0}
{"t":"chat", "msg":"hello"}
{"t":"ping", "ts":123456}
{"t":"quit"}
```

**Server → Client:**
```json
{"t":"welcome", "id":"a1b2c3d4", "server":{...}, "players":[...]}
{"t":"players", "list":[...]}     // full state snapshot (1 Hz)
{"t":"join", "id":"...", "nick":"..."}
{"t":"leave", "id":"..."}
{"t":"pos", "id":"...", "x":.., "y":.., "z":.., "h":..}
{"t":"chat", "id":"...", "nick":"...", "msg":"..."}
{"t":"pong", "ts":.., "server":..}
{"t":"kick", "reason":"..."}
```

## Testing multiplayer without GTA V

You can run the whole multiplayer stack right now without the game:

```bash
# Terminal 1: Start launcher (master server auto-starts on 22003, bundled game server on 22005)
npm start

# Terminal 2: Start a second client bridge simulating another player
GTAMP_SERVER=127.0.0.1:22005 GTAMP_NICK=TestPlayer GTAMP_NOMOVE=1 node src/client/client-bridge.js
# Type messages in the terminal, they'll be visible server-side

# Terminal 3: Start a third...
GTAMP_SERVER=127.0.0.1:22005 GTAMP_NICK=Driver node src/client/client-bridge.js
```

## Going further

This is a launcher + networking foundation. To become a real FiveM/alt:V competitor you need a native client DLL that hooks GTA V — that's the hard multi-year part. See **[docs/ROADMAP.md](docs/ROADMAP.md)** for a detailed breakdown (DLL injection, DirectX hooks, native invocation, asset streaming, anti-cheat, scripting runtime, etc.).

## Controls in the launcher

- **Sidebar**: Servers, Direct Connect, Bookmarks, News, Mods, Settings, About
- **Bottom bar**: Shows selected server, your nickname, big red PLAY button
- **Right-click** a server → Connect / Bookmark / Copy Address
- **Settings**: point the launcher at your GTA V folder, set nickname, graphics, etc.

## License

MIT — do whatever you want with it. Not affiliated with Rockstar Games, Take-Two Interactive, FiveM (Cfx.re), or alt:V.
