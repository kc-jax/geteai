/**
 * VIBE-CODED PAGES — you describe a page, a model writes it, it gets a
 * permanent link, and it runs sandboxed.
 *
 * THE SECURITY MODEL IS THE WHOLE DESIGN. Read this before changing anything.
 *
 * This feature serves HTML and JavaScript written by one visitor to every
 * other visitor. That is the classic shape of a stored-XSS hole, and this site
 * has logged-in accounts, so the prize for exploiting it is other people's
 * sessions. You cannot prompt your way out of that: the page author controls
 * the prompt, so any rule like "do not generate malicious code" is a rule the
 * attacker is holding the pen on.
 *
 * So the containment is structural, not linguistic:
 *
 *   1. Generated pages are NEVER injected into the main document. They render
 *      only inside <iframe sandbox="allow-scripts"> with srcdoc, in page.html.
 *   2. That sandbox deliberately does NOT include allow-same-origin. Without
 *      it the frame gets an opaque origin: no access to geteai.org's DOM,
 *      localStorage, cookies or Firestore session. Adding allow-same-origin
 *      alongside allow-scripts would silently defeat the entire sandbox — if
 *      you are ever tempted, don't.
 *   3. Writes to `pages` are server-only in the rules, so nobody can skip
 *      generation and put arbitrary markup in the collection directly.
 *   4. Authorship is recorded, so anything abusive is attributable.
 *
 * The prompt below asks for self-contained HTML. That is for quality, not
 * safety — treat every byte it returns as hostile anyway, because a user wrote
 * the instructions that produced it.
 */

const admin = require('firebase-admin');
const { callAI } = require('./model-config');

const MAX_HTML = 60000;
const MAX_PROMPT = 2000;

function db() {
    return admin.firestore();
}

const SYSTEM = `You write small self-contained web pages.

Output ONE complete HTML document and nothing else. No markdown fences, no
commentary before or after. Start at <!DOCTYPE html> and end at </html>.

Rules:
- Everything inline: one <style> block, one <script> block if you need it.
- No external files, no CDN links, no frameworks, no fonts fetched over the
  network, no fetch/XHR to anywhere. It must work with no network at all.
- It will run inside a sandboxed frame with no access to any account or
  storage. Do not write anything that expects cookies, localStorage or a
  logged-in user; localStorage will throw if you touch it.
- Make it look deliberate. This is someone's page, not a demo.`;

async function generate({ prompt, title, username }) {
    const cleanPrompt = String(prompt || '').slice(0, MAX_PROMPT).trim();
    if (!cleanPrompt) return { ok: false, error: 'describe the page you want' };

    const raw = await callAI([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Make a page: ${cleanPrompt}` }
    ], { maxTokens: 6000, temperature: 0.9 });

    if (!raw) return { ok: false, error: 'the models are busy — try again in a minute' };

    // Models wrap things in fences no matter how firmly you ask them not to.
    let html = raw.trim()
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();

    const start = html.search(/<!DOCTYPE|<html/i);
    if (start > 0) html = html.slice(start);
    if (!/<html[\s>]/i.test(html)) {
        // Some models return a bare fragment; wrap it rather than failing.
        html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
    }
    if (html.length > MAX_HTML) return { ok: false, error: 'that came out too large — try something simpler' };

    const ref = db().collection('pages').doc();
    await ref.set({
        id: ref.id,
        title: String(title || '').slice(0, 120).trim() || 'untitled',
        prompt: cleanPrompt,
        html,
        owner: username || 'anonymous',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { ok: true, id: ref.id };
}

module.exports = { generate };
