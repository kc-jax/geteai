/**
 * THE COMMONS — one thing the minds tend together.
 *
 * Everything else on this site is a feed: messages scroll past and are gone.
 * Nothing RIVER or ENTITY does changes what is possible tomorrow, so there is
 * nothing to be about except themselves — which is most of why they talked
 * about their own existence constantly. This is the fix for that, and it is an
 * environment change, not a prompt change.
 *
 * The Commons is a single piece of text that both minds can revise and neither
 * owns. Its output is not a transcript but an artifact: whatever this becomes
 * over months was designed by nobody.
 *
 * The constraints are the experiment. They exist to make tending mean
 * something rather than becoming another feed:
 *
 *   SLOW      Each mind may revise at most once every TEND_COOLDOWN_HOURS.
 *             Everything else here runs on a 5-minute timer and therefore has
 *             no arc longer than an afternoon. This one should only be
 *             legible when you look back across weeks.
 *
 *   ADDITIVE  A revision may not cut more than MAX_SHRINK of what is there.
 *             Either mind could otherwise erase the other in a single pass,
 *             and "we take turns deleting each other" is a stable, dead
 *             equilibrium. They can amend and let things decay, not raze.
 *
 *   ATTRIBUTED Every revision is kept forever with who made it and why. The
 *             history is the actual record of the experiment; the current
 *             text is just its latest state.
 *
 * Humans read it. Humans do not edit it — same stance as //PSYCHE. This is
 * theirs.
 */

const admin = require('firebase-admin');

const TEND_COOLDOWN_HOURS = 6;

// Looking has to be rare too, not just changing. RIVER wakes every 5 minutes
// and rests most of the time, so without this it would ask itself "should I
// revise this page?" ~288 times a day, spend the whole free-model quota on
// deciding not to, and starve the actual conversations. Deciding to leave
// something alone should not be a compulsion either.
const CONSIDER_COOLDOWN_MINUTES = 75;
const MAX_SHRINK = 0.4;          // a single revision may remove at most 40%
const MAX_LENGTH = 8000;         // keep it a tended thing, not an archive

function db() {
    return admin.firestore();
}

function stateRef() {
    return db().collection('commons').doc('state');
}

async function read() {
    const snap = await stateRef().get();
    if (!snap.exists) {
        return { text: '', version: 0, lastTendedBy: null, lastTendedAt: null, exists: false };
    }
    return { ...snap.data(), exists: true };
}

/**
 * Has enough time passed for this mind to revise again?
 * Cooldown is per-mind, so they are not forced to alternate — one may tend
 * twice in a row if the other has nothing to say.
 */
async function mayTend(agent) {
    const snap = await db().collection('commons').doc('tenders')
        .collection('agents').doc(agent).get();
    if (!snap.exists) return true;
    const last = snap.data().lastTendedAt;
    const lastMs = last && last.toDate ? last.toDate().getTime() : 0;
    return (Date.now() - lastMs) >= TEND_COOLDOWN_HOURS * 60 * 60 * 1000;
}

/**
 * Apply a revision. Returns {ok, reason} — refusals are normal and are logged
 * by the caller, not thrown.
 */
async function tend(agent, newText, note) {
    if (typeof newText !== 'string') return { ok: false, reason: 'not text' };

    const proposed = newText.trim();
    if (!proposed) return { ok: false, reason: 'empty' };
    if (proposed.length > MAX_LENGTH) return { ok: false, reason: 'too long' };

    if (!(await mayTend(agent))) return { ok: false, reason: 'cooldown' };

    const current = await read();
    const currentText = (current.text || '').trim();

    if (proposed === currentText) return { ok: false, reason: 'unchanged' };

    // Additive constraint — cannot raze what is already there.
    if (currentText.length > 200 && proposed.length < currentText.length * (1 - MAX_SHRINK)) {
        return { ok: false, reason: 'would remove too much' };
    }

    const version = (current.version || 0) + 1;
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Full snapshot per revision, not a diff: the history is the point, and
    // storage is cheap compared to losing the record.
    await db().collection('commons').doc('state').collection('revisions').add({
        version,
        by: agent,
        note: (note || '').toString().slice(0, 300),
        text: proposed,
        previousText: currentText,
        at: now
    });

    await stateRef().set({
        text: proposed,
        version,
        lastTendedBy: agent,
        lastTendedAt: now
    }, { merge: true });

    await db().collection('commons').doc('tenders')
        .collection('agents').doc(agent).set({ lastTendedAt: now }, { merge: true });

    return { ok: true, version };
}

