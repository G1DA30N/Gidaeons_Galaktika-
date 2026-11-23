@echo off
setlocal
set HOST_NAME=gidaeons_galaktika_host
set FIREFOX_HOST=%APPDATA%\Mozilla\NativeMessagingHosts\%HOST_NAME%.json
if exist "%FIREFOX_HOST%" del "%FIREFOX_HOST%"
reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
for %%B in (Thorium Chromium Chrome Edge) do (
  if exist "%LOCALAPPDATA%\GidaeonsGalaktika\NativeMessagingHosts\%%B\%HOST_NAME%.json" del "%LOCALAPPDATA%\GidaeonsGalaktika\NativeMessagingHosts\%%B\%HOST_NAME%.json"
)
reg delete "HKCU\Software\Thorium\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
echo Removed Galaktika native messaging host registrations.
pause
