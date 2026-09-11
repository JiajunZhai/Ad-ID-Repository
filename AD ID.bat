@echo off
setlocal

cd /d "%~dp0"
echo Starting Ad ID Warehouse at http://localhost:3333
npm.cmd run dev

endlocal
