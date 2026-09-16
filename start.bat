@echo off
title Follow or Fade
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org then run this file again.
  start https://nodejs.org
  pause
  exit /b
)
if not exist .env (
  echo.
  set /p KEY=" Paste your Nansen API key (or just press Enter for demo mode): "
  call :writeenv
)
start "" http://localhost:3000
node server.js
pause
exit /b

:writeenv
(
  echo NANSEN_API_KEY=%KEY%
  echo PORT=3000
  echo HORIZON_HOURS=4
  echo CALIBRATION_SAMPLE=60
  echo DEMO=0
) > .env
exit /b
