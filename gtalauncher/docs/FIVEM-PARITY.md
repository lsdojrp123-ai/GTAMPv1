# FIVEM-PARITY — how GTAMP mirrors citizenfx/fivem, subsystem by subsystem

Study basis: `github.com/citizenfx/fivem` (master, July 2026). This file maps every
FiveM subsystem we studied to what GTAMP does with **our own code** (same behavior,
same stage ordering — never ripped FiveM assets or verbatim code).

## 1. Bootstrap / launcher (`code/client/launcher/Main.cpp`, `Bootstrap.cpp`)

| FiveM stage | GTAMP v1.9.0 |
|---|---|
| `EarlyLdrBlock_Init()` — block problematic DLLs before D3D/UI init | Hook DllMain pins **system** `d3d11.dll/dxgi.dll/d3d9/…` first ("*must* load a d3d11.dll before anything else") so no search-path variant can take precedence |
| `Prevent NVIDIA game filters` (citicore) | `PREPARING GAME ENVIRONMENT` step; hook loads nothing until game window exists |
| `DoPreLaunchTasks()` | Connect-flow steps 3–4: settings.xml repaired (DX 11, HDR off), stale GTA procs killed, ShadowPlay queried, component update check |
| `NVSP_DisableOnStartup()` + `enable_nvsp` cookie (DisableNVSP.cpp) | `queryNvNode()` → NvNode local HTTP API (`X_LOCAL_SECURITY_COOKIE`) → disable ShadowPlay for the session, restore on quit (`nvspDisabledByUs`) |
| Updater (`Bootstrap_DoBootstrap`, GameCache verify) | `UPDATING COMPONENTS` step → `GET /api/launcher/version` on our website |
| ROS entitlement (`ros:legit` → entitlement block) | `CONNECTING TO ROCKSTAR GAMES SERVICES` — platform (Steam/Epic/RGL) must sign in first, ownership verify (exe + `update.rpf` > 200MB + platform DLLs) |
| **Game starts inside FiveM's own process** (they map GTA5.exe themselves) | We launch stock GTA5 through its platform, then inject **only after the game window exists** (== D3D init succeeded) + settle grace — the practical equivalent of their contract and the direct ERR_GFX_D3D_INIT fix |
| Master/process + `initialGamePid` tracking | GTA-exit watcher returns to launcher UI, tray keeps app alive |

## 2. Game surface / in-game UX

| FiveM | GTAMP |
|---|---|
| In-engine loading card with stage text while connecting | `joinBegin/joinStage/joinFail/joinEnd` → GDI overlay card over GTA with stage, elapsed, animated segments |
| F8 dev console (conhost) usable anytime | F8 console thread works **before ScriptHookV loads**, full cmd set: `help clear connect <ip:port> disconnect quit status players version credit` |
| T chat, server/JOIN/LEAVE colors, 12s auto-fade | T chat in fiber + console-mirrored scrollback |
| Player nametags `[id] name` + health % | Nametags with GTA 100–200 health semantics (hurt tints), distance-scaled, 40m range |
| Loading screens eliminated once client controls the session | `SHUTDOWN_LOADING_SCREEN` kill-window for 15s after SHV ready — straight into gameplay |
| Disconnect → back to client UI | `disconnectSession()` → clears clones, console line, launcher window/tray |

## 3. Netcode model (`code/components/citizen-server-impl`, `gta:net:five`)

| FiveM | GTAMP |
|---|---|
| OneSync scope: entities stream in/out by distance | 300m stream-in / 320m stream-out culling in hook |
| Client position @ tick, server rebroadcasts (source of truth per-entity owner) | 100ms pos + health/armour JSON → launcher UDP → fxserver `playerPos` relay |
| Owner-authoritative damage: victim applies, shooter reports | `HAS_ENTITY_BEEN_DAMAGED_BY_ENTITY(clone, localPed)` per frame → delta → `{t:'hit'}` → fxserver routes `{t:'damage'}` to victim → victim applies **armour-first then health** (GTA semantics), chat feedback both sides; owner HP mirrors onto clone every frame; owner-death kills clone; dead-clone/live-owner respawns |
| Entity state bags (`state.set/get`) | fxserver `player.ped.state` with the same get/set semantics |
| Join handshake: server info → resource acknowledge → spawn | `join → welcome → resourceAck → spawnComplete` with netId assignment, player list, chat |

## 4. Server browser / website

| FiveM | GTAMP |
|---|---|
| fivem.net landing (hero, download, FAQ, legal) | GTAMP homepage rebuilt to the same measurements (original art/copy) |
| Server list with live "playing now" counts | `/api/servers/live`, Direct Connect by ip:port |
| Match server protocol to client version | `/api/launcher/version` (above) |
