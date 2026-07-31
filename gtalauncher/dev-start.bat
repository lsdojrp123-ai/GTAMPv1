@echo off
REM Quick dev start - no build, runs launcher directly
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 ( echo Install Node.js from https://nodejs.org/ & pause & exit /b 1 )
if not exist node_modules ( echo Installing deps... & call npm install )
npx electron . --dev
