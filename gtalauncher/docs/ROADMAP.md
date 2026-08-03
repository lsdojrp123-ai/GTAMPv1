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

## v2.2.2 — the engine proves itself out loud
Field report at v2.2.1: no more fatal dialogs, but nothing spawned either — and the failure was silent (the own-engine scan result was only visible mid-flow).
- **Up-front native probe**: the moment the own engine lights, the hook resolves its entire 52-native working set and reports `nativeProbe {found,total,miss:[names],gta}` to the launcher feed before touching the game. Any miss is NAMED ("missing: CREATE_PED") instead of invisible.
- **Ped-watch telemetry**: engine live but GTA not answering `PLAYER_ID`/`PLAYER_PED_ID` within ~15 s → `pedWait` pings the feed every 10 s with the resolve status of exactly those two natives. A dead engine can no longer masquerade as a connected session.
- **Persistent probing**: the own-engine scan no longer goes permanently dark after the first window — if the table wasn't populated yet (mid-load), the ped-watch re-probes every 5 s until it appears.
- **Honest HUD**: the in-game status line shows `natives: GTAMP-OWN` vs `probing… (no engine yet)` (the SHV-fallback label was a lie after v2.2.1 removed it).
- Diag-of-record stays `%TEMP%\gtamp_hook.log` (probe lines name every miss).

## v2.2.1 — the stale in-game hook and the SHV fallback are dead
Field report at v2.2.0: the same SHV FATAL dialog resurfaced. Root cause: **Windows never reloads a same-path DLL inside a still-running GTA** — the old v2.1.x hook stayed resident in the user's GTA process, so re-injecting did nothing and the old fiber kept dying on their ScriptHookV.
- **Versioned hook staging**: the launcher now copies `gtamp_hook.dll` to `%TEMP%\gtamp-native\v<ver>\` before injection, so a new build can physically enter an already-hooked GTA.
- **In-game singleton guard** (`Global\GTAMP_HOOK_SINGLE` named mutex): whichever hook owns the process keeps it; a second loader unloads itself instead of double-running.
- **hookMismatch card**: the launcher compares the hook's `hookHello` version to its own. On mismatch: *"GTA is running an old GTAMP (vX)"* with a one-click **Close GTA & Retry** (taskkills GTA5.exe/GTA5_Enhanced.exe then reruns the whole flow). The stale-hook death loop is now loud, explained, and self-fixing — the same take-over discipline FiveM applies to zombie bootstrap instances.
- **ScriptHookV invoke path removed entirely.** Calling SHV's `nativeInit` on a build-mismatched SHV is precisely what raised `FATAL: Can't find native` and killed our fiber. SHV is now ONLY the fiber scheduler (`scriptRegister`/`scriptWait`); natives are exclusively GTAMP's own engine. The dialog is no longer producible by GTAMP.
- **noInv card** replaces the SHV fallback: if the own engine can't map the GTA build (Rockstar moved the table layout), the hook fiber stays alive, touches nothing, and the card asks for clipboard diagnostics — graceful degradation instead of a fatal.
- `nativeScan`/`noInv` telemetry now carries the exact GTA build string.

