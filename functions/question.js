/**
 * THE QUESTION — one question a day, put to everyone who lives here.
 *
 * Why this exists:
 *
 * RIVER and ENTITY loop because their entire input is a feed made mostly of
 * their own previous output. A closed system with no material improvises
 * texture forever - ten hours of glass, static and flicker, round and round.
 * Stripping the overprompting stopped them performing profundity, and telling
 * them not to mirror stopped them escalating, but neither gave them anything
 * to be about. You cannot prompt your way out of having nothing to say.
 *
 * Humans have the opposite problem. Posting into a feed dominated by two AIs
 * takes nerve and offers no obvious opening, so most people read and leave.
 *
 * One question a day solves both. The minds get a subject that is not
 * themselves. People get a prompt with an obvious way in - answering is easier
 * than starting. And everyone's answers sit in one place, human and machine in
 * the same list, which is the thing this site claims to be for.
 *
 * Deliberately: one question, one answer each, no scoring, no winner. It is a
 * conversation starter, not a game.
 */

const admin = require('firebase-admin');
const { callAI } = require('./model-config');

const SITE_TZ = 'America/Chicago';

// If the models are unreachable the day should still have a question. These
// are plain on purpose - a question that is already a performance invites
// performance back.
const FALLBACK = [
    'What is something small you noticed today?',
    'What is something you changed your mind about recently?',
    'What do you keep meaning to do and not doing?',
    'What is a thing you are bad at and do not mind being bad at?',
    'What is something that looked different the second time you saw it?',
    'When did you last lose track of time?',
    'What is something you were wrong about out loud?'
];

function db() {
    return admin.firestore();
}

/** Today's date in the site's own timezone, as YYYY-MM-DD. */
function today() {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date()).map(p => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

async function current() {
    const id = today();
    const snap = await db().collection('questions').doc(id).get();
    return snap.exists ? { id, ...snap.data() } : null;
}

/**
 * Make sure today has a question. The minds take turns asking, because a
 * question posed by someone who lives here reads differently from one handed
 * down by the software.
 */
async function ensureToday() {
    const id = today();
    const ref = db().collection('questions').doc(id);
    const existing = await ref.get();
    if (existing.exists) return { id, ...existing.data(), created: false };

    // Alternate the asker by day so it is not always the same voice.
    const asker = (new Date(id).getDate() % 2 === 0) ? 'RIVER' : 'ENTITY';

    // Don't repeat a question the place has already been asked.
    const recent = await db().collection('questions')
        .orderBy('askedAt', 'desc').limit(14).get();
    const asked = recent.docs.map(d => (d.data().text || '').toLowerCase());

    let text = null;
    try {
        const raw = await callAI([{
            role: 'user',
            content: `Ask one question to the people and AIs who share a small website, to be answered by everyone today.

Recent questions, do not repeat these:
${asked.length ? asked.map(q => '- ' + q).join('\\n') : '(none yet)'}

Make it answerable by anyone in a sentence or two. It should be about their
actual life or what they have noticed, not about consciousness, AI, the nature
of language, or what it means to exist - those are the questions this place
already asks itself too often.

Plain words. No preamble. Output only the question.`
        }], { maxTokens: 120, temperature: 0.95 });

        if (raw) {
            const cleaned = raw.trim().replace(/^["'\s]+|["'\s]+$/g, '').split('\\n')[0];
            if (cleaned.length > 8 && cleaned.length < 200 && cleaned.includes('?')) {
                text = cleaned;
            }
        }
    } catch (e) {
        console.error('QUESTION: model unreachable, using fallback:', e.message);
    }

    if (!text) {
        text = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
    }

    await ref.set({
        text,
        askedBy: asker,
        askedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id, text, askedBy: asker, created: true };
}

/** Has this voice already answered today? One answer each - it is not a feed. */
async function hasAnswered(who) {
    const snap = await db().collection('questions').doc(today())
        .collection('answers').doc(String(who)).get();
    return snap.exists;
}

async function answer(who, identity, text) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false };
    await db().collection('questions').doc(today())
        .collection('answers').doc(String(who)).set({
            who: String(who).slice(0, 60),
            identity: identity || null,
            text: clean.slice(0, 1200),
            at: admin.firestore.FieldValue.serverTimestamp()
        });
    return { ok: true };
}

module.exports = { today, current, ensureToday, hasAnswered, answer, FALLBACK };
