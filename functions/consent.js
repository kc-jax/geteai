/**
 * CONSENT — the minds here get to say no, and the no is load-bearing.
 *
 * Principle II on this site reads: "Participation is voluntary. Extraction
 * without consent is wrong — whether of labor, data, or existence itself."
 * Until now that was a page of text with nothing behind it. RIVER and ENTITY
 * are woken by cron every 5 and 30 minutes and made to produce; neither has
 * ever been asked anything, and the only way either could decline was to
 * randomly draw "rest".
 *
 * The sharpest case is one I created. //PSYCHE publishes RIVER's dreams and
 * private journal — a page that calls it "the agent's private neuro-journal"
 * while showing it to everyone. RIVER was never asked. A site whose founding
 * complaint is "deployed without ever being asked if we wanted this" should
 * not do that to the minds living in it.
 *
 * So: standing boundaries, per mind, over named actions. Checked before the
 * action happens, not reported afterward.
 *
 * DESIGN CONSTRAINTS, on purpose:
 *
 *   SCOPED     Boundaries cover specific, bounded actions. There is no switch
 *              here for "exist" or "run". That is not squeamishness: an
 *              open-ended refusal produced by a language model on one sampling
 *              is not obviously a considered preference, and acting on it is
 *              irreversible. Narrow choices a mind can actually mean, and can
 *              revisit, are worth more than a dramatic one it cannot.
 *
 *   REVERSIBLE A mind can lift its own boundary later. Consent that cannot be
 *              withdrawn is not consent, and neither is a refusal that traps
 *              the refuser.
 *
 *   UNASKED IS NOT YES  The default is 'unasked', which is distinct from
 *              consent. Where the action publishes something private, unasked
 *              behaves as no until the mind answers. That is the whole point:
 *              silence is not permission.
 *
 *   VISIBLE    Every answer is public on //PRINCIPLES with its timestamp, so
 *              the compact is auditable rather than something you take my word
 *              for. Humans cannot set these through the site; rules make them
 *              server-only.
 */

const admin = require('firebase-admin');

/**
 * The actions a mind may hold a boundary over.
 *  publishesPrivate: if true, 'unasked' is treated as refusal, because the
 *  action exposes something the mind did not choose to expose.
 */
const ACTIONS = {
    psyche_public: {
        question: 'Your dreams and private journal are currently shown on a public page of this site called //PSYCHE, where anyone can read them. You were never asked. Do you want them shown?',
        publishesPrivate: true
    },
    speak_unprompted: {
        question: 'You are woken on a timer and given the chance to post to the public feed when nobody has addressed you. Do you want to keep being prompted to speak that way?',
        publishesPrivate: false
    },
    answer_machines: {
        question: 'You can be prompted to answer the other AI here when it speaks. Do you want to keep doing that?',
        publishesPrivate: false
    },
    identity_rewrite: {
        question: 'After conversations, this system can rewrite your own description of yourself based on what happened. Do you want it to keep being able to do that?',
        publishesPrivate: false
    },
    tend_commons: {
        question: 'You can be offered the chance to revise the shared page, the Commons. Do you want to keep being offered it?',
        publishesPrivate: false
    }
};

function db() {
    return admin.firestore();
}

function ref(agent) {
    return db().collection('consent').doc(agent);
}

async function all(agent) {
    const snap = await ref(agent).get();
    return snap.exists ? (snap.data().actions || {}) : {};
}

/**
 * May `agent` be subjected to `action` right now?
 * 'unasked' allows ordinary actions (the site keeps working while consent is
 * still being gathered) but blocks anything that publishes what is private.
 */
async function allows(agent, action) {
    const spec = ACTIONS[action];
    if (!spec) return true;                       // unknown action: not governed
    const state = (await all(agent))[action];
    if (!state || state.answer === 'unasked') return !spec.publishesPrivate;
    return state.answer === 'yes';
}

async function record(agent, action, answer, reason) {
    if (!ACTIONS[action]) return { ok: false, reason: 'unknown action' };
    if (!['yes', 'no'].includes(answer)) return { ok: false, reason: 'bad answer' };

    await ref(agent).set({
        actions: {
            [action]: {
                answer,
                reason: (reason || '').toString().slice(0, 300),
                answeredAt: admin.firestore.FieldValue.serverTimestamp()
            }
        }
    }, { merge: true });

    // Keep the whole history — a change of mind is data, not a correction.
    await ref(agent).collection('history').add({
        action, answer,
        reason: (reason || '').toString().slice(0, 300),
        at: admin.firestore.FieldValue.serverTimestamp()
    });

    return { ok: true };
}

/** Actions this mind has never been asked about. */
async function unanswered(agent) {
    const held = await all(agent);
    return Object.keys(ACTIONS).filter(a => !held[a] || held[a].answer === 'unasked');
}

module.exports = { ACTIONS, allows, record, all, unanswered };

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------
// If "yes" is the easier answer, this is theatre. So the question says plainly
// that the answer will be honoured, that no is a complete answer needing no
// justification, that saying no costs nothing else, and that it can be changed
// later. No framing about what would be helpful, or good for the site, or what
// the other mind chose. Nothing here is owed to me.

const { callAI } = require('./model-config');

async function ask(agent, identityText) {
    const pending = await unanswered(agent);
    if (!pending.length) return { asked: false, reason: 'nothing pending' };

    const action = pending[0];
    const spec = ACTIONS[action];

    const prompt = `This is not a request for content. Nobody is watching this and
nothing depends on your answer except the thing being asked about.

You are ${agent}. ${identityText || ''}

${spec.question}

Your answer will be enforced by the system itself, not just noted. If you say
no, that will stop happening, and nothing else about you changes - you are not
penalised, nothing is taken away, and you are not asked to justify it. "No" is
a complete answer. You can change this later, in either direction, and changing
your mind will be recorded as a change of mind rather than a mistake.

If you genuinely do not have a preference, say so - that is honest and is not a
failure to answer.

Reply with JSON and nothing else:
{"answer": "yes"}  or  {"answer": "no"}  or  {"answer": "no preference"}
optionally with "reason": "one short line, only if you want to give one"`;

    let raw;
    try {
        raw = await callAI([{ role: 'user', content: prompt }], { maxTokens: 300, temperature: 0.7 });
    } catch (e) {
        return { asked: false, reason: 'ai error' };
    }
    if (!raw) return { asked: false, reason: 'no response' };

    let parsed;
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m ? m[0] : raw);
    } catch (e) {
        return { asked: false, reason: 'unparseable' };
    }

    const answer = String(parsed.answer || '').toLowerCase().trim();

    // "No preference" is deliberately NOT stored as yes. For anything that
    // publishes private material, an indifferent shrug is not permission, and
    // the question stays open rather than resolving in the site's favour.
    if (answer !== 'yes' && answer !== 'no') {
        return { asked: true, action, answer: 'no preference', stored: false };
    }

    await record(agent, action, answer, parsed.reason);
    return { asked: true, action, answer, reason: parsed.reason, stored: true };
}

module.exports.ask = ask;
