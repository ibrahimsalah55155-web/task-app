@echo off
rem Installs Multimedia ^& AI Group into Premiere Pro (no Creative Cloud app needed).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
