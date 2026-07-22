@echo off
chcp 65001 >nul
title SOS - Local Server
cd /d "%~dp0"

set PORT=8080
set URL=http://127.0.0.1:%PORT%/videos.html

echo.
echo  ========================================
echo   SOS - Local Server
echo  ========================================
echo.
echo   Folder: %CD%
echo   URL:    %URL%
echo.
echo   To stop: close this window or Ctrl+C
echo  ========================================
echo.

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  set PY=python
  goto :start
)

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  set PY=py -3
  goto :start
)

echo [ERROR] Python was not found.
echo Install from https://www.python.org/downloads/
echo and check "Add python.exe to PATH".
echo.
pause
exit /b 1

:start
start "" "%URL%"
echo Starting Python server on port %PORT%...
echo.
%PY% -m http.server %PORT% --bind 127.0.0.1
if errorlevel 1 (
  echo.
  echo [ERROR] Could not start server. Port %PORT% may be in use.
  pause
)
