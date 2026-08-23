# 🚀 geteai.org Deployment & Operations Guide

## 📁 Project Structure

The single most important thing to remember: **The `public/` folder is production.**
- When you edit `public/index.html`, you are editing the live site.
- `deploy.bat` automatically pushes the contents of `public/` to Firebase Hosting.
- The root `index.html` is a **temporary copy** — see the hosting note below.

## 🌐 IMPORTANT: geteai.org and geteai.web.app are two different hosts

As of 2026-08-23 the site is served from **two** places, which has caused real
confusion (changes appeared to "not work" because the wrong host was tested):

| URL | Served by | Source |
|---|---|---|
| `geteai.web.app` | Firebase Hosting | `public/` (via `deploy.bat`) |
| `geteai.org` | **GitHub Pages** | root `index.html` (via `git push`) |

`geteai.org`'s DNS A records point at GitHub Pages (`185.199.108–111.153`),
not Firebase. So a `deploy.bat` run updates `geteai.web.app` but **not**
`geteai.org`. For a while `geteai.org` was serving a build from July 8.

**Until the domain is repointed, a full release is TWO steps:**
1. `deploy.bat` — updates Firebase (functions, rules, `geteai.web.app`)
2. `git add -A && git commit && git push` — updates `geteai.org`

`deploy.bat` copies `public/index.html` to the root `index.html` for you, so
you only need to commit and push afterwards. Never edit the root `index.html`
directly — it is overwritten every deploy.

### The permanent fix (recommended)
Point the domain at Firebase and drop the duplicate:
1. Firebase Console → Hosting → **Add custom domain** → `geteai.org`; follow
   the prompts (it gives you a TXT record to verify, then two A records).
2. At the DNS registrar, **replace** the GitHub Pages A records with the two
   A records Firebase provides.
3. In the GitHub repo: Settings → Pages → remove the custom domain, and delete
   the root `CNAME` file and root `index.html`.
4. Confirm `geteai.org` is in Firebase Console → Authentication → Settings →
   **Authorized domains**, or login will fail on that domain.

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

*Note: `.env` is ignored by git (`.gitignore`) **going forward**.*

> ### ⚠️ The current key is already public — rotate it
> `functions/.env` was committed to git **before** it was added to `.gitignore`.
> The old OpenRouter key is therefore still readable in this repo's history
> (commit `09f7d7c` and earlier, in `functions/.env`, `index.html`,
> `full_codebase.md`, `temp_live.html`, `temp_remote.html`) — and this repo is
> public. Deleting the files did **not** remove them from history.
>
> Because of that, the fix is to make the exposed key worthless:
> 1. Create a new key at <https://openrouter.ai/keys>.
> 2. **Delete the old key** on that same page.
> 3. Put the new key in `functions/.env` as `OPENROUTER_KEY`.
> 4. Run `deploy.bat`.
>
> Rewriting git history to scrub the old key is possible but risky and
> unnecessary once the key is deleted at OpenRouter.

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
