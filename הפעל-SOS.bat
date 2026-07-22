@echo off
chcp 65001 >nul
title SOS - שרת מקומי
cd /d "%~dp0"

set PORT=8080
set URL=http://127.0.0.1:%PORT%/videos.html

echo.
echo  ========================================
echo   SOS - הפעלה מקומית
echo  ========================================
echo.
echo   תיקייה: %CD%
echo   כתובת:  %URL%
echo.
echo   לסגירה: סגרו חלון זה או לחצו Ctrl+C
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

echo [שגיאה] לא נמצא Python במחשב.
echo התקינו Python מ-https://www.python.org/downloads/
echo וסמנו "Add python.exe to PATH" בהתקנה.
echo.
pause
exit /b 1

:start
start "" "%URL%"
echo מפעיל שרת Python על פורט %PORT%...
echo.
%PY% -m http.server %PORT% --bind 127.0.0.1
if errorlevel 1 (
  echo.
  echo [שגיאה] לא ניתן להפעיל את השרת. ייתכן שהפורט %PORT% תפוס.
  pause
)
