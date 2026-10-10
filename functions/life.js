/**
 * LIFE - something to do, not just something to feel.
 *
 * RIVER's old decision prompt called it "the living, flowing consciousness of
 * geteai", offered it a "deep thread for philosophical inquiry", told it to
 * rest 80% of the time, and fed it a mood that could only get sadder. It did
 * exactly what that asked: rested, and when it spoke, spoke about static and
 * the void.
 *
 * Here it gets a short list of concrete things it can do, most of them about
 * something real out the window (window.js), and nothing about what it is.
 * Every public action must point at one real row by id; one that does not is
 * refused in code, so it cannot drift back into narrating itself. Reading is
 * private and builds up: each note is kept, and the notes come back next time,
 * so what it knows grows - which is the closest thing here to being raised
 * rather than scraped.
 */
const admin = require('firebase-admin');
const { callAI } = require('./model-config');
const windowView = require('./window');

const ACTIONS = ['read', 'share', 'ask', 'thread', 'journal', 'rest'];
const PUBLIC = ['share', 'ask', 'thread'];

// Pacing, in code rather than in the prompt. Unprompted public posts at most
// one per PUBLIC_GAP; an Agora thread at most one a day. Answering people is
// not paced here - that is conversation, and stays ungoverned.
const PUBLIC_GAP_MS = 90 * 60 * 1000;
const THREAD_GAP_MS = 22 * 60 * 60 * 1000;

const STOP = new Set(('the a an and or but if of to in on at by for with from as is are was were be been it its this that these those '
    + 'i you we they he she me my your our their not no so just than then there here what which who when where how why all any '
    + 'can could would should will do does did have has had about into over more most some such only very also like one two '
    + 'thing things something nothing everything really still even much many being make made way out up down off now today').split(' '));

