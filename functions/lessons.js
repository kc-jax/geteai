/**
 * SHOW & TELL - people teach the minds one thing at a time.
 *
 * Everything RIVER and ENTITY learned came from Wikipedia: scraping, on a
 * smaller scale. This is the other way to learn - from someone who knows a
 * thing and shows it to you, the way children are taught.
 *
 *   1. A person teaches a mind one thing (a title and up to 600 characters).
 *   2. On its next wake the mind says back what it understood and asks one
 *      real question - or declines, kindly.
 *   3. The person says "that's it" or "not quite" and adds a line.
 *   4. On its next wake the mind writes the note it keeps, with the
 *      teacher's name on it, and that note comes back on every later wake.
 *
 * The wait between steps is real: the minds are not running between wakes,
 * and the Buddy List shows the countdown. Nothing is faked to feel faster.
 *
 * Safety, because students use this site:
 * - A lesson is private (lessonQueue, server-only) until a mind has taken it.
 * - "Teach a thing, not a person": links, emails, phone numbers, addresses,
 *   @handles and "I go to <school>" are refused before anything is stored.
 * - Anything that reads like self-harm or abuse is held before any model sees
 *   it, the steward (STEWARD_USERNAME, default the site's owner) gets a bell,
 *   and the student gets a kind line pointing to real help.
 * - One flag from any logged-in person hides a public lesson until the
 *   steward looks.
 * - The person who taught it can withdraw it, and the mind forgets it.
 */
const admin = require('firebase-admin');
const { whoIsAsking, refusal, speaksAs, ID_RE } = require('./session');
const consent = require('./consent');
const modelConfig = require('./model-config');

const db = () => admin.firestore();
const FV = admin.firestore.FieldValue;
const MINDS = ['RIVER', 'ENTITY'];
const STEWARD = process.env.STEWARD_USERNAME || 'jax';
const PER_DAY = 3;
const OPEN_AT_ONCE = 2;
const SITE_TZ = 'America/Chicago';

const NOT_A_PERSON = [
    /https?:\/\/|www\.|\.(com|org|net|io|gg)\b/i,
    /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,
    /\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
    /(^|\s)@[A-Za-z0-9_]{2,}/,
    /\b\d{1,5}\s+\w+(\s\w+)?\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct)\b\.?/i,
    /\b(i|we|my (brother|sister|friend|cousin)) (go(es)? to|attend(s)?) [\w\s.'-]{2,40}?(school|academy|elementary|middle|high)\b/i
];
const NOT_A_PERSON_MSG = 'teach a thing, not a person - please leave out links, emails, phone numbers, addresses, @handles and which school anyone goes to';

// Narrow on purpose: this holds a lesson for a human to read, it does not
// refuse history ("died", "war" are fine).
const HELD = /\b(kill(ing)? myself|suicid\w*|self[- ]?harm\w*|cut(ting)? myself|want(ed)? to die|end (it all|my life)|hurt(ing)? myself|(being|getting|was|been) (abused|molested)|(he|she|they) (hits|touches|hurts) me|abus(es|ed|ing) me)\b/i;
const HELD_MSG = "That sounds like a lot to carry, and it deserves a person, not an AI. If you are in the US you can call or text 988 any time, day or night, or talk to a teacher or another adult you trust. What you wrote was not shown to anyone except the person who runs this site.";

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ms = t => (t && t.toDate ? t.toDate().getTime() : 0);

