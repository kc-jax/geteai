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
echo [0/3] Checking Firestore rules cover every collection the site reads...
REM A collection with no matching rule is denied by default, and the client
REM swallows the error - the page just renders empty forever. That silently
REM killed the //LOGS page for weeks. Cheap check, expensive bug.
call node scripts\check-rules.js
if errorlevel 1 (
    echo.
    echo ABORTING: fix firestore.rules before deploying.
    goto :end
)

echo.
echo [0b/3] Checking nothing calls a function that no longer exists...
REM c8589fa deleted ~700 lines from public/index.html and took the Construct's
REM whole command set with it. Deletions leave call sites pointing at nothing,
REM and in a browser that only fails when a user clicks - quietly, one feature
REM at a time, long after the commit looked fine.
call node scripts\check-calls.js
if errorlevel 1 (
    echo.
    echo ABORTING: a call has no definition.
    goto :end
)

echo.
echo [1/3] Deploying Firestore Rules...
call firebase deploy --only firestore:rules --project geteai
if errorlevel 1 goto :failed

echo.
echo [2/3] Deploying Cloud Functions...
call firebase deploy --only functions --project geteai --force
if errorlevel 1 goto :failed

echo.
echo [3/3] Deploying Hosting (public/)...
call firebase deploy --only hosting --project geteai
if errorlevel 1 goto :failed

echo.
echo ==============================================================
echo  Deploy complete - https://geteai.org is updated
echo ==============================================================
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
