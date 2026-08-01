<p align="center">
  <img src="gtamp.png" width="120" alt="GTAMP logo">
</p>

<h1 align="center">GTAMP</h1>
<p align="center"><strong>Grand Theft Auto Multiplayer</strong> — community-built GTA:V multiplayer modification (FiveM-style).<br>
Electron launcher + native hook + FXServer-compatible node + community website.</p>

<p align="center">
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/latest-v1.9.9-e11d48?style=for-the-badge" alt="latest v1.9.9"></a>
  <a href="https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-1f2937?style=for-the-badge" alt="Windows x64"></a>
  <a href="https://github.com/citizenfx/fivem"><img src="https://img.shields.io/badge/design%20parity-citizenfx%2Ffivem-374151?style=for-the-badge" alt="FiveM parity"></a>
</p>

---

## ⬇ Download

| | |
|---|---|
| **Latest (v1.9.9)** | **[GTAMP-Launcher-v1.9.9.exe](https://github.com/lsdojrp123-ai/GTAMPv1/releases/download/v1.9.9/GTAMP-Launcher-v1.9.9.exe)** |
| All releases | [github.com/lsdojrp123-ai/GTAMPv1/releases](https://github.com/lsdojrp123-ai/GTAMPv1/releases) |

> ⚠️ **Delete every older `GTAMP-Launcher-*.exe` from your PC first.**
> Old builds (v1.9.5 and earlier) do not inject correctly.
> **How to know you're on the new one:** the launch card's bottom-right footer must read **`GTAMP v1.9.9`**.
> The footer text is baked into the exe — if it says anything older, you opened an old file.

## 🚀 Using it

1. Own a legitimate copy of **GTA V** (Steam / Epic / Rockstar).
2. Download & run **GTAMP-Launcher-v1.9.9.exe** (portable — nothing to install).
3. Point it at your GTA V folder when asked, pick a server, press **Connect**.
4. GTA already open in story mode? Leave it running — GTAMP **switches you into the session** without relaunching the game (FiveM `-switchcl`-style), then drops you in.

## ✨ What's new in v1.9.9

- **📡 The card now shows you what it sees.** Every line the injector reports streams live onto the connect card (tiny feed under the status text) — heartbeats every 5 s while it waits. If GTA never appears, if Windows hides the window, or if security software swallows the injector, the card *says so in plain text*.
- **📋 Diagnostics copy themselves.** Any failure automatically puts the full chronological log on your clipboard — paste it anywhere (Ctrl+V) to share. No more hunting `%TEMP%` logs.
- **⚡ Fails fast instead of staring.** A new preflight proves Windows can run `gtamp_injector.exe` before waits begin (antivirus/SmartScreen blocks get a precise card in seconds). Elevated GTA V (Rockstar running as admin) is detected instantly with a one-click **Restart as Administrator** button. Injection failures now get their own correct card instead of the "game window" one.
- **🕐 Smarter budgets:** 4 min for slow Rockstar sign-in/updates; window wait blind-injects at 60 s (was 120 s); every error maps to its real cause.

**The launch card footer must read `GTAMP v1.9.9`.** If a connect ever fails on this build, the answer is already on your clipboard.

Full history: [gtalauncher/docs/ROADMAP.md](gtalauncher/docs/ROADMAP.md) · FiveM behavior map: [gtalauncher/docs/FIVEM-PARITY.md](gtalauncher/docs/FIVEM-PARITY.md)

## 🧱 Repository layout

| Path | What it is |
|---|---|
| `gtalauncher/` | Electron launcher, native injector + in-game hook, FXServer node, docs |
| `website/` | GTAMP community website (server + static build, launcher downloads) |
| `GTAMP-Launcher-v1.9.9.exe` | Current launcher build (also attached to Releases) |

## 🛟 Troubleshooting

- **ERR_GFX_D3D_INIT** — remove ENB/ReShade (`d3d11.dll`, `enbseries*`) from the GTA folder, reboot once, retry. GTAMP already forces DirectX 11 and pauses ShadowPlay for you.
- Still stuck? Send `%TEMP%\gtamp_injector.log` + tail of `%TEMP%\gtamp_launcher_diag.log`.

---

<p align="center"><sub>GTAMP is an unofficial community project. Not affiliated with Rockstar Games, Take-Two Interactive, or Cfx.re (FiveM). Behavior parity is implemented with original GTAMP code.</sub></p>
