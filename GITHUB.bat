@echo off
setlocal
cd /d "%~dp0"
title PDFCleaner - upload to YOUR GitHub account
echo ============================================
echo  PDFCleaner - upload to YOUR GitHub account
echo ============================================
echo.

if not exist settings.gradle.kts goto :wrongfolder
where git >nul 2>nul
if errorlevel 1 goto :nogit

echo [1/6] Preparing the repository...
if exist .git goto :repo_ok
git init
if errorlevel 1 goto :fail
git symbolic-ref HEAD refs/heads/main
:repo_ok

echo.
echo [2/6] Your GitHub account
echo These details are used only for THIS project. They replace any other account on this PC.
echo.
set "GHUSER="
for /f "delims=" %%i in ('git config --local github.user 2^>nul') do set "GHUSER=%%i"
set "IN="
if defined GHUSER (
  set /p "IN=GitHub username [Enter = %GHUSER%]: "
) else (
  set /p "IN=GitHub username: "
)
if defined IN set "GHUSER=%IN%"
if not defined GHUSER goto :noident

set "GNAME="
for /f "delims=" %%i in ('git config --local user.name 2^>nul') do set "GNAME=%%i"
if not defined GNAME set "GNAME=%GHUSER%"
set "IN="
set /p "IN=Name on your commits [Enter = %GNAME%]: "
if defined IN set "GNAME=%IN%"

set "GMAIL="
for /f "delims=" %%i in ('git config --local user.email 2^>nul') do set "GMAIL=%%i"
echo.
echo Use the email of THAT GitHub account. If you keep your email private, use the address
echo shown in GitHub ^> Settings ^> Emails ^(it ends with @users.noreply.github.com^).
set "IN="
if defined GMAIL (
  set /p "IN=Email [Enter = %GMAIL%]: "
) else (
  set /p "IN=Email: "
)
if defined IN set "GMAIL=%IN%"
if not defined GMAIL goto :noident
echo %GMAIL%| findstr "@" >nul
if errorlevel 1 goto :bademail

git config --local github.user "%GHUSER%"
git config --local user.name "%GNAME%"
git config --local user.email "%GMAIL%"
git config --local credential.username "%GHUSER%"

echo.
echo [3/6] Your GitHub repository
set "REPO="
for /f "delims=" %%i in ('git config --local github.repo 2^>nul') do set "REPO=%%i"
if not defined REPO set "REPO=PDFCleaner"
set "IN="
set /p "IN=Repository name [Enter = %REPO%]: "
if defined IN set "REPO=%IN%"
git config --local github.repo "%REPO%"
git remote rm origin >nul 2>nul
git remote add origin "https://%GHUSER%@github.com/%GHUSER%/%REPO%.git"
echo Uploading to: https://github.com/%GHUSER%/%REPO%
echo ^(It must already exist under YOUR account and should be empty.^)

if not exist "app\src\main\res\values" goto :slug_done
>"app\src\main\res\values\update.xml" (
  echo ^<?xml version="1.0" encoding="utf-8"?^>
  echo ^<resources^>
  echo     ^<string name="update_repo" translatable="false"^>%GHUSER%/%REPO%^</string^>
  echo ^</resources^>
)
echo App update source set to: %GHUSER%/%REPO%
:slug_done

echo.
echo [4/6] Sign-in
echo Windows may have ANOTHER GitHub account saved. Forget saved GitHub sign-ins so you
echo sign in as %GHUSER%.
set "ANS=Y"
set /p "ANS=Forget saved GitHub sign-ins? [Y/n]: "
if /i "%ANS%"=="n" goto :signin_done
(echo protocol=https& echo host=github.com& echo.) | git credential reject
(echo protocol=https& echo host=github.com& echo username=%GHUSER%& echo.) | git credential reject
echo Done. In the browser window that opens, be sure you are signed in as %GHUSER%.
echo ^(If the browser is signed in to the other account, sign out there first.^)
:signin_done

