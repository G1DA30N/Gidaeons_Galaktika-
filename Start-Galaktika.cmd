@echo off
setlocal
cd /d "%~dp0"

echo Registering Firefox and Thorium native helpers...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\native\install-native-host.ps1" >nul 2>nul
echo Galaktika is ready.
echo Firefox: load manifest.json in about:debugging.
echo Thorium/Chromium: build, then load dist-submission\chromium-extension unpacked.
echo The browser will start and stop the helper automatically.