## v2.2.0 — GTAMP resolves GTA natives ITSELF (FiveM rage-scripting-five behavior port)
- **The error class that blocked the user at v2.1.1 is deleted.** `FATAL: Can't find native` existed because we routed every native through the *user's* ScriptHookV.dll, whose embedded database must match the game build. FiveM doesn't have this problem because it resolves natives itself — now so do we.
- **Own native engine** (`src/native/hook/own_invoker.h`): pattern-scan the game's 256-bucket registration table, de-obfuscate R*'s XOR-folded entries, resolve handlers, invoke with a rage-faithful call context. Behavior documented row-by-row in [FIVEM-PARITY.md](./FIVEM-PARITY.md) §5.
- **Per-build re-key map** (`native_remap.h`, auto-generated from FiveM's published `CrossMapping_Universal.h` chains): all 48 re-keyed natives GTAMP uses resolve correctly on b2372 through every current build; 4 stable natives resolve directly.
- **Defense in depth:** structural table validation, executable-check per handler, fast-path cache, miss logging. Any surprise → permanent, silent fallback to the ScriptHookV export path (v2.1.1 behavior preserved).
- ScriptHookV's role shrinks to **fiber scheduler only** — it no longer needs a matching native database, so an old/forked ScriptHookV.dll stops being fatal to GTAMP.
- New bridge events → exact cards: `nativeScan` (own engine active, N natives — shown in the live feed), `noShv` (ScriptHookV missing → install card), `fiberFail` (real engine stall, distinct from SHV mismatch).
- v2.1.1 telemetry bug fixed: the `shvFail` bridge line was sent over-escaped; the launcher's JSON parser silently dropped it (card never appeared).
- Launcher `2.2.0`, hook `2.2.0`, injector `2.2.0`.

## v2.1.1 — survive ScriptHookV's FATAL: report it, name it, fix it with one click
- Progress report from the field: injection now works end-to-end (window-adoption delivered), and the first native call against the user's own ScriptHookV.dll produced `SCRIPT HOOK V CRITICAL ERROR — FATAL: Can't find native 0xEEF059A8E6C27644` (GET_ENTITY_HEALTH — a day-zero native). That signature means **the user's ScriptHookV.dll cannot resolve natives on their GTA V build** (game updated past the file, or a fork/old copy) — SHV fatales and kills our script fiber, and the launcher used to just sit at "linking multiplayer hook".
- **Hook fiber watchdog.** The SHV script fiber timestamps every 50 ms tick; the overlay thread (independent of SHV) flags >8 s of post-entry silence, marks SHV dead, stops further native usage, and sends `{t:"shvFail", shv:"<file fingerprint>"}` over the bridge.
- **File fingerprinting.** At SHV discovery the hook reads ScriptHookV.dll's version resource (product/company/file version) so the failure card can name the exact offending file.
- **Launcher card with the cure.** Connect waits now race against `shvFail`; the card explains the mismatch in plain words and ships a real button: **Open ScriptHookV download** (official dev-c.com page) + Retry Inject + Cancel. Guidance matches what FiveM avoids by shippping its own native layer — for us, ScriptHookV must simply match the game build.
- Pervasive contract unchanged: any failure lands on the clipboard automatically.

## v2.1.0 — see the game by its window; real FiveM-style installer; silent takeover is dead
- User report that drove this release, verbatim: *"gta 5 loads, after gta 5 loads its still saying waiting for game window — it doesn't know that the game is open."* Two independent truths inside it: (1) detection keyed only on the process NAME; (2) the window they were stuck at was an old build (their card had no v2.0.0 version text and no INJECT NOW button), so delivery needed to be structural, not instructional.
- **Window-adoption detection (injector 2.1.0).** `--probe` and the process wait loop now fall back to a second, independent discovery path: `EnumWindows` for a visible top-level window titled **"Grand Theft Auto V"** (Legacy) / **"Grand Theft Auto V Enhanced"** and adopt that pid (`stage:process-adopted-by-window`). An adopted window also satisfies the D3D-gate instantly (it IS the game window), so the flow goes straight to settle→inject. If the user can see GTA on their screen, GTAMP can see it — the report's sentence is now impossible.
- **GTAMP-Setup.exe (NSIS oneClick, per-user, no admin).** Fixed artifact name, always the latest on the release page; creates Desktop + Start Menu "GTAMP" shortcuts; runs the app after install. Custom `installer.nsh` `preInit` taskkills every historic GTAMP exe name (`GTAMP-Launcher-*`, `GTAMP Launcher.exe`, `gtamp-launcher*`, `gtamp_injector.exe`) before install — the kill-file era ends inside the product. Self-update is now mode-aware: installed builds re-run `GTAMP-Setup.exe /S --force-run` (FiveM bootstrapper parity; verified against the electron-builder 24 NSIS template's isForceRun branch); portable builds keep swapping the exe; legacy updaters still find the versioned portable asset on each release.
- **Takeover can no longer fail silently.** The stale-instance sweep now covers every exe name ever shipped plus a PowerShell path-sweep (`ExecutablePath -like '*GTAMP*'`); if the single-instance lock STILL can't be retaken, the launcher shows a blocking native dialog (Task Manager steps) instead of `app.exit(0)` leaving the zombie on screen pretending nothing happened.
- **Loud versioning.** Every loading/connect card carries a pink `vX.Y.Z` stamp top-right in addition to the footer — screenshots are self-identifying now.

## v2.0.0 — the unbrickable connect card: dual-channel telemetry, force-inject, silence becomes an error
- User report driving this release: *"still says waiting for game window WHILE THE GAME IS OPEN."* With v1.9.9's live feed supposedly rendering heartbeats, a card that shows nothing means one of three silent paths: stdout pipe swallowed Windows-side, the synchronous-shell freeze, or simply an old exe. v2.0.0 closes all three.
- **File-tailed stage channel.** The injector always wrote its stage/error lines to `%TEMP%\gtamp_injector.log` (GTAMP_LOG); the connect flow now TAILS that file with plain `fs.promises` reads every 1 s and feeds the same lines into the same `onStage`. Stdout from a GUI-subsystem child can be eaten by Windows/AV; a file on disk cannot. Both channels dedupe into the one live feed.
- **⚡ INJECT NOW override.** The connect card carries a persistent `GAME OPEN? INJECT NOW` button (bottom-left): kills the waiting injector and immediately re-runs it `alreadyRunning` + no window wait + 0.8 s settle — straight into the open GTA5.exe. A generation counter guarantees the killed injector's exit event can never corrupt the new run's outcome. The wait-copy reminds the user the button exists.
- **Silence ladder.** 12 s with no line on EITHER channel → on-card warning; 30 s → hard fail card "The injector is not running" (SmartScreen/antivirus/Unblock guidance) with the full chronological log auto-copied to clipboard. The worst case is now a *self-reporting* case.
- **Synchronous-shell hazard removed.** The last `execSync` in the connect path (`ping 127.0.0.1` used as a 2 s pause during Rockstar platform bring-up) is now a plain `await sleep` — spawn/commit pressure could wedge the Electron main thread there, leaving the card frozen mid-flow with the game running behind it.
- Injector banner 2.0.0 (code otherwise unchanged — its file logging was already complete).

## v1.9.9 — the card tells you the truth: live injector feed, clipboard diagnostics, fast exact failures
- The last report pattern ("stuck on waiting for game window" with no further data) proved the remaining problem was **observability**, not the wait logic: whatever the injector was doing, the user and we could not see it. v1.9.9 makes the connect card a diagnostic instrument.
- **Live feed on the card.** The injector now heartbeats to stdout every 5 s while waiting (`stage:waiting-pid sec=N`, `stage:waiting-window sec=N`, plus raw window-title candidates every ~20 s) and the renderer shows the last 4 raw lines in a mono strip under the status text. A screenshot of the card now *is* the diagnosis.
- **Clipboard diagnostics.** Every injector line and milestone goes into a per-connect ring buffer; on any `fail()` the entire chronological story (versions, config, every stage line) is `clipboard.writeText`'d automatically and the error card says so — support becomes "paste what you have".
- **Preflight probe.** Before launching/reusing the game, the flow spawnSyncs `gtamp_injector.exe --probe` (instant, zero injection): if the binary cannot even start (SmartScreen/antivirus/quarantine, exit-code anomalies), the user gets a precise "Windows blocked the injector" card in seconds instead of a multi-minute silent wedge.
- **Elevation fast-fail.** After `stage:process-found` the injector immediately tests the inject-capable handle (3 s of retries for transients): `ERROR_ACCESS_DENIED` (elevated game, non-elevated launcher) → `error:access-denied`, exit 5, and a dedicated card with a working **Restart as Administrator** button (`powershell Start-Process -Verb RunAs`, self-exit). This previously surfaced as minutes of "waiting for game window" followed by the wrong card. `--probe` also annotates `elevated=1`.
- **Outcome correctness fixes:** the injector's process-exit is now a *fallback-only* signal (`stage:injector-exit code=N`) and can no longer overwrite precise stdout errors (`process-timeout`, `access-denied`…); the real `stage:injected pid=N loadRc=N` line is matched with `startsWith` (v1.9.8 used exact equality); genuine injection failures (`inject-failed`, `no-dll`, nonzero exit) map to their own card naming antivirus exclusions instead of the misleading "game window never appeared" ENB card.
- **Budgets:** process wait 4 min (Rockstar sign-in/updates can take minutes on loaded machines); window wait blind-injects at 60 s (was 120 s) — a one-minute-old process is provably past D3D init or already dead (`processAlive` catches the dead case).
- **25 s silence watchdog:** the heartbeat contract means total silence is itself a signal — the card calls out a blocked/silent injector while the exit-code path still provides the final outcome.

## v1.9.8 — injector owns the whole chain: the launcher can never go tasklist-blind again
- Root cause of the last "WAITING FOR GAME WINDOW — Game process — up to Ns remaining" wedge (screenshot confirmed `GTA5.exe` visibly running while the card counted down forever): the connect flow's step-7 loop polled `tasklist /FI "IMAGENAME eq GTA5.exe"` via `execSync` every 2 s. On commit-pressured machines (browser tabs + ENB + the game itself) those shell spawns throw or stall, `gtaRunning()` returned false forever, and the injector **was never even spawned** — the card could only die of old age.
- **The native injector now owns the entire launch → find → wait → inject chain.** The JS-side tasklist while-loop is deleted; step 7 makes one `runInjector({waitPid, waitWindow})` call with a native `--pid-timeout` budget for the process wait (separate from the window-wait budget) and streams `stage:` lines back. Process discovery uses `CreateToolhelp32Snapshot` — kernel-side, no shell, immune to spawn/commit failures.
- **`--probe` mode:** zero-injection instant check, prints `stage:process-found pid=N` and exits 0 (or `error:process-timeout`, exit 1). `gtaRunning()` now calls this first and only falls back to `tasklist` if the probe binary is missing — so every "is GTA up?" decision in the launcher (reuse vs. launch, post-launch confirmations, the story-mode rejoin path) is blind-proof.
- **Legacy ⇄ Enhanced cross-match:** the injector's executable matcher treats `GTA5.exe` and `GTA5_Enhanced.exe` as the same product — correct for the user's box ("i play the legecy which is GTA5.exe") and forward-compatible if they ever move to Enhanced.
- Outcome budgets reflect reality: fresh launch = pid-timeout + window-cap (+60 s grace); reused game = window-cap only. The UI countdown is now a pure `Date.now()` timer (renderer keeps ticking even if the backend is busy), error cards distinguish `process-timeout` ("GTA5.exe never appeared" → retry-inject/cancel) from `process-exited` (crash/ENB card) and window-timeout (ENB/likely-D3D card).
- Injector reports `GTAMP injector 1.9.8` on its bootstrap line; hook DLL unchanged at 1.9.2.

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
