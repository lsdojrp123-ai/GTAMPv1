<p align="center">
  <img src="gtamp.png" width="120" alt="GTAMP logo">
</p>

<h1 align="center">GTAMP</h1>
<p align="center"><strong>Grand Theft Auto Multiplayer</strong> — community-built GTA:V multiplayer modification (FiveM-style).<br>
Electron launcher + native hook + FXServer-compatible node + community website.</p>

<p align="center">
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/latest-v2.1.0-e11d48?style=for-the-badge" alt="latest v2.1.0"></a>
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-1f2937?style=for-the-badge" alt="Windows x64"></a>
  <a href="https://github.com/citizenfx/fivem"><img src="https://img.shields.io/badge/design%20parity-citizenfx%2Ffivem-374151?style=for-the-badge" alt="FiveM parity"></a>
</p>

---

## ⬇ Download

| | |
|---|---|
| **GTAMP-Setup.exe** ← get this | **[GTAMP-Setup.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest/download/GTAMP-Setup.exe)** — the FiveM-style installer: double-click once, GTAMP lands on your desktop and **updates itself forever**. Setup automatically closes any stuck old GTAMP window during install. |
| Portable (no install) | [GTAMP-Launcher-v2.1.0.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest/download/GTAMP-Launcher-v2.1.0.exe) |
| All releases | [github.com/lsdojrp123-ai/GTAMPv1/releases](https://github.com/lsdojrp123-ai/GTAMPv1/releases) |

> If Windows shows a blue SmartScreen prompt: **More info → Run anyway** (GTAMP is not code-signed, same as many mods).
> The new window shows a **pink v2.1.0 top-right** — if yours doesn't, that's an old window, close it and run GTAMP again.


## 🚀 Using it

1. Own a legitimate copy of **GTA V** (Steam / Epic / Rockstar).
2. Download & run **GTAMP-Launcher-v2.1.0.exe** (portable — nothing to install).
3. Point it at your GTA V folder when asked, pick a server, press **Connect**.
4. GTA already open in story mode? Leave it running — GTAMP **switches you into the session** without relaunching the game (FiveM `-switchcl`-style), then drops you in.

## ✨ What's new in v2.1.0

- **🪟 GTAMP now sees the game the way YOU do — by its window.** The fix for "waiting for game window" while GTA is visibly open: GTAMP used to recognize GTA **only** by scanning for the process name. Now it also finds the actual **"Grand Theft Auto V" window** on your screen and adopts the game from there. If you can see the game, GTAMP can see it.
- **📦 GTAMP-Setup.exe — real installer, like FiveM.** One double-click: closes any stuck old GTAMP by itself, installs to your PC with a **GTAMP desktop icon**, launches itself, and silent-updates in place forever after. No more version-named exes, no kill files, no hunting.
- **🗣️ No more silent takeovers.** If an old stuck window ever blocks the new GTAMP, you now get a **pop-up telling you exactly how to close it** instead of the old window just sitting there.
- **💗 The window wears its version.** Big pink **v2.1.0** top-right on every card — one glance proves which build is on your screen.
- Carries everything from v1.9.6–2.0.0: self-updater, dual-channel injector feed, **INJECT NOW** button on the connect card, 30-second-silence error cards with diagnostics auto-copied, admin rights detection, native no-shell process watcher.

**Footer must read `GTAMP v2.1.0`, pink version stamp top-right. Support = paste your clipboard after any failure.**

Full history: [gtalauncher/docs/ROADMAP.md](gtalauncher/docs/ROADMAP.md) · FiveM behavior map: [gtalauncher/docs/FIVEM-PARITY.md](gtalauncher/docs/FIVEM-PARITY.md)

## 🧱 Repository layout

| Path | What it is |
|---|---|
| `gtalauncher/` | Electron launcher, native injector + in-game hook, FXServer node, docs |
| `website/` | GTAMP community website (server + static build, launcher downloads) |
| `GTAMP-Launcher-v2.1.0.exe` | Current launcher build (also attached to Releases) |

## 🛟 Troubleshooting

- **ERR_GFX_D3D_INIT** — remove ENB/ReShade (`d3d11.dll`, `enbseries*`) from the GTA folder, reboot once, retry. GTAMP already forces DirectX 11 and pauses ShadowPlay for you.
- Still stuck? Send `%TEMP%\gtamp_injector.log` + tail of `%TEMP%\gtamp_launcher_diag.log`.

---

<p align="center"><sub>GTAMP is an unofficial community project. Not affiliated with Rockstar Games, Take-Two Interactive, or Cfx.re (FiveM). Behavior parity is implemented with original GTAMP code.</sub></p>
