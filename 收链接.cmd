@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  收链接 —— 把剪贴板里的公众号链接收进「收文」
rem  用法：复制一段含公众号链接的文字（微信转发内容、聊天记录、
rem        公众号分享卡片…），双击本文件即可。
rem ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没找到 node，请先安装 Node.js 22 以上版本。
  echo.
  pause
  exit /b 1
)

node ingest-clip.cjs %*

echo.
echo 按任意键关闭…
pause >nul
endlocal
