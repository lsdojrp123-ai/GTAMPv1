# GTAMP Roadmap

> **North star:** FiveM-inspired multiplayer, **our own code**.  
> See [ARCHITECTURE.md](./ARCHITECTURE.md) for topology, design rules, and the build ladder.  
> We will sit on this for days/weeks — scaffolds (TestBot, frozen peds) are steps, not the destination.

---

# 📍 WHERE WE ARE — v1.7.0 (verified against the code)

## v1.7.0 — FiveM-style loading UX (this release)

| Feature | Status | Evidence |
|---------|--------|----------|
| Startup splash screen (FiveM-style "Starting GTAMP…" window) — appears instantly, drives a 7-step startup checklist | ✅ Done | `src/renderer/loading.html` (mode=startup), `src/main/main.js runStartup()` |
| GTA V ownership verification — exe + `update\update.rpf` (≥200 MB) + platform DRM signature (Steam/Epic/Rockstar) checked *before* the launcher opens; failure keeps you in the splash with Choose-folder/Retry/Quit | ✅ Done | `main.js verifyGtaOwnership()` + startup step 3–4 |
| "CONNECTING TO ROCKSTAR GAMES SERVICES" stage (platform hand-off messaging like the FiveM splash) | ✅ Done | startup step 5 |
| Server-join loading window — real event-driven steps: ownership → platform → launch GTA → wait GTA5.exe → inject → hook hello → server welcome → spawn; countdowns, retry, retry-inject, cancel | ✅ Done | `main.js runConnectFlow()` + `loading.html` (mode=connect) |
| GTAMP runs in the background while GTA plays — launcher hides to tray, restores itself when GTA5.exe exits | ✅ Done | `ensureTray()` + `startGtaExitWatch()` + `game:closed` renderer event |
| F8 console available *during* server loading (hook thread is independent) + **T opens chat** (like FiveM) | ✅ Done | `dllmain.cpp` T-key edge-trigger, `HOOK_VER "1.7.0"` |
| Tray icon + window icon (previously missing `build/icon.png`) | ✅ Done | `build/icon.png` (generated original GTAMP hexagon) |

| Phase | Feature | Status | Evidence |
|-------|---------|--------|----------|
| 1 | Native hook (injector + DLL inside GTA5.exe, ScriptHookV natives) | ✅ Done | `src/native/hook/dllmain.cpp`, `gtamp_injector.exe` |
| 2 | UDP relay + client bridge (hook ↔ launcher ↔ FXServer) | ✅ Done | `src/main/main.js` (TCP 22100 + UDP), `src/fxserver/` |
| 3 | Read local pos / spawn & move peds in-game | ✅ Done | hook `pos` stream, `spawnPed` natives |
| 4 | Server: join/kick/snapshot protocol | ✅ Done | `fxserver/index.js` player manager |
| 5 | Remote player sync (spawn/update/despawn, TestBot solo fill) | ✅ Done | `netPed*` pipeline, solo TestBot |
| 6 | **Remote player lifecycle, FiveM-style** — auto-create clone peds on join, despawn on leave/timeout, nametags `[id] name + HP%`, map blips, smooth lerp, ~320 m culling | ✅ Done | `dllmain.cpp` `drawNametags`, `addPlayerBlip`, `netPedClear`, `HOOK_VER "1.6.0"` |
| 7 | **F8 chat sync** — F8 opens input, type, Enter sends; server relays to all clients; colored HUD lines + join/leave notices | ✅ Done | hook `submitChat`→`main.js`→`fxserver _handleChat`→broadcast→`pushChatLine`/`drawChatUI` |

**Phases 1–7 are complete in the code.** If F8 chat didn't work on your machine, the almost-certain cause was the old **v1.5.2 hook** loading from a stale installed copy — fresh install of the current launcher fixes it.

