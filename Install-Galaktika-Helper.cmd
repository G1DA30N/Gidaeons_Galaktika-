@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\Install-Galaktika-Helper.ps1" %*
