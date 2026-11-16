@echo off
setlocal
cd /d "%~dp0"
title Nuan - allow LAN access (Windows Firewall)
color 0E
set "LOG=%~dp0firewall-log.txt"

if /i "%~1"=="elevated" goto run

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo.
  echo   Administrator rights are required to open the firewall.
  echo   A UAC prompt will appear - click "Yes".
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'elevated' -Verb RunAs"
  exit /b
)

:run
echo ==== %DATE% %TIME% ==== > "%LOG%"

echo [1/3] Checking administrator rights...
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo   [X] Not running as administrator.
  echo   Right-click this file and choose "Run as administrator".
  echo NOT_ELEVATED >> "%LOG%"
  echo.
  pause
  exit /b 1
)
echo   OK >> "%LOG%"

echo [2/3] Adding inbound rule for TCP ports 7788-7798...
netsh advfirewall firewall delete rule name="Nuan AI Companion" >> "%LOG%" 2>&1
netsh advfirewall firewall add rule name="Nuan AI Companion" dir=in action=allow protocol=TCP localport=7788-7798 profile=any >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   [X] Failed to add the rule. See firewall-log.txt
  echo ADD_FAILED >> "%LOG%"
  echo.
  pause
  exit /b 1
)

echo [3/3] Verifying...
netsh advfirewall firewall show rule name="Nuan AI Companion" >> "%LOG%" 2>&1

echo.
echo   [OK] Firewall rule added.
echo.
echo   Phone: open  http://YOUR-PC-IP:7788  in the browser
echo          (the server window prints the exact address)
echo.
echo   Log: firewall-log.txt
echo.
pause
exit /b 0
