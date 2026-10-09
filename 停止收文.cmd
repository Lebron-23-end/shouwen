@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Shouwen - Stop
rem  Kills the web server and the WeChat watcher.
rem  Order of attack: PID files first, then window titles,
rem  then whatever still holds port 4321.
rem ============================================================

echo.
echo   Stopping Shouwen...

rem ---- 1. watcher via its own lock file {"pid":N,...} ----
if exist "data\wx-watch.lock" (
  for /f "tokens=2 delims=:," %%P in ('type "data\wx-watch.lock"') do (
    taskkill /F /PID %%P >nul 2>nul
  )
)

rem ---- 2. server via its pid file ----
if exist "data\server.pid" (
  set /p SPID=<"data\server.pid"
  taskkill /F /PID %SPID% >nul 2>nul
)

rem ---- 3. window titles (start /min gives them these) ----
taskkill /T /F /FI "WINDOWTITLE eq ShouwenWatcher*" >nul 2>nul
taskkill /T /F /FI "WINDOWTITLE eq ShouwenServer*" >nul 2>nul

rem ---- 4. last resort: whatever still listens on 4321 ----
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4321" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>nul
)

rem ---- 5. tidy stale state files ----
if exist "data\wx-watch.lock" del /q "data\wx-watch.lock" >nul 2>nul
if exist "data\server.pid" del /q "data\server.pid" >nul 2>nul

echo   Stopped.
echo.
ping -n 4 127.0.0.1 >nul
exit /b 0
