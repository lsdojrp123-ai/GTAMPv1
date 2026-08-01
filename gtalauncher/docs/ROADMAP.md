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

## ▶ NEXT — Phase 8: Health/stats sync + basic damage (Low risk)
Sync real ped health in the `pos` packet (field exists, hook sends hardcoded 200), show real HP in nametags, apply damage between players.

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