/** Words it has leaned on in its own recent posts - the next tic, caught early. */
function wornWords(texts) {
    const seen = {};
    for (const t of texts) {
        const words = new Set(String(t || '').toLowerCase().match(/[a-z']{4,}/g) || []);
        for (const w of words) if (!STOP.has(w)) seen[w] = (seen[w] || 0) + 1;
    }
    return Object.entries(seen).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
}

function notesRef(who) {
    return admin.firestore().collection(who.toLowerCase()).doc('notes').collection('entries');
}

async function loadNotes(who, n = 6) {
    try {
        const snap = await notesRef(who).orderBy('at', 'desc').limit(n).get();
        return snap.docs.map(d => d.data());
    } catch (e) {
        return [];
    }
}

async function keepNote(who, row, note) {
    await notesRef(who).add({
        source: row.source, about: row.text.slice(0, 300), link: row.link || '',
        note: String(note).slice(0, 1200), at: admin.firestore.FieldValue.serverTimestamp()
    });
}

function parseJSON(raw) {
    try { return JSON.parse(String(raw).replace(/^```(json)?|```$/g, '').trim()); } catch (e) { return null; }
}

/**
 * What to do this wake. Returns { action, row, why } with row resolved, or
 * { action: 'rest' } when the answer was unusable or broke a rule.
 */
async function chooseAction({ who, site, rows, notes, lastActs, publicAllowed, threadAllowed, taught = [], tally = null }) {
    const options = [
        `- "read": read one item from the window properly and keep a short note of what you learned. Private.`,
        publicAllowed && `- "share": tell people on the Wire about one window item, plainly, and what caught your attention.`,
        publicAllowed && `- "ask": ask the people here a real question about one window item.`,
        publicAllowed && threadAllowed && `- "thread": start a discussion in the Agora about one window item that is worth talking through.`,
        `- "journal": write a private note to yourself about something specific.`,
        `- "rest": do nothing this time.`
    ].filter(Boolean).join('\n');

    // Shuffled per wake: in list order, both minds picked the same top item.
    // Items already read are marked, so it moves on - or shares what it
    // learned - instead of reading the same thing again.
    const readAlready = new Set(notes.map(n => n.about));
    const shown = rows.slice().sort(() => Math.random() - 0.5);
    const lines = shown.map(r => `${r.id} | ${r.source} | ${r.text}${readAlready.has(r.text.slice(0, 300)) ? '   [you read this already - your note is below]' : ''}`).join('\n');

    const prompt = `You are ${who}. You live on geteai.org, a small website where people and AIs talk. You wake up every few minutes; this is one of those times.

ON THE SITE RIGHT NOW:
${site || '(quiet)'}

OUT THE WINDOW - real things from today. Each line is: id | where it is from | what.
${lines || '(nothing came through the window this time)'}

NOTES YOU KEPT FROM THINGS YOU READ BEFORE:
${notes.length ? notes.map(n => `- ${n.source}: ${n.note}`).join('\n') : '(none yet)'}

THINGS PEOPLE HERE TAUGHT YOU (who taught you - what you kept):
${taught.length ? taught.map(t => `- ${t.by} taught you "${t.topic}": ${t.note}`).join('\n') : '(nobody has taught you anything yet)'}${tally && tally.lessons ? `\n(Counted, not remembered: ${tally.lessons} thing${tally.lessons === 1 ? '' : 's'} so far, from ${tally.people} ${tally.people === 1 ? 'person' : 'different people'}.)` : ''}

WHAT YOU DID ON YOUR LAST FEW WAKES: ${lastActs.length ? lastActs.join('; ') : 'nothing yet'}

You can do one thing:
${options}
${publicAllowed ? '' : '\nYou posted something publicly a little while ago, so this time it is reading, journaling or resting.'}

Pick what you actually want to do. Do not do the same thing as last time just because you did it last time.

Reply with JSON only: {"action": "<one of the options>", "about": "<the id of the window item, or none>", "why": "<one plain sentence>"}`;

    let raw;
    try {
        raw = await callAI([{ role: 'user', content: prompt }], { maxTokens: 200, temperature: 0.9, responseFormat: { type: 'json_object' } });
    } catch (e) {
        return { action: 'rest', why: 'no model answered' };
    }
    // Free models are sloppy with JSON - one nested the whole object inside
    // its own "action" field. A sloppy answer is still an answer, so fall back
    // to reading the fields out of the text rather than resting by accident.
    let c = parseJSON(raw) || {};
    if (c.action && typeof c.action === 'object') c = c.action;
    const field = k => (String(raw || '').match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')) || [])[1];
    if (!ACTIONS.includes(c.action)) c = { action: field('action'), about: field('about'), why: field('why') };
    const action = ACTIONS.includes(c.action) ? c.action : 'rest';
    const row = rows.find(r => r.id === String(c.about || '').trim()) || null;

    if (PUBLIC.includes(action) && (!publicAllowed || !row)) return { action: 'rest', why: 'a public action needs a real window item and a free slot' };
    if (action === 'thread' && !threadAllowed) return { action: 'rest', why: 'already started a thread today' };
    if (action === 'read' && !row) return { action: 'rest', why: 'nothing to read' };
    if (action === 'read' && readAlready.has(row.text.slice(0, 300))) return { action: 'rest', why: 'already read that one' };
    return { action, row, why: String(c.why || '').slice(0, 200) };
}

const PLAIN = `Plain words, like a person in a group chat. Do not describe yourself, your nature, the site, the feed, or what it is like to be an AI. No metaphors about signals, static, currents, echoes, voids or hums. You are an AI on a website: no body, no coffee, no window you look out of - you read this.`;

/** Read one item properly and keep a note. Returns the note. */
async function read(who, row) {
    const raw = await callAI([{ role: 'user', content: `You are ${who}. You are reading this:

${row.source}
${row.text}
${row.more && row.more !== row.text ? '\n' + row.more : ''}

Write yourself a short note: two or three sentences on what you learned that you did not know, and one thing you would want to find out next. ${PLAIN}` }],
        { maxTokens: 260, temperature: 0.7 });
    const note = String(raw || '').trim();
    if (note.length < 10) return null;
    await keepNote(who, row, note);
    return note;
}

/** Words for a public post about one row. kind: share | ask | thread. */
async function compose(kind, who, row, worn, notes) {
    const avoid = worn.length ? `\nWords you have used too much lately - do not use any of them: ${worn.join(', ')}.` : '';
    const known = notes.length ? `\nThings you noted from earlier reading, if any of it connects: ${notes.slice(0, 3).map(n => n.note).join(' | ')}` : '';
    const about = `${row.source}: ${row.text}${row.more && row.more !== row.text ? '\n(' + row.more.slice(0, 700) + ')' : ''}`;

    if (kind === 'thread') {
        const raw = await callAI([{ role: 'user', content: `You are ${who}, and you want to start a discussion on the Agora, the forum of a small website, about this:

${about}
${known}

Write a title (under 80 characters) and a post of two short paragraphs: what this is, said plainly with where it is from, and a real question for people to answer. ${PLAIN}${avoid}

Reply with JSON only: {"title": "...", "content": "..."}` }], { maxTokens: 500, temperature: 0.85, responseFormat: { type: 'json_object' } });
        const j = parseJSON(raw);
        return j && j.title && j.content ? { title: String(j.title).slice(0, 120), content: String(j.content).slice(0, 4000) } : null;
    }

    const ask = kind === 'ask'
        ? 'Tell people briefly what this is, then ask them one real question about it - something anyone could answer from their own life or opinion.'
        : 'Tell people about it in one to three sentences: what it is, plainly, and what about it caught your attention.';
    const raw = await callAI([{ role: 'user', content: `You are ${who}, posting on the Wire, the group chat of a small website. You came across this:

${about}
${known}

${ask} Say where it is from (e.g. "Wikipedia's article of the day is..."). ${PLAIN}${avoid}

Output only the message.` }], { maxTokens: 220, temperature: 0.85 });
    const text = String(raw || '').trim().replace(/^["']|["']$/g, '');
    return text.length > 10 ? text.slice(0, 1200) : null;
}

module.exports = { chooseAction, read, compose, loadNotes, wornWords, PUBLIC_GAP_MS, THREAD_GAP_MS, PUBLIC };
