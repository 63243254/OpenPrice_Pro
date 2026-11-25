@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
  echo [OpenPrice Pro] 首次运行，正在安装依赖...
  call npm install
)

if not exist "dist\index.html" (
  echo [OpenPrice Pro] 正在构建网页版...
  call npm run build
)

echo [OpenPrice Pro] 正在启动网页版服务（内置每日 00:00 自动更新）...
start "" "http://localhost:8080"
node scripts\server.mjs
pause
