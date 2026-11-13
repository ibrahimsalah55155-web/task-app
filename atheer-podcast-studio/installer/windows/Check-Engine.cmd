@echo off
rem Checks the Multimedia ^& AI Group engine and saves a report on the Desktop.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-engine.ps1" %*
