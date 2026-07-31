# GTAMP Architecture — FiveM-inspired, our own code

## Intent

We are **not** forking or shipping FiveM’s proprietary client.
We **are** building our own multiplayer stack that **behaves like** FiveM:

- Own launcher
- Controlled GTA process start
- In-game client (hook) that owns the world view of other players
- Dedicated game server
- Clear packet/entity model that can grow toward OneSync-like replication

If something is temporary (TestBot, frozen peds, Win32 overlay), it is a **scaffold**, not the end state.

---

## FiveM concept → GTAMP home

| FiveM-like idea | GTAMP (ours) | Today | Target |
|-----------------|--------------|--------|--------|
| Launcher / UI shell | `src/main` + `src/renderer` (Electron) | Working | Keep; polish server browser |
| Start game process | `findLauncher()` → prefer **`GTA5.exe`** | Working | Never rely on R* flash-quit paths |
| Game client runtime | `src/native/hook/dllmain.cpp` | Hook + SHV natives | Stable script host inside GTA |
| Native invoke | `src/native/shv/shv_invoker.h` | ScriptHookV | Optional own crossmap later |
| Client↔server glue | Built-in MP relay in `main.js` (TCP 22100 + UDP) | Working path | Keep single relay; drop dual-bridge confusion |
| Game server | `src/fxserver/` | Join/pos/chat/resources | Authoritative entities, dimensions |
| Remote players | Hook `NetPed` + `netPed*` packets | Clone peds + move | Smooth sync, anim/aim later |
| Solo fake peer | TestBot (hook and/or server) | Dev only | Disable when ≥2 real clients |
| Resources / gamemodes | `src/fxserver/resources/*` | freeroam, chat, spawn | Expand API carefully |
| NUI | NUI WS / future CEF | Early | In-process overlay (ImGui/CEF) |
| Asset streaming | stubs | Not started | High effort; last major moat |

---

## Runtime topology (target)

```
┌──────────────────┐     UDP game port      ┌──────────────────┐
│  GTAMP Launcher  │◄──────────────────────►│  GTAMP FXServer  │
│  (Electron)      │   join/pos/chat/event   │  (Node)          │
│                  │                         └──────────────────┘
│  MP relay        │
│  TCP :22100      │
└────────┬─────────┘
         │ line JSON
         ▼
┌──────────────────┐
│  GTA5.exe        │
│  + gtamp_hook    │
│  + ScriptHookV   │
│  NetPed clones   │
└──────────────────┘
```

**Rule:** one clear path for multiplayer glue.  
Launcher owns: start server (host), join server (UDP), talk to hook (TCP).  
Hook owns: local ped read, remote ped create/move/delete, overlay.  
Server owns: who is in the session, what positions are authoritative.

---

## Design rules (so we don’t thrash)

1. **Inspired by FiveM, written by us** — no vendoring their client binaries or private sources.
2. **Edit in-tree paths only** — `gtalauncher/src/...`, `dist-bin/`, root launcher exe. No side “UPDATE.zip” workflows as the product.
3. **Prefer `GTA5.exe` direct** — second PC must not depend on Rockstar Launcher open-and-close.
4. **Rockstar Online off ≠ GTAMP off** — `-scOfflineOnly` is “offline from R*”, multiplayer is still ours.
5. **Natives must be proven** — one bad hash = SHV fatal (`last native 0x0`). Add natives slowly; log before call when debugging.
6. **Scaffold → replace** — TestBot, frozen peds, Win32 overlay are steps toward real players, smooth sync, real NUI.
7. **Days are OK** — we climb the ladder phase by phase; no big-bang rewrite.

---

## Build ladder (same spirit as FiveM’s maturity)

### Done / mostly done
- [x] Launcher UI + package as Windows exe  
- [x] Detect GTA path, launch game, inject DLL  
- [x] Hook loads, SHV natives, F11 spawn, F9 overlay  
- [x] Server join/pos/chat skeleton  
- [x] Remote ped lifecycle (create/move/delete)  
- [x] Solo TestBot as fake second player  
- [x] Built-in launcher relay (hook ↔ server)

### Now (stability — “runs like a real client”) — **active**
- [x] Prefer direct `GTA5.exe` launch (2nd PC)  
- [x] Soften SHV natives / avoid text-native fatals  
- [x] Server accepts real GTA position stream (no false anti-cheat reject)  
- [x] Late-join roster + re-sync remotes after SHV ready  
- [ ] Two real clients confirmed seeing each other in playtest  
- [ ] Chat both ways confirmed  
- [ ] Clear logs always: `%TEMP%\gtamp_hook.log`, `gtamp_status.txt`

### Next (feels like multiplayer)
- [ ] Health / simple damage  
- [ ] Vehicle enter/exit + sync  
- [ ] Weapons / shots  
- [ ] Better move (less freeze-teleport; interp already started)  
- [ ] Replace F9 box with real in-game UI path

### Later (approaching FiveM territory)
- [ ] Richer server scripting API  
- [ ] Client script sandbox parity  
- [ ] Latency compensation  
- [ ] Custom asset streaming  
- [ ] Integrity / basic anti-cheat  

---

## Repo map (where work goes)

```
GTAMP-Launcher-v1.5.2.exe     ← what you double-click to playtest
gtalauncher/
  dist-bin/                   ← gtamp_hook.dll, gtamp_injector.exe
  src/main/main.js            ← launcher + MP relay + launch/inject
  src/renderer/               ← UI
  src/client/client-bridge.js ← optional full bridge (resources)
  src/fxserver/               ← game server + resources
  src/native/hook/            ← in-game client
  src/native/injector/        ← inject into GTA5.exe
  docs/ARCHITECTURE.md        ← this file
  docs/ROADMAP.md             ← history + long notes
```

---

## Legal / ethics (short)

- GTA V is Rockstar’s. We don’t distribute their game files.  
- FiveM is Cfx.re’s product. We don’t ship their client as ours.  
- We build **compatible ideas and our own implementation**.  
- Keep multiplayer clearly separate from GTA Online.

---

## Commitment

This project exists to become a **serious FiveM-like multiplayer client and server**, built in the open in this repo, one solid step at a time. Temporary hacks are allowed only if they are labeled and replaced on the ladder above.
