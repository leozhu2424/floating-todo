@echo off
rem Double-click launcher: prefers the packaged exe, falls back to running from source.
cd /d "%~dp0"

if exist "dist\FloatingTodo\FloatingTodo.exe" (
    start "" "dist\FloatingTodo\FloatingTodo.exe"
    exit /b 0
)

if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
    exit /b 0
)

echo Electron is not installed. Run:  npm install
pause
