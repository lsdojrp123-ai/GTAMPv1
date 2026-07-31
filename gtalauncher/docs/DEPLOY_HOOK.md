# Deploy hook v1.6.0

Your log showed **v1.5.2** — that means GTA loaded an **old** `gtamp_hook.dll`.

## Where the launcher loads the DLL from

Dev mode (`npm start` / `electron .`):
```
gtalauncher/dist-bin/gtamp_hook.dll
```

Packaged app:
```
<app>/resources/native/gtamp_hook.dll
```

## Fix

1. Rebuild: `cd gtalauncher/src/native && make`
2. Confirm log line is:
   `==== GTAMP hook v1.6.0 PID=... ====`
3. If you use `GTAMP-Launcher-v1.5.2.exe` at repo root, **that ships the old DLL**.
   Either run from source with updated `dist-bin/`, or rebuild the Electron package
   (`npm run dist`) so `resources/native/gtamp_hook.dll` is 1.6.0.
4. Fully quit GTA + launcher before reconnecting (DLL stays loaded until process exit).

## Expected after 1.6.0

- One `queue SPAWN once` for TestBot, not hundreds
- `FiveM SPAWN id=p9001 ... ped=...`
- Nametag `[9001] TestBot`, map blip
- Heading stays 0–360
