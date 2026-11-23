@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\Update-Galaktika-Dependencies.ps1" %*
exit /b %errorlevel%
