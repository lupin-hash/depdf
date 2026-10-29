@echo off
setlocal
cd /d "%~dp0"
title PDFCleaner - first-time setup
echo ============================================
echo  PDFCleaner - first-time local setup
echo ============================================
echo.

if not exist settings.gradle.kts goto :wrongfolder
if not exist gradlew.bat goto :wrongfolder

REM ---------- [1/5] Java (JDK 17+) ----------
echo [1/5] Looking for Java ^(JDK 17 or newer^)...
set "JAVA_OK="
for %%d in ("%ProgramFiles%\Android\Android Studio\jbr" "%LOCALAPPDATA%\Programs\Android Studio\jbr" "%ProgramFiles%\Android\Android Studio Preview\jbr") do (
  if exist "%%~d\bin\java.exe" if not defined JAVA_OK set "JAVA_HOME=%%~d" & set "JAVA_OK=studio"
)
if defined JAVA_OK goto :java_found
where java >nul 2>nul
if errorlevel 1 goto :nojava
set "JV="
set "JMAJOR="
for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /i "version"') do set "JV=%%~v"
for /f "tokens=1 delims=.-" %%a in ("%JV%") do set "JMAJOR=%%a"
if not defined JMAJOR goto :nojava
if %JMAJOR% LSS 17 goto :oldjava
set "JAVA_OK=system"
goto :java_done
:java_found
set "PATH=%JAVA_HOME%\bin;%PATH%"
echo Using the Java bundled with Android Studio.
goto :java_done
:nojava
echo ERROR: Java was not found. Install Android Studio from https://developer.android.com/studio
echo ^(it includes the right Java^), open it once, then run this again.
goto :fail
:oldjava
echo ERROR: Java %JMAJOR% found, but 17 or newer is required.
echo Install Android Studio ^(it includes Java 17+^) or a JDK 17 from https://adoptium.net then run this again.
goto :fail
:java_done

REM ---------- [2/5] Android SDK ----------
echo.
echo [2/5] Looking for the Android SDK...
set "SDK="
if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools" set "SDK=%ANDROID_HOME%"
if not defined SDK if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools" set "SDK=%ANDROID_SDK_ROOT%"
if not defined SDK if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined SDK if exist "%LOCALAPPDATA%\Android\Sdk" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined SDK goto :nosdk
echo Found: %SDK%
set "SDKP=%SDK:\=/%"
>local.properties echo sdk.dir=%SDKP%
set "PATH=%SDK%\platform-tools;%PATH%"

REM ---------- [3/5] Licenses ----------
echo.
echo [3/5] Accepting Android SDK licenses ^(best effort^)...
set "SDKM=%SDK%\cmdline-tools\latest\bin\sdkmanager.bat"
if exist "%SDKM%" goto :do_lic
echo sdkmanager not found - skipping. If the build complains about licenses or a missing
echo platform, open Android Studio ^> Settings ^> Android SDK and install "Android 15 ^(API 35^)"
echo and "Android SDK Command-line Tools".
goto :lic_done
:do_lic
(for /l %%i in (1,1,40) do @echo y) | "%SDKM%" --licenses >nul 2>nul
echo Done.
:lic_done

REM ---------- [4/5] Build ----------
echo.
echo [4/5] Building the app ^(first run downloads Gradle and Android libraries, this can take several minutes^)...
call gradlew.bat assembleDebug --console=plain
if errorlevel 1 goto :buildfail
if not exist "app\build\outputs\apk\debug\app-debug.apk" goto :buildfail
copy /y "app\build\outputs\apk\debug\app-debug.apk" "PDFCleaner-debug.apk" >nul
echo Built: %CD%\PDFCleaner-debug.apk

REM ---------- [5/5] Install on phone + open Android Studio ----------
echo.
echo [5/5] Looking for a connected phone or emulator...
set "DEVICE="
set "UNAUTH="
for /f "tokens=1,2" %%a in ('adb devices 2^>nul') do (
  if "%%b"=="device" set "DEVICE=%%a"
  if "%%b"=="unauthorized" set "UNAUTH=%%a"
)
if defined DEVICE goto :install
if defined UNAUTH echo A device is connected but not authorized. Unlock it and tap "Allow USB debugging".
echo No device found. You can copy PDFCleaner-debug.apk to your phone and open it,
echo or plug in a phone with USB debugging on and run SYNC.bat.
goto :studio
:install
echo Installing on %DEVICE%...
adb -s %DEVICE% install -r "PDFCleaner-debug.apk"
if errorlevel 1 goto :studio
adb -s %DEVICE% shell monkey -p com.pdfcleaner.app -c android.intent.category.LAUNCHER 1 >nul 2>nul
echo Installed and launched.

:studio
echo.
set "STUDIO="
if exist "%ProgramFiles%\Android\Android Studio\bin\studio64.exe" set "STUDIO=%ProgramFiles%\Android\Android Studio\bin\studio64.exe"
if not defined STUDIO if exist "%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe" set "STUDIO=%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe"
echo ============================================
echo  SUCCESS.
echo ============================================
if not defined STUDIO goto :nostudio
echo Opening the project in Android Studio...
start "" "%STUDIO%" "%CD%"
goto :end
:nostudio
echo To open it in Android Studio: File ^> Open ^> select this folder.
:end
echo.
echo After you edit files, run SYNC.bat to rebuild and reinstall.
pause
exit /b 0

:wrongfolder
echo ERROR: settings.gradle.kts / gradlew.bat not found here.
echo Put SETUP.bat and SYNC.bat in the SAME folder as settings.gradle.kts.
goto :fail

:nosdk
echo ERROR: Android SDK not found. Install Android Studio from https://developer.android.com/studio,
echo open it once so it downloads the SDK, then run this again.
goto :fail

:buildfail
echo.
echo *** The build failed. Read the error above. ***
echo Common fixes: check your internet connection ^(first build downloads files^), and in
echo Android Studio ^> Settings ^> Android SDK install "Android 15 ^(API 35^)".

:fail
echo.
echo *** Setup stopped because of the error above. ***
pause
exit /b 1
