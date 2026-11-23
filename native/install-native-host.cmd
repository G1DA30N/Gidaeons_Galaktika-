@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-native-host.ps1" %*
pause
