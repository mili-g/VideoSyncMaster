@echo off
chcp 65001 > nul

rem --- 自动解压 Python 环境 ---
if exist "%~dp0python\python.exe" goto :SKIP_UNZIP
if not exist "%~dp0python.zip" goto :SKIP_UNZIP

echo ==========================================
echo [INFO] 检测到未解压的 Python 包
echo.
echo [1] 自动解压 (脚本自动处理，推荐)
echo [2] 手动解压 (您可以自己解压，适合高级用户，比自动处理快)
echo.
set /p choice=请输入选项 [1/2] (默认1): 
if "%choice%"=="2" goto :MANUAL_UNZIP

:AUTO_UNZIP
echo [INFO] 开始自动解压...
mkdir "%~dp0python" 2>nul
rem 检查是否有 tar 命令
tar --version >nul 2>&1
if errorlevel 1 goto :USE_POWERSHELL

:USE_TAR
echo [INFO] 使用快速解压 (tar)...
tar -xf "%~dp0python.zip" -C "%~dp0python"
if errorlevel 0 goto :UNZIP_DONE
echo [WARNING] tar 解压失败，尝试使用 PowerShell...

:USE_POWERSHELL
echo [INFO] 使用标准解压 (PowerShell)...
powershell -Command "Expand-Archive -Path '%~dp0python.zip' -DestinationPath '%~dp0python' -Force"
goto :UNZIP_DONE

:MANUAL_UNZIP
echo ==========================================
echo 请手动将 python.zip 解压到 python 文件夹。
echo 确保解压后的路径为: python\python.exe
echo ==========================================
echo 完成后请按任意键继续...
pause
if exist "%~dp0python\python.exe" goto :UNZIP_DONE
echo [ERROR] 未检测到 python.exe！请检查解压路径。
echo 请修正后按任意键重试...
pause
goto :MANUAL_UNZIP

:UNZIP_DONE
echo [INFO] Python 环境准备就绪。

:SKIP_UNZIP

echo(==========================================
echo(      VideoSync 一键启动器
echo(==========================================
echo ooooooooo.   ooooooooo.     .oooooo.              oooooooooo.    .oooooo..o 
echo `888   `Y88. `888   `Y88.  d8P'  `Y8b             `888'   `Y8b  d8P'    `Y8 
echo  888   .d88'  888   .d88' 888      888             888      888 Y88bo.      
echo  888ooo88P'   888ooo88P'  888      888             888      888  `"Y8888o.  
echo  888`88b.     888`88b.    888      888    8888888  888      888      `"Y88b 
echo  888  `88b.   888  `88b.  `88b    d88b             888     d88' oo     .d8P 
echo  o888o  o888o o888o  o888o  `Y8bood8P'Ybd'         o888bood8P'   8""88888P'  

echo(RRQ-DS优化与批量功能增强
echo(==========================================

set PATH=%~dp0python;%~dp0python\Scripts;%PATH%

rem --- 自动检测/下载 Node.js 环境 ---
echo [INFO] 检查 Node.js 环境...
node --version >nul 2>&1
if not errorlevel 1 goto :NODE_READY

if exist "%~dp0node-v22.16.0-x64.msi" goto :INSTALL_NODE_MSI

echo [WARNING] 未检测到 Node.js，且未找到安装包。
echo 请下载 Node.js v22.16.0 并安装。
echo 下载地址: https://npmmirror.com/mirrors/node/v22.16.0/node-v22.16.0-x64.msi
pause
exit /

:INSTALL_NODE_MSI
echo [INFO] 检测到 Node.js 安装包，正在启动安装向导...
echo [IMPORTANT] 请在弹出的安装窗口中完成安装 (一路点击 Next 即可)
echo.
start /wait msiexec /i "%~dp0node-v22.16.0-x64.msi"
echo.
echo [INFO] 安装过程已结束。
echo 请按任意键继续启动程序...
pause

rem 重新检测环境
node --version >nul 2>&1
if errorlevel 1 (
    echo [WARNING] 似乎未能识别到 Node.js 命令。
    echo 请尝试 关闭当前窗口 并 重新运行 start.bat 以加载新的环境变量。
    pause
    exit /b
)
goto :NODE_READY

:NODE_READY
echo [INFO] Node.js 就绪: 
node --version



rem echo [INFO] 检查 Python 依赖状态...
rem python "%~dp0backend\check_requirements.py" "%~dp0requirements.txt"
rem if errorlevel 1 (
rem     echo [INFO] 检测到缺失依赖，正在自动补全...
rem     python -m pip install -r "%~dp0requirements.txt"
rem )
cd ui

if not exist "node_modules" (
    echo [INFO] 检测到依赖缺失，正在安装...
    call npm install
)

echo [INFO] 正在启动开发服务器...
set RETRY_COUNT=0

:START_DEV
call npm run dev
if errorlevel 1 goto :CHECK_ERROR
goto :END

:CHECK_ERROR
if "%RETRY_COUNT%"=="1" goto :END

echo [WARNING] 服务器启动异常，正在尝试自动修复...
echo [INFO] 正在重新安装依赖 (npm install)...
call npm install
set RETRY_COUNT=1
echo [INFO] 正在重试启动...
goto :START_DEV

:END
pause
