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
| FiveM installer (setup → %LocalAppData%, shortcut, in-place silent updates) | **v2.1.0: GTAMP-Setup.exe** — one-click per-user installer, Desktop/Start shortcuts, `preInit` kills stuck old builds during setup, installed builds self-update via silent re-setup (`/S --force-run`), portable builds via exe swap |
| Game discovery (FiveM maps GTA into its own address space; stock fallback relies on process + window) | **v2.1.0: dual-channel detection** — Toolhelp32 process-name scan **plus** "Grand Theft Auto V" window-title adoption (`EnumWindows`), in both `--probe` and the wait loop; adopted window satisfies the D3D gate immediately |
| Updater (`Bootstrap_DoBootstrap`, GameCache verify) | **v1.9.6: real self-update** — startup step 2 pulls the latest release tag from GitHub Releases, downloads the new exe with a live progress bar, sanity-checks it, spawns it, and exits — the update lands *before the game ever loads*, exactly like `Bootstrap_DoBootstrap` patching before `XBR_EarlySelect`. Website `/api/launcher/version` remains as fallback + the connect-flow "update available" hint |
| ROS entitlement (`ros:legit` → entitlement block) | `CONNECTING TO ROCKSTAR GAMES SERVICES` — platform (Steam/Epic/RGL) must sign in first, ownership verify (exe + `update.rpf` > 200MB + platform DLLs) |
| **Game starts inside FiveM's own process** (they map GTA5.exe themselves) | We launch stock GTA5 through its platform, then inject **only after the game window exists** (== D3D init succeeded) + settle grace — the practical equivalent of their contract and the direct ERR_GFX_D3D_INIT fix |
| Crash/diag culture (`CfxCrashDump`, in-UI fatal cards with cause text) | **v1.9.9–2.0.0: observable failure** — injector heartbeats stream onto the connect card live via TWO channels (stdout + fs-tailed `%TEMP%` log, deduped); every line is ring-buffered and auto-copied to the clipboard on failure; blocked injector (av/SmartScreen → 30 s silence hard-card), elevated game (access-denied → one-click admin relaunch), and real inject failures each get their own exact card in seconds; v2.0.0 adds the on-card `INJECT NOW` user override (straight into a running game, generation-safe) |
| Native process management — FiveM never shells out to find/track the game (`OpenProcess`, snapshot walks, `WaitForInputIdle`-style polling in their launcher) | **v1.9.8: injector owns the whole chain.** All "is GTA up?" / "wait for GTA" logic moved out of JS `tasklist` polling into the native injector: `CreateToolhelp32Snapshot` process walk with its own `--pid-timeout` budget, zero-injection `--probe` mode for instant checks, `EnumWindows` window wait, settle, inject — one native process, no shell spawns, immune to commit-pressure spawn failures. `GTA5.exe` (Legacy) ⇄ `GTA5_Enhanced.exe` cross-match |
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

## 5. Native invocation (`code/components/rage-scripting-five`) — v2.2.0

FiveM resolves every script native **itself**; ScriptHookV, by contrast, ships a native
database that dies with `FATAL: Can't find native 0x…` whenever it doesn't match the game
build. GTAMP v2.2.0 ports the *behavior* of FiveM's native resolution into
`src/native/hook/own_invoker.h` (our own code, documented here):

| FiveM component | GTAMP v2.2.0 |
|---|---|
| `scrEngine.cpp` — locate the 256-bucket native registration table via pattern `76 32 48 8B 53 40`, RIP-relative reference at match+9 (`target = +9 + disp32 + 4`) | Identical pattern + identical scalar math, plus belt-and-braces validation: single-shot scan of the whole game image, structural proof of the table (256 buckets, readable chains, counts 1–7, >1000 natives), executable-check on every resolved handler — any surprise leaves the path disabled |
| `NativeRegistration_obf` — R* XOR-folds next-pointer / entry-count / per-entry hash through the address where each field lives | Same de-obfuscation (fold key = low32(field address) ^ low32(second key word), applied dword-wise to the stored qwords) |
| `TableBuilder.cpp` + `CrossMapping_Universal.h` — R* re-keys native hashes between builds; FiveM keeps a 28-slot chain per native indexed by build (slot 27 = b2944+, i.e. every current Legacy/Enhanced build) | `native_remap.h` (auto-generated, 48 rows) — for every native GTAMP uses we carry slots 24–27 straight from FiveM's published chain data. Resolution tries the **live table itself**, newest keying first, so no build detection is needed and a future re-key just falls through to the direct hash |
| `scrThread.h` — `rage::scrNativeCallContext` layout (return/args buffers, 8-byte slots, vector staging space, `SetVectorResults` copy-out) | Byte-identical context layout; one shared 256-byte temp buffer for args+return (FiveM's own note: the game handles the aliasing); vector results land 1 float per 8-byte slot exactly like the ScriptHookV `ret3f` pattern our fiber already used |
| `scrEngine::GetNativeHandler` + fast-path cache | Per-hash cache (128 entries) + miss logging to `%TEMP%\gtamp_hook.log` |

**Fallback contract (unchanged):** ScriptHookV remains the fiber scheduler. If the own
scan ever fails (pattern gone on an exotic build), the hook permanently falls back to the
SHV export path — exactly the v2.1.1 behavior, watchdog and update-SHV card included.
New bridge telemetry: `nativeScan` (own engine active, N natives) / `noShv` (SHV.dll
absent after 60 s → install card) / `fiberFail` (fiber froze with own engine active →
real-stall card). This kills the entire error class the user hit at v2.1.1 — a stale or
forked ScriptHookV database can no longer stop the multiplayer engine.
