@echo off
REM GTAMP Launcher - Windows build script
REM Run this on a Windows machine to produce the .exe

echo ========================================
echo  GTAMP Launcher - Windows Build
echo ========================================
echo.

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/ (LTS recommended)
    pause
    exit /b 1
)

echo [1/4] Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] npm install failed & pause & exit /b 1 )

echo.
echo [2/4] Building portable .exe...
call npm run dist
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Build failed & pause & exit /b 1 )

echo.
echo [3/4] Building installer...
call npm run dist:installer
if %ERRORLEVEL% NEQ 0 ( echo [WARN] Installer build failed (portable is still in dist/) )

echo.
echo [4/4] Done!
echo.
echo Output files are in the dist\ folder:
dir /b dist\*.exe 2>nul
echo.
echo ========================================
echo  Build complete. Run the .exe in dist\
echo ========================================
pause
