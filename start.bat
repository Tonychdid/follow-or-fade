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
REM Give the server a few seconds to bind the port before the browser goes looking for it,
REM otherwise the first thing you see is a connection error and you have to refresh.
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:3000"
REM Local run on your own machine: keep the alert settings reachable without a token.
REM A hosted deploy never sets this, so losing a variable there closes admin instead of opening it.
set DEV_OPEN_ADMIN=1
node server.js
pause
exit /b

:writeenv
(
  echo NANSEN_API_KEY=%KEY%
  echo PORT=3000
  echo MAX_HOLD_HOURS=72
  echo CALIBRATION_SAMPLE=60
  echo DEMO=0
) > .env
exit /b
