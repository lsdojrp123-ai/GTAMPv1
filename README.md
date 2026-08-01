<p align="center">
  <img src="gtamp.png" width="120" alt="GTAMP logo">
</p>

<h1 align="center">GTAMP</h1>
<p align="center"><strong>Grand Theft Auto Multiplayer</strong> — community-built GTA:V multiplayer modification (FiveM-style).<br>
Electron launcher + native hook + FXServer-compatible node + community website.</p>

<p align="center">
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/latest-v2.1.1-e11d48?style=for-the-badge" alt="latest v2.1.1"></a>
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-1f2937?style=for-the-badge" alt="Windows x64"></a>
  <a href="https://github.com/citizenfx/fivem"><img src="https://img.shields.io/badge/design%20parity-citizenfx%2Ffivem-374151?style=for-the-badge" alt="FiveM parity"></a>
</p>

---

## ⬇ Download

| | |
|---|---|
| **GTAMP-Setup.exe** ← get this | **[GTAMP-Setup.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest/download/GTAMP-Setup.exe)** — the FiveM-style installer: double-click once, GTAMP lands on your desktop and **updates itself forever**. Setup automatically closes any stuck old GTAMP window during install. |
| Portable (no install) | [GTAMP-Launcher-v2.1.1.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest/download/GTAMP-Launcher-v2.1.1.exe) |
| All releases | [github.com/lsdojrp123-ai/GTAMPv1/releases](https://github.com/lsdojrp123-ai/GTAMPv1/releases) |

> If Windows shows a blue SmartScreen prompt: **More info → Run anyway** (GTAMP is not code-signed, same as many mods).
> The new window shows a **pink v2.1.1 top-right** — if yours doesn't, that's an old window, close it and run GTAMP again.


## 🚀 Using it

1. Own a legitimate copy of **GTA V** (Steam / Epic / Rockstar).
2. Download & run **GTAMP-Launcher-v2.1.1.exe** (portable — nothing to install).
3. Point it at your GTA V folder when asked, pick a server, press **Connect**.
4. GTA already open in story mode? Leave it running — GTAMP **switches you into the session** without relaunching the game (FiveM `-switchcl`-style), then drops you in.

## ✨ What's new in v2.1.1

- **🛟 ScriptHookV build-mismatch is now a guided fix, not a mystery crash.** If GTA shows `SCRIPT HOOK V CRITICAL ERROR — FATAL: Can't find native 0x…`, our hook notices the fatal, and the connect card tells you exactly what happened and how to fix it (official ScriptHookV download button included) — the file's own version fingerprint is shown. No more silent dead-ends after the red error box.
- **🪟 GTAMP sees the game by its window, not just its process name** (from v2.1.0) — *"waiting for game window" while GTA is open is impossible now*.
- **📦 GTAMP-Setup.exe installer** — one double-click; it closes stuck old GTAMP windows itself, drops a GTAMP icon on your desktop, and self-updates forever.

**Pink `v2.1.1` top-right of every card. Any failure: diagnostics are already on your clipboard.**

Full history: [gtalauncher/docs/ROADMAP.md](gtalauncher/docs/ROADMAP.md) · FiveM behavior map: [gtalauncher/docs/FIVEM-PARITY.md](gtalauncher/docs/FIVEM-PARITY.md)

## 🧱 Repository layout

| Path | What it is |
|---|---|
| `gtalauncher/` | Electron launcher, native injector + in-game hook, FXServer node, docs |
| `website/` | GTAMP community website (server + static build, launcher downloads) |
| `GTAMP-Launcher-v2.1.1.exe` | Current launcher build (also attached to Releases) |

## 🛟 Troubleshooting

- **ERR_GFX_D3D_INIT** — remove ENB/ReShade (`d3d11.dll`, `enbseries*`) from the GTA folder, reboot once, retry. GTAMP already forces DirectX 11 and pauses ShadowPlay for you.
- Still stuck? Send `%TEMP%\gtamp_injector.log` + tail of `%TEMP%\gtamp_launcher_diag.log`.

---

<p align="center"><sub>GTAMP is an unofficial community project. Not affiliated with Rockstar Games, Take-Two Interactive, or Cfx.re (FiveM). Behavior parity is implemented with original GTAMP code.</sub></p>
