@echo off
setlocal

echo This will check system dependencies used by the Galaktika helper.
echo.

echo yt-dlp and the PO-token providers are installed into an isolated
echo environment by Install-Galaktika-Helper.cmd.

where ffmpeg >nul 2>nul
if %errorlevel%==0 (
  echo ffmpeg is already installed.
) else (
  echo Installing ffmpeg...
  winget install Gyan.FFmpeg
)

where deno >nul 2>nul
if %errorlevel%==0 (
  echo Deno is already installed.
) else if exist "C:\ytdl\deno.exe" (
  echo Deno is already installed at C:\ytdl\deno.exe.
) else (
  echo Installing Deno for YouTube token generation...
  winget install --id DenoLand.Deno -e
)

where py >nul 2>nul
if not errorlevel 1 (
  echo Python launcher is available.
) else (
  where python >nul 2>nul
  if not errorlevel 1 (
    echo Python is available.
  ) else (
    echo Python was not found. Install Python from https://www.python.org/downloads/ and enable "Add python.exe to PATH".
  )
)

echo.
echo Setup check complete.
pause