### v1.8.0 — FiveM-style join UX (current packaged release)
- **Startup splash** pops instantly (`loading.html`): locating GTA V → verifying ownership → Rockstar services → launcher ready.
- **Ownership verification** before anything runs (`verifyGtaOwnership`): `GTA5.exe`/`PlayGTAV.exe`/`GTA5_Enhanced.exe`, `update\update.rpf` >200 MB, Steam/Epic/Rockstar platform detection.
- **Connect flow** (`runConnectFlow`): 8-step loading window — ownership → platform → start GTA → wait for GTA5.exe → inject → hook link → handshake → spawn — with retry/cancel at every failure.
- **In-game connect panel**: once the hook lands, a FiveM-style centered card drawn over the game ("GTAMP / CONNECTING / server / stage + spinner") until you spawn (`joinBegin`/`joinStage`/`joinEnd`/`joinFail` over the hook bridge).
- **F8 console** works even before ScriptHookV loads (GDI overlay): `help`, `connect <ip:port>`, `disconnect`, `quit`, `version`.
- **T chat** in-game (FiveM keybinding); F9 toggles the debug HUD.
- **Tray/background**: GTAMP keeps running in the tray while you play; quitting GTA returns you to the launcher; `disconnectSession` cleans the session from console/launcher.

## v1.9.7 — stale-instance takeover: "file says 1.9.6, screen says 1.9.0" fixed forever
- Root cause of the final stuck-screen reports: the **old frozen v1.9.0 window was still running** and held the Electron single-instance lock. Launching the new v1.9.6 exe made the *new* process exit silently and refocus the zombie old window (`second-instance` → focus first instance) — so every fresh download appeared to "say 1.9.0 and get stuck on the same screen."
- v1.9.7 flips the handoff to FiveM `-switchcl` semantics (the **new** client wins): when the single-instance lock is already held, the launcher now `taskkill`s every other `GTAMP-Launcher-*.exe` except its own pid (plus orphan `gtamp_injector.exe`), waits for the mutex to release, and retakes the lock. A genuinely-unkillable lock still exits quietly, but a zombie can no longer outvote a fresh download.
- `second-instance` now also raises the loading/splash window, not just the main one.

## v1.9.6 — self-updating launcher (FiveM Bootstrap parity) + stall-proof window wait
**The auto-update era starts here: from v1.9.6 onward the launcher patches itself — one manual download, never again.**
- **FiveM-style self-update at startup.** FiveM's `Bootstrap.cpp` updates the client *before* the game ever loads; GTAMP now does the same: startup step 2 checks GitHub Releases (canonical, always-latest — independent of any website you have running) for a newer tag, downloads the new exe in-app with a live progress bar (`UPDATING GTAMP — N%`), sanity-checks it (size + MZ header), spawns it, and exits itself. Community website `/api/launcher/version` is the fallback source. Skipped automatically in dev/unpackaged runs; every step goes to `%TEMP%\gtamp_launcher_diag.log`. Failure never blocks startup — it continues into the current version.
- **Stall-proof connect flow.** The "waiting for game window" gate can no longer wedge: reused instances already skip it (v1.9.5); fresh launches now cap the window wait at **120 s** (`GTAMP_WINDOW_MS` to override) after which the injector blind-injects — a game that survived 2 minutes is provably past D3D init, so the wait is ceremonial anyway.
- **Untitled-window acceptance.** The injecter's `EnumWindows` scan now also accepts visible *untitled* top-level windows after the first 30 s (some fullscreen / driver-composed paths give the game window no `WM_GETTEXT` title), instead of demanding a titled window forever.

