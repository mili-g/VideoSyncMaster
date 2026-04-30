@echo off
setlocal

cd /d "%~dp0\..\.."
set "ROOT_DIR=%CD%"

set "PYTHON_DIR="
if exist "%ROOT_DIR%\runtime\python\python.exe" set "PYTHON_DIR=%ROOT_DIR%\runtime\python"
if not defined PYTHON_DIR if exist "%ROOT_DIR%\python\python.exe" set "PYTHON_DIR=%ROOT_DIR%\python"

if defined PYTHON_DIR (
    set "PATH=%PYTHON_DIR%;%PYTHON_DIR%\Scripts;%PATH%"
)

echo ==========================================
echo VideoSync Dev Launcher
echo Root: %ROOT_DIR%
echo ==========================================

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not available in PATH.
    echo [INFO] Install Node.js and run start.bat again.
    pause
    exit /b 1
)

echo [INFO] Node.js version:
node --version

if exist "%ROOT_DIR%\apps\desktop\ui" (
    cd /d "%ROOT_DIR%\apps\desktop\ui"
) else (
    echo [ERROR] UI directory not found.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing npm dependencies ...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [INFO] Starting development server ...
call npm run dev -- --host 127.0.0.1 --port 5173
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Development server exited with code %EXIT_CODE%.
)

pause
exit /b %EXIT_CODE%
