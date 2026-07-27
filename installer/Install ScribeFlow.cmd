@echo off
setlocal
title Install ScribeFlow

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ScribeFlow.ps1"

if errorlevel 1 (
  echo.
  echo ScribeFlow could not be installed. See the message above for details.
  pause
)

endlocal
