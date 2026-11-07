@echo off
setlocal
cd /d "%~dp0"
set "HR_NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run
set "HR_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%HR_NODE%" goto run
echo Please install Node.js 24 first.
pause
exit /b 1
:run
"%HR_NODE%" server\restart.js
if errorlevel 1 (
  echo Could not restart the application. Please check the message above.
  pause
  exit /b 1
)
start "" http://localhost:3000/employees/1
