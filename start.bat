@echo off
setlocal
cd /d "%~dp0"
title Nuan - AI Companion (local server)
color 0A

echo.
echo   ============================================
echo      Nuan - AI Companion   local server
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js not found.
  echo       Install Node.js 22.5 or newer from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   [1/3] Installing dependencies, first run only...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto fail
)

if not exist "site\index.html" (
  echo   [2/3] Building frontend, first run only...
  call npm run build
  if errorlevel 1 goto fail
)

echo   [3/3] Checking firewall rule for phones on the same Wi-Fi...
netsh advfirewall firewall show rule name="Nuan AI Companion" | findstr /i "Nuan" >nul
if errorlevel 1 (
  echo         Not found. A UAC window will pop up - click "Yes" to allow it.
  echo         After that, phones on the same Wi-Fi can open this app.
  powershell -NoProfile -Command "Start-Process -FilePath '%~dp0open-firewall.bat' -ArgumentList 'elevated' -Verb RunAs"
  timeout /t 4 >nul
) else (
  echo         OK, already allowed.
)

echo.
echo   Starting server. The browser will open automatically.
echo   If it does not, copy the URL printed below into your browser.
echo   Keep this window open while using the app. Ctrl + C to stop.
echo.

set OPEN_BROWSER=1
node --disable-warning=ExperimentalWarning server.js
set CODE=%errorlevel%

echo.
echo   Server stopped.
pause
exit /b %CODE%

:fail
echo.
echo   [X] Startup failed. Please read the messages above.
echo.
pause
exit /b 1
