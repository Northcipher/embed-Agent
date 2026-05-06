@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Embed Agent requires Node.js 22+.
  echo Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

node "%SCRIPT_DIR%scripts\open.mjs"
if errorlevel 1 (
  echo.
  echo Embed Agent failed to start.
  pause
  exit /b 1
)

exit /b 0
