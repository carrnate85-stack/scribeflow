@echo off
setlocal
title ScribeFlow Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-scribeflow.ps1"

if errorlevel 1 (
  echo.
  echo ScribeFlow could not be started. See the message above for details.
  pause
)

endlocal