## v1.9.5 — hotfix: reused games skip the window gate entirely; window-wait is now best-effort
- Root observation: screenshots of the "stuck on WAITING FOR GAME WINDOW" card were all from **pre-1.9.3 builds** (the exact status text only existed in the deleted PowerShell poller; card footer read v1.9.0) — the fix shipped in 1.9.3 but users on old exes never got it. Step-4 update note now renders a loud "UPDATE vX available — get it from the website Downloads page (old builds do not inject correctly)" instead of a quiet side note.
- **`--already-running` (injector + `--wait-window` interplay):** when the launcher reuses an already-running GTA V (FiveM `-switchcl`-parity path), the window gate is skipped entirely — a game you are literally playing is long past D3D init; settle is clamped to ~2 s and injection proceeds immediately. This covers the exact "game is open and I'm playing, card still waiting for the window" scenario even if `EnumWindows` title matching ever fails for that machine.
- **Window wait is now non-fatal:** on `stage:window-timeout` the injector degrades to a **blind inject** (settle ≥ 3 s, then `CreateRemoteThread`) instead of bailing with exit 2 — because a game that survived the whole window-wait is past graphics init anyway. The launcher maps that stage to "window not detected — game is running, injecting anyway" and continues the flow.
- **Diagnostics always on:** the launcher now always passes `GTAMP_LOG=%TEMP%\gtamp_injector.log` to the injector, which logs its bootstrap line and — while waiting — **every window title it sees owned by the GTA process** (`[vis=… len=…]"title"` candidates every 10 s). Screenshot + this log will identify any future window-matching miss instantly.
- **Loading screen shows liveness:** renderer-side 1 Hz `elapsed … — this step …` clock + the raw last status line. A frozen clock in a screenshot now proves a UI freeze vs. a backend stall.

## v1.9.4 — hotfix: injection outcome can never stall behind stdout parsing
- Injection success/failure is now signaled **three** independent ways — `stage:injected` stdout, the injector's **exit code** (exit 0 ⇒ injected), and the in-game **`hookHello`** over the TCP bridge. Any one of them breaks the wait loop; a generic `error:` branch records the injector's failure code. Fixes a self-inflicted dangling `else-if` in the stage handler that could drop lines.

