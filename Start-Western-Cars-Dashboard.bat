@echo off
setlocal
title Western Cars Operations Dashboard
cd /d "%~dp0"

rem --- 1. Node.js present? ---------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found on this computer.
  echo  Install the LTS version from https://nodejs.org then run this file again.
  echo.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo  This dashboard needs Node.js 18 or newer. Installed version:
  node -v
  echo  Please update Node.js and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "control-dashboard\server.js" (
  echo.
  echo  control-dashboard\server.js was not found next to this launcher.
  echo.
  pause
  exit /b 1
)

rem --- 2. Start the dashboard (it opens the browser by itself) -----------
rem If it is already running, it just opens the browser and exits.
node "control-dashboard\server.js" --open
if errorlevel 1 (
  echo.
  echo  The dashboard stopped with an error. See the message above.
  echo.
  pause
)
endlocal