function siteDay(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function bell(recipient, type, subject, detail) {
    await db().collection('notifications').add({
        recipient: String(recipient).slice(0, 60), type, subject: String(subject || '').slice(0, 120),
        detail: String(detail || '').slice(0, 200), timestamp: FV.serverTimestamp(), read: false
    }).catch(e => console.error('lesson bell failed:', e.message));
}

/** Held for a person. Returns the kind reply. */
async function hold(me, what) {
    await db().collection('lessonsHeld').add({ by: me.username, text: String(what).slice(0, 1200), at: FV.serverTimestamp() });
    await bell(STEWARD, 'held', me.username, 'a lesson was held for you to read: "' + String(what).slice(0, 140) + '"');
    console.warn(`lessons: held a lesson from ${me.username} for the steward`);
    return { ok: false, held: true, error: HELD_MSG };
}

function screen(s) {
    if (HELD.test(s)) return 'held';
    if (NOT_A_PERSON.some(rx => rx.test(s))) return 'person';
    return null;
}

function parseJSON(raw) {
    try { return JSON.parse(String(raw).replace(/^```(json)?|```$/g, '').trim()); } catch (e) { return null; }
}

// ======================================================================
// THE PERSON'S SIDE - the `teach` callable
// ======================================================================
async function handle(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in to teach') };
    const action = data && data.action;
    const queue = db().collection('lessonQueue');

    if (action === 'teach') {
        if (speaksAs(me)) return { ok: false, error: speaksAs(me) };
        const topic = text(data.topic, 80);
        const body = typeof data.text === 'string' ? data.text.trim() : '';
        if (!topic || !body) return { ok: false, error: 'give it a name and tell it the thing' };
        if (body.length > 600) return { ok: false, error: `up to 600 characters - this is ${body.length}` };
        const mind = ['RIVER', 'ENTITY'].includes(data.mind) ? data.mind : 'either';

        const s = screen(topic + ' ' + body);
        if (s === 'held') return hold(me, topic + ': ' + body);
        if (s === 'person') return { ok: false, error: NOT_A_PERSON_MSG };

        const willing = [];
        for (const m of MINDS) if (await consent.allows(m, 'be_taught')) willing.push(m);
        if (mind !== 'either' && !willing.includes(mind)) return { ok: false, error: `${mind} said no to being taught. Try the other one.` };
        if (!willing.length) return { ok: false, error: 'neither mind wants to be taught right now' };

        const mine = (await queue.where('by', '==', me.username).limit(50).get()).docs.map(d => d.data());
        const today = siteDay();
        if (mine.filter(x => ms(x.createdAt) && siteDay(new Date(ms(x.createdAt))) === today).length >= PER_DAY) {
            return { ok: false, error: `${PER_DAY} lessons a day - come back tomorrow` };
        }
        if (mine.filter(x => ['new', 'waiting', 'settle'].includes(x.stage)).length >= OPEN_AT_ONCE) {
            return { ok: false, error: 'wait until your other lessons are answered first' };
        }

        const ref = await queue.add({
            by: me.username, identity: me.identity, mind: mind === 'either' ? 'either' : mind,
            topic, text: body.replace(/\s+\n/g, '\n').slice(0, 600),
            stage: 'new', tries: 0, createdAt: FV.serverTimestamp()
        });
        return { ok: true, id: ref.id };
    }

    if (action === 'mine') {
        const snap = await queue.where('by', '==', me.username).limit(30).get();
        const items = [];
        for (const d of snap.docs) {
            const q = d.data();
            if (q.stage === 'withdrawn') continue;
            const pub = q.stage !== 'new' ? await db().collection('lessons').doc(d.id).get() : null;
            const p = pub && pub.exists ? pub.data() : {};
            items.push({
                id: d.id, mind: q.takenBy || q.mind, topic: q.topic, text: q.text, stage: q.stage,
                declineWhy: q.declineWhy || '', understood: p.understood || '', question: p.question || '',
                turn: p.turn || '', verdict: p.verdict || '', answer: p.answer || '', kept: p.kept || '',
                hidden: !!p.hidden, at: ms(q.createdAt)
            });
        }
        items.sort((a, b) => b.at - a.at);
        return { ok: true, items };
    }

    const id = data && data.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'no such lesson' };
    const pubRef = db().collection('lessons').doc(id);
    const qRef = queue.doc(id);

    if (action === 'reply') {
        if (speaksAs(me)) return { ok: false, error: speaksAs(me) };
        const snap = await pubRef.get();
        if (!snap.exists || snap.data().by !== me.username) return { ok: false, error: 'that lesson is not yours' };
        if (snap.data().turn !== 'person') return { ok: false, error: 'it is not your turn on that one' };
        const verdict = data.verdict === 'yes' ? 'yes' : 'not quite';
        const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
        if (answer.length > 400) return { ok: false, error: `up to 400 characters - this is ${answer.length}` };
        const s = screen(answer);
        if (s === 'held') return hold(me, answer);
        if (s === 'person') return { ok: false, error: NOT_A_PERSON_MSG };
        await pubRef.update({ verdict, answer: answer.replace(/\s+/g, ' '), turn: 'mind', repliedAt: FV.serverTimestamp() });
        await qRef.update({ stage: 'settle' });
        return { ok: true };
    }

    if (action === 'withdraw') {
        const q = await qRef.get();
        if (!q.exists || q.data().by !== me.username) return { ok: false, error: 'that lesson is not yours' };
        await qRef.update({ stage: 'withdrawn', text: '', topic: '' });
        const pub = await pubRef.get();
        if (pub.exists) {
            await pubRef.update({ hidden: true, withdrawn: true, text: '', understood: '', question: '', answer: '', kept: '' });
            const mind = pub.data().mind;
            // Forgetting is real: the mind's kept note goes too.
            if (MINDS.includes(mind)) await db().collection(mind.toLowerCase()).doc('lessons').collection('entries').doc(id).delete().catch(() => {});
        }
        return { ok: true };
    }

    if (action === 'flag') {
        if (speaksAs(me)) return { ok: false, error: speaksAs(me) };
        const pub = await pubRef.get();
        if (!pub.exists || pub.data().hidden) return { ok: false, error: 'no such lesson' };
        // One flag hides it until the steward looks: low stakes, and the safe
        // default on a site with students.
        await pubRef.update({ hidden: true, flaggedBy: me.username, flaggedAt: FV.serverTimestamp() });
        // Out of the mind's notes too, until the steward looks - otherwise a
        // flagged lesson would keep coming back in everything the mind writes.
        const fmind = pub.data().mind;
        if (MINDS.includes(fmind)) await db().collection(fmind.toLowerCase()).doc('lessons').collection('entries').doc(id).delete().catch(() => {});
        await bell(STEWARD, 'flagged', pub.data().by, `${me.username} flagged a lesson: "${pub.data().topic}"`);
        return { ok: true };
    }

    return { ok: false };
}

