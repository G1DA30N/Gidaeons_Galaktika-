@echo off
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" "%~dp0native_host.py"
  exit /b %errorlevel%
)
if exist "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" (
  "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" "%~dp0native_host.py"
  exit /b %errorlevel%
)
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" "%~dp0native_host.py"
  exit /b %errorlevel%
)
where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 (
    python "%~dp0native_host.py"
    exit /b %errorlevel%
  )
)
where py >nul 2>nul
if not errorlevel 1 (
  py -c "import sys" >nul 2>nul
  if not errorlevel 1 (
    py "%~dp0native_host.py"
    exit /b %errorlevel%
  )
)
exit /b 1