## v1.9.3 — hotfix: WerFault 0xc000012d (commit-limit pressure from PowerShell polling)
- The "waiting for game window" stage spawned a fresh **PowerShell every 2 seconds** for up to 4 minutes (~120 processes, ~90–150 MB commit each) — on a system already loading GTA V (+ENB + browser tabs) that's exactly the pressure that makes even `WerFault.exe` fail with `STATUS_COMMITMENT_LIMIT (0xc000012d)`. v1.9.3 moves the entire window-wait → settle-grace → inject sequence **into the native injector** itself: it polls `EnumWindows`/`GetExitCodeProcess` in-process every 500 ms (a few MB total, zero extra processes) and streams `stage:`/`error:` lines on stdout (`--wait-window --settle-ms`), which the launcher parses to drive steps 7–9. Process-death-while-waiting (`error:process-exited`) and window-timeout face the same UI cards as before.
- Window-timeout fail card now also calls out detected ENB/ReShade installs (custom `d3d11.dll` in the game folder = a top ERR_GFX_D3D_INIT cause; seen on the user's own screenshot).

## v1.9.2 — hotfix: startup hang + in-game "Unrecoverable fault"
- **"Starting multiplayer services" hang**: FXServer UDP bind could await forever (ports held by a duplicate/zombie GTAMP instance). Now: bind error resolves degraded, splash has a hard 12s race, and the app enforces a **single-instance lock** (FiveM runs exactly one client process) — a second GTAMP just focuses the first.
- **In-game "Unrecoverable fault"**: two v1.9.0 code paths could fault RAGE — (1) `SHUTDOWN_LOADING_SCREEN` called every 250ms through a story-mode load, now once/sec ×10 max; (2) D3D/DXGI pinning loaded DLLs **inside DllMain's loader lock** — moved to the SHV worker thread, exactly the constraint FiveM's `Main.cpp` preloads respect.

## v1.9.1 — hotfix: never force-kill GTA/Rockstar processes
- v1.9.0's prep step `taskkill /F`'d GTA5.exe + the Rockstar launcher → Rockstar reported "Grand Theft Auto V Legacy exited unexpectedly" on the next launch. FiveM never force-kills the game; its `-switchcl` flow **reuses** a running instance. We now do the same: Connect with GTA already running switches into the GTAMP session without relaunch, force-kill is behind an explicit `GTAMP_FORCE_KILL=1` escape hatch, and the window-wait fails fast ("GTA V exited unexpectedly" card with OK/Retry guidance) if the game dies mid-boot instead of sitting 4 minutes silent.

## v1.9.0 — FiveM parity pass (study: citizenfx/fivem source) — current packaged release
- **ERR_GFX_D3D_INIT fix** — root cause was injecting into GTA5.exe while D3D was still initializing. FiveM's launcher never touches the game until its own D3D is up; we now mirror that contract: connect flow waits for the **game window** (== gfx init done) + a settle grace before injecting. DllMain pins system d3d11/dxgi DLLs first (their `Main.cpp` "must load a d3d11.dll before anything else"). Loading screen kill via `SHUTDOWN_LOADING_SCREEN` → straight into gameplay like FiveM.
- **FiveM-ordered 13-step connect flow** — runtime init → ownership → game files → environment prep (settings.xml forced to DirectX 11 + HDR off, stale GTA procs killed) → updating components (`/api/launcher/version`) → Rockstar services → launch → window wait → settle → inject → link → server handshake → session.
- **ShadowPlay parity** — NvNode local API (port+secret from `nodejs.json`, `X_LOCAL_SECURITY_COOKIE` header, GET/POST `ShadowPlay/v.1.0/Launch`) disables ShadowPlay for the session and restores it on quit, exactly like `DisableNVSP.cpp`.
- **Phase 8 shipped** — health/armour now sync in the pos packet (real natives, not hardcoded 200); damage routing: shooter reports `hit` → server forwards `damage` to victim → victim applies armour-first then health; owner HP mirrors onto every clone each frame; owner death kills the clone; dead clone + live owner respawns; nametag HP% fixed for GTA's 100–200 range; chat feedback both sides ("You hit X (-25)" / "X hit you (-25)").
- **Console upgrades** (FiveM conhost-style): `status`, `players` added.
- **Website**: `/api/launcher/version` endpoint + `launcher-version.json` in the static build.
- See [FIVEM-PARITY.md](./FIVEM-PARITY.md) for the full subsystem map.

## ▶ NEXT — Phase 9: Vehicle sync (Medium risk)
`vehEnter/vehExit/vehCreate/vehDelete` stubs exist at fxserver; `inVeh` field already relayed in playerPos.

## Then
| Phase | Feature | Risk |
|-------|---------|------|
| 9 | Vehicle sync (enter/exit, driver, position) | Medium (seat natives are finicky) |
| 10 | Weapon/shot sync | Medium |
| 11 | Animation/aim sync + smooth interpolation | Medium |
| 12 | In-process DX11 overlay (replace F9 overlay with real IMGUI) | Medium (MinHook detour work) |
| 13–16 | Custom asset streaming, scripting API, prediction, anti-cheat | High — FiveM's moat |

---

# GTAMP

## v1.6.0 file locations (no separate UPDATE pack)

Built native files live here (what the launcher loads when packaged / in dev):

| File | Path |
|------|------|
| Hook DLL | `gtalauncher/dist-bin/gtamp_hook.dll` |
| Injector | `gtalauncher/dist-bin/gtamp_injector.exe` |
| Same copies for client tree | `gtalauncher/src/client/native/` |
| Hook source | `gtalauncher/src/native/hook/dllmain.cpp` |
| Injector source | `gtalauncher/src/native/injector/main.cpp` |
| Client bridge | `gtalauncher/src/client/client-bridge.js` |
| Game server | `gtalauncher/src/fxserver/` |
| Launcher main | `gtalauncher/src/main/main.js` |

Packaged app maps `dist-bin/` → `resources/native/` via electron-builder `extraResources`.

---

# GTAMP Roadmap: From Launcher to Full Multiplayer

This launcher is a solid foundation. FiveM and alt:V took teams years to build. Here's what's next.

## Current state (v1.0 - what you have)
- ✅ Polished Electron launcher (FiveM-style UI)
- ✅ Server browser with master server (HTTP)
- ✅ Direct connect
- ✅ Bookmarks
- ✅ Settings with GTA V auto-detect (Steam/Epic/Retail registry + paths)
- ✅ Game launch (GTA5.exe with args)
- ✅ UDP game server (Node.js) with join/chat/position sync
- ✅ Client bridge (talks UDP, accepts TCP hook from a future DLL)
- ✅ Packagable to Windows .exe (portable + NSIS installer) via electron-builder

## Phase 2 — Native Game Hook (the hard part, where real MP starts)
To actually sync a player *inside* GTA V, you need to inject code into the game process.

### What you need:
1. **DLL Injector** (C/C++)
   - CreateRemoteThread / LoadLibraryA injection
   - Or a signed kernel driver for anti-cheat-compatible injection (harder)
   - Modern: use `MinHook` or `Detours` for function hooking

2. **Game Hook DLL** (C++ — this is the real "client")
   The DLL lives inside GTA5.exe and needs to:
   - Find the game's memory patterns for key classes (`CPed`, `CPlayerInfo`, `CNetworkPlayerMgr`, `CStreamingMgr`, etc.)
   - Hook DirectX 11 (Present, DrawIndexedPrimitive) to draw an overlay/CEF
   - Read local player position (from `CPed::m_coords`) every tick
   - Write remote player positions (spawn peds via `CREATE_PED` / SET_ENTITY_COORDS natives)
   - Hook chat input or implement your own via CEF overlay
   - Stream custom assets (this is an enormous sub-project)

3. **Native Invoker**
   Crossmap for GTA V natives (offsets change every build). Projects like [natives.json](https://github.com/alloc8or/gta5-nativedb-data) maintain these.

### Native libraries to connect DLL to the JS bridge
The client-bridge.js already listens on TCP port 22100. Your DLL can connect there and send line-delimited JSON:
```
{"pos":{"x":123.4,"y":-456.7,"z":20.5,"h":90.0}}
{"chat":"hello!"}
```
You can also embed a lightweight HTTP/WebSocket client directly in the DLL.

## Phase 3 — Networking Improvements
- Replace JSON-over-UDP with a binary protocol (use **RakNet** or **ENet** for reliable/unreliable channels)
- Delta compression for entity states
- Client-side prediction + server reconciliation
- Interest management (don't send players on the other side of the map)
- Entity streaming beyond players (vehicles, peds, objects, custom maps)

## Phase 4 — Scripting Runtime
FiveM uses CitizenMono (C#) + Lua + JS (V8). alt:V uses C#/JS/Lua.
- Embed V8 or LuaJIT (or use Node's built-in V8 from a sidecar process)
- Expose a native-call API to scripts
- Client-side scripts (UI, effects) + server-side scripts (game logic)
- Resource system (load/unload folders with `__resource.lua` / `resource.toml`)

## Phase 5 — Asset/Mod Streaming
This is the single biggest engineering effort:
- Custom DLC-like packaging (RPF-like archive format)
- Server tells client which resources to download
- Client mounts them into the game's streaming engine
- Custom vehicles, maps, peds, weapons, scripts, audio

## Phase 6 — Anti-Cheat
- Client integrity checks (DLL signatures, memory scanning)
- Server-side validation (reject impossible moves)
- Heartbeat / challenge-response
- Kernel-mode component (like EAC/BattlEye) for serious anti-cheat — a multi-million-dollar project on its own

## Phase 7 — Master Server & Services
- Account system (OAuth/email)
- Server registration + heartbeat (already partially done)
- CDN for asset downloads
- Matchmaking
- Voice server (Opus codec, proximity-based)

## Tech stack recommendations
| Component | Recommendation |
|-----------|---------------|
| Launcher UI | Keep Electron (what you have, same as FiveM/alt:V) |
| Native client | C++ with MinHook, DirectX 11 hooks |
| Networking | ENet (reliable UDP) or migrate everything to C++ |
| Server | For real production: C++ with embedded V8/Lua. Node is fine for small/community servers. |
| CEF overlay | Use `cefc-rs` or Chromium Embedded Framework directly |
| Installer | electron-builder NSIS (already configured) |
| Updater | electron-updater + GitHub Releases or your own CDN |

## Legal note
GTA V modding has a complicated legal history. Rockstar's official stance is generally tolerant of single-player mods, but multiplayer mods have been hit with DMCA claims (see the FiveM vs. Rockstar history). Do not distribute or use any Rockstar-copyrighted assets in your mod packages.
