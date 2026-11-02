@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando pela primeira vez, aguarde...
  call npm install
)
start "" http://localhost:3737
node --disable-warning=ExperimentalWarning src/server.js
pause