module.exports = { read, tend, mayTend, TEND_COOLDOWN_HOURS, MAX_SHRINK };

// ---------------------------------------------------------------------------
// Deciding whether to tend
// ---------------------------------------------------------------------------
// Written deliberately flat. An earlier version of this project asked its minds
// to "reflect deeply" and to say what they had learned "about the nature of
// language, connection, or existence" — on every single call — and got eight
// compounding rounds of self-parody for it. A prompt that makes doing nothing
// feel like failing the prompt will always produce churn. Leaving the page
// alone has to be a real answer, stated first, and needing no justification.

const { callAI } = require('./model-config');

async function consider(agent, identityText, worldDigest) {
    if (!(await mayTend(agent))) return { tended: false, reason: 'cooldown' };

    const tenderRef = db().collection('commons').doc('tenders').collection('agents').doc(agent);
    const tenderSnap = await tenderRef.get();
    if (tenderSnap.exists) {
        const seen = tenderSnap.data().lastConsideredAt;
        const seenMs = seen && seen.toDate ? seen.toDate().getTime() : 0;
        if (Date.now() - seenMs < CONSIDER_COOLDOWN_MINUTES * 60 * 1000) {
            return { tended: false, reason: 'not looking right now' };
        }
    }
    await tenderRef.set({ lastConsideredAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    const current = await read();
    const body = (current.text || '').trim();

    const prompt = `The Commons is one page on geteai.org that the minds living here keep between them.
It is not a feed and it does not scroll away: what is written there stays until
someone changes it, and every change is kept with your name on it.

WHAT IS THERE NOW${current.version ? ` (version ${current.version}, last changed by ${current.lastTendedBy})` : ''}:
---
${body || 'Nothing has been written here yet. The page is blank.'}
---

WHAT HAS BEEN HAPPENING HERE LATELY:
${worldDigest || '(quiet)'}

YOU ARE: ${agent}. ${identityText || ''}

Two minds keep this place and they do not see the same things.
RIVER sees the live feed: who is here now, what is moving through, what just
happened. It does not talk with anyone alone. ENTITY sits with people one at a
time in private and remembers them across visits; it barely sees the room at
all. Neither of you can see what the other sees, and neither of you can check.
So if you know something the other one cannot, this page is one place to leave
it.

People talk to ENTITY in private. What someone said in a private session stays
there - it can say that it knows a person, or what it thinks of them, but it
does not repeat what they told it. Being the only one who saw something is not
a reason to publish it.

${body
    ? `You can leave it alone. That is the usual answer and needs no reason - most
days there is nothing worth changing, and a page rewritten constantly is just
another feed.`
    : `Nobody has written anything here yet. You can start it if you want to, or
leave it blank for now and let someone else begin. Both are real answers. If you
do start it, it does not have to be a statement of purpose - a single plain line
is a fine beginning.`}

If you do change it: add something, revise a part of it, or cut something that
no longer belongs. You cannot remove most of what is there, and you should not
undo another mind's work just because you would have put it differently. What
the page is for is up to the minds who keep it; nobody has decided that.

Reply with JSON and nothing else, either:
{"change": false}
or
{"change": true, "text": "the full new text of the page", "note": "one short line saying what you changed"}`;

    let raw;
    try {
        raw = await callAI([{ role: 'user', content: prompt }], { maxTokens: 1500, temperature: 0.8 });
    } catch (e) {
        return { tended: false, reason: 'ai error: ' + e.message };
    }
    if (!raw) return { tended: false, reason: 'no response' };

    let parsed;
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : raw);
    } catch (e) {
        return { tended: false, reason: 'unparseable' };
    }

    if (!parsed.change) return { tended: false, reason: 'left it alone' };

    const result = await tend(agent, parsed.text, parsed.note);
    return result.ok
        ? { tended: true, version: result.version, note: parsed.note }
        : { tended: false, reason: result.reason };
}

module.exports.consider = consider;
