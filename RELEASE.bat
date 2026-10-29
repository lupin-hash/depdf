@echo off
setlocal
cd /d "%~dp0"
title PDFCleaner - publish a new version
echo ============================================
echo  PDFCleaner - publish a new version
echo ============================================
echo.
echo This creates a GitHub release. GitHub builds the APK and attaches it, and
echo installed apps will show "Update available" the next time they check.
echo.

if not exist .git goto :norepo
where git >nul 2>nul
if errorlevel 1 goto :nogit

set "LAST="
for /f "delims=" %%i in ('git describe --tags --abbrev^=0 2^>nul') do set "LAST=%%i"
if defined LAST echo Latest published version: %LAST%
echo.
set "VER="
set /p "VER=New version number (for example 1.1): "
if not defined VER goto :nover
set "VER=%VER:v=%"
echo %VER%| findstr /r "^[0-9][0-9]*\.[0-9][0-9.]*[0-9]$" >nul
if errorlevel 1 goto :badver
git rev-parse "v%VER%" >nul 2>nul
if not errorlevel 1 goto :exists

echo.
echo Saving and uploading your latest changes first...
git add -A
set "CHANGED="
for /f %%i in ('git status --porcelain') do set "CHANGED=1"
if defined CHANGED git commit -m "Release v%VER%"
git branch -M main
git push -u origin main
if errorlevel 1 goto :fail

echo.
echo Publishing v%VER%...
git tag "v%VER%"
git push origin "v%VER%"
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  DONE. GitHub is now building version %VER%.
echo ============================================
echo It takes about 3 to 6 minutes. Watch the "Actions" tab on your repository.
echo When it turns green, the release appears under "Releases".
pause
exit /b 0

:norepo
echo ERROR: This folder is not on GitHub yet. Run GITHUB.bat first.
goto :fail
:nogit
echo ERROR: Git is not installed. See GITHUB_GUIDE.md.
goto :fail
:nover
echo ERROR: No version entered.
goto :fail
:badver
echo ERROR: Use numbers separated by dots, for example 1.1 or 2.0.3
goto :fail
:exists
echo ERROR: Version v%VER% already exists. Pick a higher number.

:fail
echo.
echo *** Stopped because of the error above. ***
pause
exit /b 1
