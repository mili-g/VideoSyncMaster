@echo off
if "%~1"=="-h" (
  echo SoX v14.4.2 shim
  exit /b 0
)
echo SoX shim: external command execution is not supported in this bundle.
exit /b 0
