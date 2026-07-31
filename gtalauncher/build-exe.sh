#!/bin/bash
set -e
cd /home/user/gtalauncher
rm -rf dist

export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
export WINEPREFIX=/tmp/wine64
export WINEARCH=win64
export WINEDEBUG=-all
export WINEDLLOVERRIDES="mscoree,mshtml="
mkdir -p $XDG_RUNTIME_DIR
chmod 700 $XDG_RUNTIME_DIR

# Kill any existing
pkill Xvfb 2>/dev/null || true
pkill -f wineserver 2>/dev/null || true
sleep 1

# Start virtual display
Xvfb :99 -screen 0 1024x768x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

# Init wineprefix (non-fatal if already initialized)
wineboot --init >/dev/null 2>&1 || true
sleep 3

# Run the build
echo "=== Starting electron-builder ==="
npx electron-builder --win portable --x64 \
  --config.win.signAndEditExecutable=false \
  --config.win.sign=false \
  2>&1 | tee /tmp/build-out.log
EC=${PIPESTATUS[0]}

kill $XVFB_PID 2>/dev/null || true
echo "=== Build exit code: $EC ==="
ls -la dist/ 2>/dev/null
exit $EC
