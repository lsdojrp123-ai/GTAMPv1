@echo off
title GTAMP cleanup
echo ============================================================
echo  GTAMP cleanup - closes stuck launchers, deletes old exes
echo ============================================================
echo.
echo [1/3] Closing any running GTAMP launcher windows...
powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like 'GTAMP*' -or $_.MainWindowTitle -like '*GTAMP*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
echo      done.
echo.
echo [2/3] Closing leftover injector processes...
powershell -NoProfile -Command "Get-Process gtamp_injector -ErrorAction SilentlyContinue | Stop-Process -Force"
echo      done.
echo.
echo [3/3] Deleting ALL old GTAMP launcher exes from Downloads + Desktop...
del /q "%USERPROFILE%\Downloads\GTAMP-Launcher-*.exe" 2>nul
del /q "%USERPROFILE%\Desktop\GTAMP-Launcher-*.exe" 2>nul
del /q "%USERPROFILE%\Downloads\GTAMP-*.exe" 2>nul
echo      done.
echo.
echo ============================================================
echo  DONE. Now do this:
echo  1. Download  GTAMP-Launcher-v2.0.0.exe  from:
echo     https://github.com/lsdojrp123-ai/GTAMPv1/releases/latest
echo  2. Run it. The card footer must read "GTAMP v2.0.0".
echo ============================================================
pause