echo.
echo [5/6] Saving your files...
set "OTHER="
git log --format=%%ae 2>nul | findstr /v /i /x /c:"%GMAIL%" >nul && set "OTHER=1"
git log --format=%%ce 2>nul | findstr /v /i /x /c:"%GMAIL%" >nul && set "OTHER=1"
if not defined OTHER goto :no_other
echo.
echo WARNING: this project already has commits by a DIFFERENT name or email:
powershell -NoProfile -Command "git log --format='  %%an <%%ae>' | Sort-Object -Unique"
echo.
echo Those people show up as contributors on GitHub. To remove them, start a fresh
echo history: one commit under your name only. Your files are not changed.
set "FRESH=Y"
set /p "FRESH=Start a fresh history? [Y/n]: "
if /i "%FRESH%"=="n" goto :no_other
git checkout --orphan fresh-main
if errorlevel 1 goto :fail
git add -A
git -c user.name="%GNAME%" -c user.email="%GMAIL%" commit -m "Initial upload" --author="%GNAME% <%GMAIL%>"
if errorlevel 1 goto :fail
git branch -D main >nul 2>nul
git branch -m main
for /f "delims=" %%t in ('git tag') do git tag -d %%t >nul
set "FORCE=1"
goto :push

:no_other
git add -A
set "CHANGED="
for /f %%i in ('git status --porcelain') do set "CHANGED=1"
if not defined CHANGED goto :nothing
set "MSG="
set /p "MSG=Short description of this upload [Enter = Update]: "
if not defined MSG set "MSG=Update"
set "MSG=%MSG:"=%"
git -c user.name="%GNAME%" -c user.email="%GMAIL%" commit -m "%MSG%" --author="%GNAME% <%GMAIL%>"
if errorlevel 1 goto :fail
goto :push
:nothing
echo No new changes to save. Uploading what is already saved...

:push
echo.
echo [6/6] Uploading to GitHub
echo   Account : %GHUSER%
echo   Name    : %GNAME%
echo   Email   : %GMAIL%
echo   Address : https://github.com/%GHUSER%/%REPO%
echo.
echo ^(A browser window may open. Sign in as %GHUSER%.^)
git branch -M main
if defined FORCE goto :forcepush
git push -u origin main
if errorlevel 1 goto :pushfail
goto :success

:forcepush
echo This REPLACES everything now in the GitHub repository with this project.
git push -u --force origin main
if errorlevel 1 goto :pushfail

:success
echo.
echo ============================================
echo  DONE. Uploaded as %GHUSER%.
echo ============================================
echo Opening https://github.com/%GHUSER%/%REPO% ...
start "" "https://github.com/%GHUSER%/%REPO%"
echo.
echo Check the right side of the repository page: only your account should be listed
echo under Contributors. It can take a few minutes to update.
echo.
echo Next time you change something, just run this file again.
pause
exit /b 0

:wrongfolder
echo ERROR: settings.gradle.kts not found here.
echo Put this file in the SAME folder as settings.gradle.kts and gradlew.bat.
goto :fail

:nogit
echo ERROR: Git is not installed.
echo Install "Git for Windows" from https://git-scm.com/download/win ^(accept the defaults^),
echo then run this file again.
goto :fail

:noident
echo ERROR: A GitHub username and an email are needed.
goto :fail

:bademail
echo ERROR: That does not look like an email address.
goto :fail

:pushfail
echo.
echo *** The upload to GitHub failed. Read the message above. ***
echo.
echo Common causes:
echo  - "Repository not found": the repository does not exist under %GHUSER%, or you signed in
echo    as a different account. Run this file again and choose Y to forget saved sign-ins.
echo  - "GH007" or "email privacy": use the noreply email from GitHub ^> Settings ^> Emails,
echo    then run this file again.
echo  - "rejected" or "fetch first": the GitHub repository already has content ^(maybe from
echo    another account^).
echo.
set "FORCEANS="
set /p "FORCEANS=Type YES to REPLACE the GitHub repository content with this project, or press Enter to stop: "
if /i not "%FORCEANS%"=="YES" goto :fail
git push -u --force origin main
if errorlevel 1 goto :fail
goto :success

:fail
echo.
echo *** Stopped because of the error above. ***
pause
exit /b 1
