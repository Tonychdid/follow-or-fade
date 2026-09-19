@echo off
title Follow or Fade - recording prep
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org then run this file again.
  start https://nodejs.org
  pause
  exit /b
)
if not exist .env (
  echo.
  echo  No .env file found - run start.bat once first so it can save your Nansen key.
  pause
  exit /b
)
echo  Starting the app in a separate window...
start "Follow or Fade server" cmd /k "cd /d "%~dp0" && node server.js"
node tools\warmup.mjs
start "" http://localhost:3000
echo.
echo  Leave the OTHER window open - that is the app. Closing it stops the site.
pause
