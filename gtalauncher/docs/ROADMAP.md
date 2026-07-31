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
