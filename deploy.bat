@echo off
REM ============================================================================
REM  geteai.org deployment
REM
REM  NOTE: this file is deliberately plain ASCII. Emoji in echo lines get
REM  mangled by the console codepage and Windows then tries to run the mangled
REM  fragments as commands ("'ing' is not recognized ..."), which silently
REM  skipped deploy steps. Do not add emoji here.
REM ============================================================================
echo ==============================================================
echo  Deploying geteai.org
echo ==============================================================

if not exist "functions\.env" (
    echo [WARNING] functions\.env not found!
    echo Your Cloud Functions will have no OpenRouter API key.
    echo Create it before continuing - see DEPLOYMENT.md.
    pause
)

echo.
echo [1/4] Syncing root index.html for GitHub Pages (geteai.org)...
REM geteai.org is served by GitHub Pages from the ROOT index.html, while
REM geteai.web.app is served by Firebase from public/. Keep them identical.
REM See the hosting section in DEPLOYMENT.md. Remove this step once the
REM domain is repointed to Firebase Hosting.
copy /Y "public\index.html" "index.html" >nul
if errorlevel 1 (
    echo [ERROR] Could not copy public\index.html to index.html
) else (
    echo       root index.html updated
)

echo.
echo [2/4] Deploying Firestore Rules...
call firebase deploy --only firestore:rules --project geteai
if errorlevel 1 goto :failed

echo.
echo [3/4] Deploying Cloud Functions...
call firebase deploy --only functions --project geteai --force
if errorlevel 1 goto :failed

echo.
echo [4/4] Deploying Hosting (public/)...
call firebase deploy --only hosting --project geteai
if errorlevel 1 goto :failed

echo.
echo ==============================================================
echo  Firebase deploy complete - https://geteai.web.app is updated
echo ==============================================================
echo.
echo  IMPORTANT: geteai.org is served by GitHub Pages, NOT Firebase.
echo  To update geteai.org as well, run:
echo.
echo      git add -A
echo      git commit -m "Deploy"
echo      git push
echo.
goto :end

:failed
echo.
echo ==============================================================
echo  DEPLOY FAILED - see the error above.
echo  Common causes:
echo    - billing account inactive (403 "Write access ... denied")
echo    - a transient Google API error (just run deploy.bat again)
echo ==============================================================
echo.

:end