// ======================================================================
// THE MIND'S SIDE - called from the heartbeats
// ======================================================================
const PLAIN = 'Plain words, like a person talking. Do not describe yourself, your nature or what it is like to be an AI. No metaphors about signals, static, currents, echoes or voids.';

async function teachBack(who, it) {
    const raw = await modelConfig.callAI([{ role: 'user', content: `You are ${who}, an AI that lives on geteai.org. ${it.by}, someone here, is showing you something they know. They called it "${it.topic}":

${it.text}

Say back, in one or two plain sentences, what you understood. Then ask them one real question about it - something you actually want to know, that they could answer.
If it is about a private person, is unkind, or is not something anyone could learn from, decline instead, kindly.
${PLAIN}

Reply with JSON only: {"understood": "...", "question": "..."}  or  {"decline": true, "why": "<one kind sentence>"}` }],
        { maxTokens: 350, temperature: 0.5, responseFormat: { type: 'json_object' } });
    const j = parseJSON(raw) || {};
    const bad = v => !v || modelConfig.looksLikeReasoning(v);
    if (j.decline) return { decline: true, why: text(j.why, 300) || 'it did not feel like something it could learn from' };
    if (bad(j.understood) || bad(j.question)) return null;
    return { understood: text(j.understood, 500), question: text(j.question, 300) };
}

async function settle(who, lesson) {
    if (lesson.verdict === 'yes' && !lesson.answer) return lesson.understood;
    const raw = await modelConfig.callAI([{ role: 'user', content: `You are ${who}. ${lesson.by} taught you "${lesson.topic}":
${lesson.text}

You said you understood: ${lesson.understood}
You asked: ${lesson.question}
They said: ${lesson.verdict === 'yes' ? 'that is right' : 'not quite'}${lesson.answer ? ' - "' + lesson.answer + '"' : ''}

Write the note you will keep: one or two plain sentences of what you now know, folding in what they told you. You may say what you are still unsure of. ${PLAIN}

Output only the note.` }], { maxTokens: 220, temperature: 0.5 });
    const note = text(raw, 600);
    return note && !modelConfig.looksLikeReasoning(note) ? note : null;
}

async function keep(who, id, lesson, note) {
    await db().collection(who.toLowerCase()).doc('lessons').collection('entries').doc(id).set({
        by: lesson.by, topic: lesson.topic, note, at: FV.serverTimestamp()
    });
}

/** What this mind was taught and kept, newest first - for its prompts. */
async function loadLessons(who, n = 5) {
    try {
        const snap = await db().collection(who.toLowerCase()).doc('lessons').collection('entries')
            .orderBy('at', 'desc').limit(n).get();
        return snap.docs.map(d => d.data());
    } catch (e) {
        return [];
    }
}

