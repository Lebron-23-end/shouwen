@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Shouwen - Start (background)
rem  Launches the web server AND the forward watcher silently
rem  in the background, then this window closes by itself.
rem  To stop them, double-click the STOP script.
rem ============================================================

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

rem Common install locations, in case node is not on PATH.
rem (Avoid %ProgramFiles(x86)% here - the ")" would break the for block.)
if not defined NODE_EXE (
  for %%P in (
    "%ProgramFiles%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%APPDATA%\nvm\node.exe"
    "%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
    "C:\nvm4w\nodejs\node.exe"
  ) do if not defined NODE_EXE if exist %%P set "NODE_EXE=%%~P"
)

if not defined NODE_EXE goto :no_node

rem ---- already running? ----
rem Two independent checks: our own pid file, then the listening port.
set "ALREADY="
set "OLD_PID="
if exist "data\server.pid" set /p OLD_PID=<"data\server.pid"
if defined OLD_PID (
  tasklist /fi "PID eq %OLD_PID%" 2>nul | findstr /i "node.exe" >nul 2>nul && set "ALREADY=1"
)
if not defined ALREADY (
  netstat -ano | findstr ":4321" | findstr "LISTENING" >nul 2>nul && set "ALREADY=1"
)

if defined ALREADY (
  echo.
  echo   Shouwen is already running.
  echo   Open  http://localhost:4321
  echo   To restart, run the STOP script first.
  echo.
  ping -n 5 127.0.0.1 >nul
  exit /b 0
)

rem stale pid/lock files from a previous crash - clear them
if exist "data\server.pid" del /q "data\server.pid" >nul 2>nul
if exist "data\wx-watch.lock" del /q "data\wx-watch.lock" >nul 2>nul

rem ---- 1/2: web server first (the watcher probes it on startup) ----
start "ShouwenServer" /min "%NODE_EXE%" server.js

rem wait until the port is actually listening, so the watcher does not
rem start up thinking the server is down
set /a _try=0
:wait_srv
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":4321" | findstr "LISTENING" >nul 2>nul && goto srv_ok
set /a _try+=1
if %_try% lss 12 goto wait_srv

:srv_ok
rem ---- 2/2: forward watcher ----
start "ShouwenWatcher" /min "%NODE_EXE%" wx-watch.cjs

rem give the watcher a moment, then open the page
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:4321"

echo.
echo   Shouwen started in the background.
echo.
echo     Page     http://localhost:4321
echo     Watcher  WeChatBridge forwards
echo     Stop     double-click the STOP script
echo.
echo   This window will close by itself.
ping -n 5 127.0.0.1 >nul
exit /b 0

:no_node
echo   [X] Node.js not found. Please install Node.js 18+ first.
echo       https://nodejs.org
echo.
pause
exit /b 1
