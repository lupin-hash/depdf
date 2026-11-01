@echo off
setlocal
cd /d "%~dp0"
title PDFCleaner - rebuild and install
if not exist gradlew.bat (
  echo ERROR: gradlew.bat not found. Keep SYNC.bat in the project folder ^(next to settings.gradle.kts^).
  pause
  exit /b 1
)

REM ---- Java ----
set "JAVA_OK="
for %%d in ("%ProgramFiles%\Android\Android Studio\jbr" "%LOCALAPPDATA%\Programs\Android Studio\jbr" "%ProgramFiles%\Android\Android Studio Preview\jbr") do (
  if exist "%%~d\bin\java.exe" if not defined JAVA_OK set "JAVA_HOME=%%~d" & set "JAVA_OK=studio"
)
if defined JAVA_OK set "PATH=%JAVA_HOME%\bin;%PATH%"
where java >nul 2>nul
if errorlevel 1 (
  echo ERROR: Java not found. Run SETUP.bat first.
  pause
  exit /b 1
)

REM ---- Android SDK ----
set "SDK="
if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools" set "SDK=%ANDROID_HOME%"
if not defined SDK if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools" set "SDK=%ANDROID_SDK_ROOT%"
if not defined SDK if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined SDK (
  echo ERROR: Android SDK not found. Run SETUP.bat first.
  pause
  exit /b 1
)
set "SDKP=%SDK:\=/%"
>local.properties echo sdk.dir=%SDKP%
set "PATH=%SDK%\platform-tools;%PATH%"

REM ---- Device? ----
set "DEVICE="
for /f "tokens=1,2" %%a in ('adb devices 2^>nul') do (
  if "%%b"=="device" set "DEVICE=%%a"
)

if defined DEVICE (
  echo Building and installing on %DEVICE%...
  call gradlew.bat installDebug --console=plain
) else (
  echo No phone/emulator connected - building the APK only...
  call gradlew.bat assembleDebug --console=plain
)
if errorlevel 1 (
  echo.
  echo *** Build failed. See the error above. ***
  pause
  exit /b 1
)

if exist "app\build\outputs\apk\debug\app-debug.apk" copy /y "app\build\outputs\apk\debug\app-debug.apk" "PDFCleaner-debug.apk" >nul

echo.
if defined DEVICE (
  adb -s %DEVICE% shell monkey -p com.pdfcleaner.app -c android.intent.category.LAUNCHER 1 >nul 2>nul
  echo Done. The updated app was installed and launched on your phone.
) else (
  echo Done. APK saved as: %CD%\PDFCleaner-debug.apk
  echo Plug in a phone with USB debugging on, then run SYNC.bat again to install it automatically.
)
pause
