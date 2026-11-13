@echo off
rem Removes Multimedia ^& AI Group from Premiere Pro.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
if errorlevel 1 pause
