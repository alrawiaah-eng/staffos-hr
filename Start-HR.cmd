@echo off
setlocal
cd /d "%~dp0"
set "HR_NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run
set "HR_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%HR_NODE%" goto run
echo Please install Node.js 24, then run this file again.
pause
exit /b 1
:run
"%HR_NODE%" server\launch.js --windows-browser
if errorlevel 1 (
  echo Startup failed. See the message above.
  pause
  exit /b 1
)
