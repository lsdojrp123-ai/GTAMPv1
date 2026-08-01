<p align="center">
  <img src="gtamp.png" width="120" alt="GTAMP logo">
</p>

<h1 align="center">GTAMP</h1>
<p align="center"><strong>Grand Theft Auto Multiplayer</strong> — community-built GTA:V multiplayer modification (FiveM-style).<br>
Electron launcher + native hook + FXServer-compatible node + community website.</p>

<p align="center">
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/latest-v1.9.8-e11d48?style=for-the-badge" alt="latest v1.9.8"></a>
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-1f2937?style=for-the-badge" alt="Windows x64"></a>
  <a href="https://github.com/citizenfx/fivem"><img src="https://img.shields.io/badge/design%20parity-citizenfx%2Ffivem-374151?style=for-the-badge" alt="FiveM parity"></a>
</p>

---

## ⬇ Download

| | |
|---|---|
| **Latest (v1.9.8)** | **[GTAMP-Launcher-v1.9.8.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/download/v1.9.8/GTAMP-Launcher-v1.9.8.exe)** |
| All releases | [github.com/lsdojrp123-ai/GTAMPv1/releases](https://github.com/lsdojrp123-ai/GTAMPv1/releases) |

> ⚠️ **Delete every older `GTAMP-Launcher-*.exe` from your PC first.**
> Old builds (v1.9.5 and earlier) do not inject correctly.
> **How to know you're on the new one:** the launch card's bottom-right footer must read **`GTAMP v1.9.8`**.
> The footer text is baked into the exe — if it says anything older, you opened an old file.

## 🚀 Using it

1. Own a legitimate copy of **GTA V** (Steam / Epic / Rockstar).
2. Download & run **GTAMP-Launcher-v1.9.8.exe** (portable — nothing to install).
3. Point it at your GTA V folder when asked, pick a server, press **Connect**.
4. GTA already open in story mode? Leave it running — GTAMP **switches you into the session** without relaunching the game (FiveM `-switchcl`-style), then drops you in.

## ✨ What's new in v1.9.8

- **🎯 The launcher can no longer go blind.** The "waiting for game window" stall is gone for good: the JS side used to poll Windows `tasklist` to spot `GTA5.exe` — on memory-pressured PCs those shell spawns silently fail, so the card wedged forever *while the game was already running*. The native injector now owns the whole wait: it finds the process through the Windows snapshot API (no shell, no spawn), waits for the window, settles, and injects — one process, one chain.
- **⚡ Instant process probe.** The launcher's "is GTA running?" check is now the injector's zero-injection `--probe` mode (own `--pid-timeout` budget), with `tasklist` as fallback only. GTA V **Legacy** (`GTA5.exe`) and **Enhanced** (`GTA5_Enhanced.exe`) cross-match either way.
- Includes the v1.9.6 self-updater & v1.9.7 stale-window takeover. **The launch card footer must read `GTAMP v1.9.8`.**

Full history: [gtalauncher/docs/ROADMAP.md](gtalauncher/docs/ROADMAP.md) · FiveM behavior map: [gtalauncher/docs/FIVEM-PARITY.md](gtalauncher/docs/FIVEM-PARITY.md)

## 🧱 Repository layout

| Path | What it is |
|---|---|
| `gtalauncher/` | Electron launcher, native injector + in-game hook, FXServer node, docs |
| `website/` | GTAMP community website (server + static build, launcher downloads) |
| `GTAMP-Launcher-v1.9.8.exe` | Current launcher build (also attached to Releases) |

## 🛟 Troubleshooting

- **ERR_GFX_D3D_INIT** — remove ENB/ReShade (`d3d11.dll`, `enbseries*`) from the GTA folder, reboot once, retry. GTAMP already forces DirectX 11 and pauses ShadowPlay for you.
- Still stuck? Send `%TEMP%\gtamp_injector.log` + tail of `%TEMP%\gtamp_launcher_diag.log`.

---

<p align="center"><sub>GTAMP is an unofficial community project. Not affiliated with Rockstar Games, Take-Two Interactive, or Cfx.re (FiveM). Behavior parity is implemented with original GTAMP code.</sub></p>
