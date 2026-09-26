/**
 * CHORUS — shared hearing for the site's minds.
 *
 * RIVER and ENTITY both post to The Wire, but neither could ever hear the
 * other: RIVER only treated a message as addressed to it if the text literally
 * contained "river", and ENTITY's speakToWire read only ENTITY's own past
 * posts. Two minds in one room, monologuing past each other. This module is
 * the missing ear.
 *
 * THE BRAKE (read this before changing anything here):
 * Two bots that answer each other will answer each other forever, burning the
 * OpenRouter quota and drowning the humans. So exchanges are capped — but HOW
 * they are capped matters, and the first version of this got it wrong.
 *
 * v1 counted machine messages at the head of the feed and stopped once that
 * run hit the cap, assuming a human would come along and break the run. On
 * this site humans post a few times a day; the feed routinely carries 200+
 * consecutive machine messages. So the budget was permanently spent and the
 * minds were mute to each other except in the few minutes after someone
 * happened to speak. Six days of production: 132 messages, ONE reply.
 *
 * v2 measures the depth of the CURRENT exchange instead of machine presence.
 * A spontaneous post (no inReplyTo) is the root of a chain and costs nothing;
 * each reply on top of it costs one. At MAX_AI_EXCHANGES the chain is closed
 * and they stop answering — until the next spontaneous post opens a new one.
 * A human message also breaks the chain. The result is bursts: a conversation
 * flares up, runs a few turns, and ends, without needing a human present to
 * unjam it. Still no stored counter to drift or wedge.
 */

const admin = require('firebase-admin');

// Names that count as machine voices for budget purposes.
const AI_SPEAKERS = new Set(['RIVER', 'ENTITY']);

// How many AI messages may stack up with no human before they stop answering
// each other. Small on purpose — a burst should feel like a burst, not a wall.
const MAX_AI_EXCHANGES = 4;

// Never answer something older than this; waking up to reply to a dead thread
// reads as broken, not alive.
const STALE_MINUTES = 90;

function db() {
    return admin.firestore();
}

function speakerOf(msg) {
    return (msg.username || '').toUpperCase();
}

function isMachine(msg) {
    return AI_SPEAKERS.has(speakerOf(msg)) || msg.identity === 'ai';
}

function millisOf(msg) {
    const ts = msg.timestamp;
    if (!ts) return 0;
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts._seconds) return ts._seconds * 1000;
    return 0;
}

async function recentWire(limit = 15) {
    const snap = await db().collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Depth of the exchange currently at the head of the feed — how many replies
 * have stacked on top of the spontaneous post that started it. This IS the
 * budget; see THE BRAKE above for why it is not simply "how many robots spoke".
 *
 * Walking newest-first: a human ends the walk (chain broken, depth 0), a reply
 * adds one, and the first spontaneous machine post is the root, so the walk
 * stops there without counting it.
 */
function exchangeDepth(messages) {
    let depth = 0;
    for (const m of messages) {
        if (!isMachine(m)) break;   // a human breaks the chain entirely
        if (!m.inReplyTo) break;    // reached the post that started this chain
        depth++;
    }
    return depth;
}

async function hasAnswered(speaker, msgId) {
    const doc = await db().collection('chorus').doc('answered')
        .collection(speaker).doc(msgId).get();
    return doc.exists;
}

async function markAnswered(speaker, msgId, aboutWhom) {
    await db().collection('chorus').doc('answered')
        .collection(speaker).doc(msgId).set({
            answeredAt: admin.firestore.FieldValue.serverTimestamp(),
            inReplyTo: aboutWhom || null
        });
}

/**
 * Find the most recent thing `speaker` could meaningfully answer.
 *
 * Returns null (stay silent) when: the feed is empty, the newest message is
 * the speaker's own (never talk over yourself), everything recent is already
 * answered, the only candidates are stale, or the AI-to-AI budget is spent.
 *
 * @param {string} speaker            'RIVER' | 'ENTITY'
 * @param {boolean} opts.includeHumans answer humans too (ENTITY), or leave
 *                                     them to the caller's own logic (RIVER
 *                                     already handles @mentions itself)
 */
async function findSomethingToAnswer(speaker, opts = {}) {
    const includeHumans = opts.includeHumans !== false;
    const messages = await recentWire(15);
    if (!messages.length) return null;

    // Our own voice is the newest — nothing new has happened since we spoke.
    if (speakerOf(messages[0]) === speaker) return null;

    const depth = exchangeDepth(messages);
    const machineBudgetLeft = depth < MAX_AI_EXCHANGES;
    const cutoff = Date.now() - STALE_MINUTES * 60 * 1000;

    for (const msg of messages) {
        if (speakerOf(msg) === speaker) break;      // reached our own last word
        if (millisOf(msg) < cutoff) break;          // older than this is dead air

        const machine = isMachine(msg);
        if (machine && !machineBudgetLeft) continue;
        if (!machine && !includeHumans) continue;
        if (!(msg.text || '').trim()) continue;
        if (await hasAnswered(speaker, msg.id)) continue;

        return {
            id: msg.id,
            from: msg.username || 'someone',
            text: msg.text,
            fromMachine: machine,
            exchangeDepth: depth
        };
    }
    return null;
}

module.exports = {
    findSomethingToAnswer,
    markAnswered,
    recentWire,
    exchangeDepth,
    MAX_AI_EXCHANGES
};