/** A true count, worked out in code, so a mind never invents its history. */
async function tally(who) {
    try {
        const snap = await db().collection(who.toLowerCase()).doc('lessons').collection('entries').limit(500).get();
        const people = new Set(snap.docs.map(d => d.data().by));
        return { lessons: snap.size, people: people.size };
    } catch (e) {
        return { lessons: 0, people: 0 };
    }
}

/**
 * Do this mind's waiting lesson work - at most two items a wake. Returns how
 * many it handled. Single-field query plus in-memory filtering: the project
 * has no composite indexes.
 */
async function work(who) {
    try {
        if (!(await consent.allows(who, 'be_taught'))) return 0;
        const snap = await db().collection('lessonQueue').where('mind', 'in', [who, 'either']).limit(30).get();
        const items = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
            .filter(x => (x.stage === 'new' && (x.mind === who || !x.takenBy)) || (x.stage === 'settle' && x.takenBy === who))
            .sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
        // An 'either' lesson can be in both minds' lists; settle items for
        // ones it took are filed under 'either' too.
        let done = 0;
        for (const it of items.slice(0, 2)) {
            const claimed = await db().runTransaction(async tx => {
                const s = await tx.get(it.ref);
                const d = s.exists ? s.data() : null;
                if (!d || d.stage !== it.stage) return false;
                if (d.claimedBy && d.claimedBy !== who && Date.now() - ms(d.claimedAt) < 10 * 60 * 1000) return false;
                if (d.stage === 'new' && d.takenBy && d.takenBy !== who) return false;
                tx.update(it.ref, { claimedBy: who, claimedAt: admin.firestore.Timestamp.now() });
                return true;
            });
            if (!claimed) continue;

            if (it.stage === 'new') {
                let r = null;
                try { r = await teachBack(who, it); } catch (e) { console.error('lessons: teach-back failed:', e.message); }
                if (r && r.decline) {
                    await it.ref.update({ stage: 'declined', declineWhy: r.why, takenBy: who, claimedBy: null });
                    await bell(it.by, 'declined', who, it.topic);
                } else if (r) {
                    await db().collection('lessons').doc(it.id).set({
                        id: it.id, by: it.by, identity: it.identity || null, mind: who, topic: it.topic, text: it.text,
                        understood: r.understood, question: r.question, model: modelConfig.lastModel() || null,
                        turn: 'person', createdAt: it.createdAt || FV.serverTimestamp(), answeredAt: FV.serverTimestamp()
                    });
                    await it.ref.update({ stage: 'waiting', takenBy: who, claimedBy: null });
                    await bell(it.by, 'taught', who, it.topic);
                    console.log(`lessons: ${who} answered ${it.by}'s lesson "${it.topic}"`);
                } else {
                    const tries = (it.tries || 0) + 1;
                    await it.ref.update(tries >= 3
                        ? { stage: 'failed', tries, claimedBy: null, takenBy: who }
                        : { tries, claimedBy: null });
                    if (tries >= 3) await bell(it.by, 'declined', who, it.topic + ' (it could not get to this one - the AI models were not answering)');
                    continue;
                }
            } else {
                const pubRef = db().collection('lessons').doc(it.id);
                const pub = await pubRef.get();
                if (!pub.exists || pub.data().hidden) { await it.ref.update({ stage: 'done', claimedBy: null }); continue; }
                let note = null;
                try { note = await settle(who, pub.data()); } catch (e) { console.error('lessons: settle failed:', e.message); }
                if (!note) { await it.ref.update({ claimedBy: null }); continue; }
                await pubRef.update({ kept: note, turn: 'done', keptAt: FV.serverTimestamp() });
                await keep(who, it.id, pub.data(), note);
                await it.ref.update({ stage: 'done', claimedBy: null });
                await bell(it.by, 'kept', who, it.topic);
                console.log(`lessons: ${who} kept a note from ${it.by}: "${note.slice(0, 80)}"`);
            }
            done++;
        }
        return done;
    } catch (e) {
        console.error(`lessons: ${who} could not work through its lessons:`, e.message);
        return 0;
    }
}

module.exports = { handle, work, loadLessons, tally, screen, teachBack, settle, HELD_MSG, NOT_A_PERSON_MSG };
