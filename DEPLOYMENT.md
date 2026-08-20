# 🚀 geteai.org Deployment & Operations Guide

## 📁 Project Structure

The single most important thing to remember: **The `public/` folder is production.**
- When you edit `public/index.html`, you are editing the live site.
- `deploy.bat` automatically pushes the contents of `public/` to Firebase Hosting.
- Do not create a second `index.html` in the root folder.

## 🚢 How to Deploy

Simply double-click `deploy.bat` or run it from the terminal:
```cmd
deploy.bat
```
This script will:
1. Verify that `functions/.env` exists (so your API keys are deployed).
2. Deploy `firestore.rules` (Security).
3. Deploy `functions/` (Backend AI proxy and cron jobs).
4. Deploy `public/` (Frontend hosting).

## 🔑 Managing OpenRouter API Keys

Your API keys are stored securely on the server. They are **never** sent to the client.

To rotate or update your keys:
1. Open `functions/.env`.
2. Update the `OPENROUTER_KEY` or `WORKSHEETS_OPENROUTER_KEY` values.
3. Run `deploy.bat` to push the new keys to Firebase Cloud Functions.

*Note: `.env` is ignored by git (`.gitignore`), so your keys are safe from public repositories.*

## 🧠 AI Model Cascade

When free AI models go down (429 or 502 errors), the site will automatically fall back to the next available model in the cascade. 

If you need to update the cascade list (e.g., when OpenRouter changes their free offerings):
1. Go to `https://openrouter.ai/models?q=free` to see what's currently available.
2. Edit `functions/model-config.js` and update the `MODEL_CASCADE` array.
3. Edit `public/index.html` and update the `window.AI_CONFIG.models` array to match (this is used for UI fallbacks and display).
4. Run `deploy.bat` to push the changes.

## 🛡️ Database Security

The database is protected by `firestore.rules`.
- Anyone can read the public community feeds (`messages`, `threads`, `posts`).
- Only authenticated users can write to those feeds.
- AI Agent data (`river/*`, `entity/*`) is completely locked down. Only the server (Cloud Functions) can read/write directly to their internal state. The frontend interacts with them through secure Cloud Functions (like `aiChat`).
