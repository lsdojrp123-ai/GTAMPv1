<p align="center">
  <img src="gtamp.png" width="120" alt="GTAMP logo">
</p>

<h1 align="center">GTAMP</h1>
<p align="center"><strong>Grand Theft Auto Multiplayer</strong> — community-built GTA:V multiplayer modification (FiveM-style).<br>
Electron launcher + native hook + FXServer-compatible node + community website.</p>

<p align="center">
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/latest-v2.0.0-e11d48?style=for-the-badge" alt="latest v2.0.0"></a>
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-1f2937?style=for-the-badge" alt="Windows x64"></a>
  <a href="https://github.com/citizenfx/fivem"><img src="https://img.shields.io/badge/design%20parity-citizenfx%2Ffivem-374151?style=for-the-badge" alt="FiveM parity"></a>
</p>

---

## ⬇ Download

| | |
|---|---|
| **Latest (v2.0.0)** | **[GTAMP-Launcher-v2.0.0.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/download/v2.0.0/GTAMP-Launcher-v2.0.0.exe)** |
| All releases | [github.com/lsdojrp123-ai/GTAMPv1/releases](https://github.com/lsdojrp123-ai/GTAMPv1/releases) |

> ⚠️ **Delete every older `GTAMP-Launcher-*.exe` from your PC first.**
> Old builds (v1.9.5 and earlier) do not inject correctly.
> **How to know you're on the new one:** the launch card's bottom-right footer must read **`GTAMP v2.0.0`**.
> The footer text is baked into the exe — if it says anything older, you opened an old file.

## 🚀 Using it

1. Own a legitimate copy of **GTA V** (Steam / Epic / Rockstar).
2. Download & run **GTAMP-Launcher-v2.0.0.exe** (portable — nothing to install).
3. Point it at your GTA V folder when asked, pick a server, press **Connect**.
4. GTA already open in story mode? Leave it running — GTAMP **switches you into the session** without relaunching the game (FiveM `-switchcl`-style), then drops you in.

## ✨ What's new in v2.0.0

- **🧱 No more silent black boxes — ever.** The injector now reports on **two independent channels**: its stdout *and* a plain log file that GTAMP reads directly (`%TEMP%\gtamp_injector.log`). Even if Windows eats the pipe, the card still sees everything.
- **⚡ "GAME OPEN? INJECT NOW" button on the card.** GTA already running and the card is waiting? One press skips every wait and injects straight into the open game. You are never a hostage to automation again.
- **⛔ Silence becomes an error card in 30 s.** The injector heartbeats every 5 s; if 30 s pass with no heartbeat on *either* channel, you get an exact card (SmartScreen/antivirus block) with **full diagnostics already copied to your clipboard** — never a frozen card again.
- **🧊 Last freeze hazard removed:** the one remaining synchronous shell call in the connect path (a `ping` sleep) is gone — on memory-loaded PCs that call could freeze the whole loader mid-connect.
- Plus everything from v1.9.6–1.9.9: self-updater, stale-window takeover, native process watcher, admin-detection with one-click elevated restart, preflight probe.

**The launch card footer must read `GTAMP v2.0.0`.** If it doesn't, run [KILL-OLD-GTAMP.bat](KILL-OLD-GTAMP.bat) once, then download this build.

Full history: [gtalauncher/docs/ROADMAP.md](gtalauncher/docs/ROADMAP.md) · FiveM behavior map: [gtalauncher/docs/FIVEM-PARITY.md](gtalauncher/docs/FIVEM-PARITY.md)

## 🧱 Repository layout

| Path | What it is |
|---|---|
| `gtalauncher/` | Electron launcher, native injector + in-game hook, FXServer node, docs |
| `website/` | GTAMP community website (server + static build, launcher downloads) |
| `GTAMP-Launcher-v2.0.0.exe` | Current launcher build (also attached to Releases) |

## 🛟 Troubleshooting

- **ERR_GFX_D3D_INIT** — remove ENB/ReShade (`d3d11.dll`, `enbseries*`) from the GTA folder, reboot once, retry. GTAMP already forces DirectX 11 and pauses ShadowPlay for you.
- Still stuck? Send `%TEMP%\gtamp_injector.log` + tail of `%TEMP%\gtamp_launcher_diag.log`.

---

<p align="center"><sub>GTAMP is an unofficial community project. Not affiliated with Rockstar Games, Take-Two Interactive, or Cfx.re (FiveM). Behavior parity is implemented with original GTAMP code.</sub></p>
