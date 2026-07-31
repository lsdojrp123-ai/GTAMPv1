@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title GTAMP FIX INJECT v1.6.0
echo.
echo  ============================================
echo   GTAMP FIX — restore hook injection
echo  ============================================
echo.
echo  This copies DLL + injector (+ optional app.asar)
echo  into your REAL launcher resources\native folder.
echo.

REM Kill stuck stuff
taskkill /F /IM GTA5.exe >nul 2>&1
taskkill /F /IM PlayGTAV.exe >nul 2>&1
taskkill /F /IM gtamp_injector.exe >nul 2>&1

set "TARGET="

REM Auto-detect common portable unpack folders
for %%D in (
  "%LOCALAPPDATA%\GTAMP-v152-HOTFIX"
  "%LOCALAPPDATA%\GTAMP-v160"
  "%LOCALAPPDATA%\GTAMP-Launcher-Portable"
  "%APPDATA%\GTAMP-v152-HOTFIX"
  "%USERPROFILE%\Desktop\GTAMP-Launcher-v1.6.0"
  "%USERPROFILE%\Downloads\GTAMP-Launcher-v1.6.0"
) do (
  if exist "%%~D\resources\native\" (
    set "TARGET=%%~D"
    goto :found
  )
)

REM Search LocalAppData for any resources\native\gtamp_injector.exe
echo  Searching %LOCALAPPDATA% for launcher...
for /f "delims=" %%F in ('dir /s /b "%LOCALAPPDATA%\gtamp_injector.exe" 2^>nul') do (
  set "P=%%~dpF"
  REM P is ...\resources\native\
  set "TARGET=!P!..\.."
  goto :found
)

echo.
echo  Could not auto-find launcher.
echo  Drag your GTAMP launcher FOLDER onto this bat,
echo  or paste the path to the folder that CONTAINS "resources".
echo.
set /p TARGET=Launcher folder: 

:found
set "TARGET=%TARGET:"=%"
echo.
echo  Using: %TARGET%
if not exist "%TARGET%\resources\native\" (
  echo  ERROR: %TARGET%\resources\native does not exist
  echo  You must pick the folder that has resources\ inside it.
  pause
  exit /b 1
)

echo.
echo  [1/3] Copying gtamp_hook.dll ...
copy /Y "%~dp0gtamp_hook.dll" "%TARGET%\resources\native\gtamp_hook.dll" || goto :fail
echo  [2/3] Copying gtamp_injector.exe ...
copy /Y "%~dp0gtamp_injector.exe" "%TARGET%\resources\native\gtamp_injector.exe" || goto :fail
echo  [3/3] Copying app.asar (launcher JS) ...
copy /Y "%~dp0app.asar" "%TARGET%\resources\app.asar" || goto :fail

echo.
echo  SUCCESS. Files now in:
echo    %TARGET%\resources\native\
dir "%TARGET%\resources\native\gtamp_*.*"
echo.
echo  NEXT STEPS:
echo   1. Start GTAMP Launcher FROM that folder / your usual shortcut
echo   2. Click Connect / Play so it launches GTA AND schedules inject
echo      (Do NOT only start GTA from Steam by itself)
echo   3. Wait ~20 seconds after GTA opens
echo   4. Open these in Notepad:
echo        %%TEMP%%\gtamp_status.txt
echo        %%TEMP%%\gtamp_injector.log
echo        %%TEMP%%\gtamp_hook.log
echo.
echo  gtamp_status.txt should list nativeDir=...\resources\native
echo  and exists=true for dll and injector.
echo  gtamp_hook.log should start with: GTAMP hook v1.6.0
echo.
echo  If hook log still missing: Windows blocked inject.
echo  Run launcher as Administrator, disable overlay, try again.
echo.
pause
exit /b 0

:fail
echo  COPY FAILED — close launcher completely and retry.
pause
exit /b 1
