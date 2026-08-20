@echo off
echo ==============================================================
echo 🚀 Deploying geteai.org
echo ==============================================================

if not exist "functions\.env" (
    echo ⚠️ WARNING: functions\.env not found!
    echo Your Cloud Functions may not have the OpenRouter API key.
    echo Please ensure the file exists before continuing.
    pause
)

echo.
echo 📡 Deploying Firestore Rules...
call firebase deploy --only firestore:rules --project geteai

echo.
echo ⚙️ Deploying Cloud Functions...
call firebase deploy --only functions --project geteai --force

echo.
echo 🌐 Deploying Hosting (public/)...
call firebase deploy --only hosting --project geteai

echo.
echo ✅ Deployment Complete!
echo Canonical files are in the public/ folder.
echo.
