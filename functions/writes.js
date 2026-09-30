/**
 * EVERYTHING A PERSON WRITES GOES THROUGH HERE.
 *
 * The page used to write straight into Firestore: the Wire, the Agora,
 * //SIGNAL, //LOGS, comments, reactions, notifications, your Construct voices
 * and their chat history, and worlds. The rules allowed any signed-in visitor
 * to do it - and every visitor is signed in anonymously - so the username on
 * a post was whatever the browser said it was. Anyone could post as a
 * student, rewrite their comments, fake a teacher's comment in their bell,
 * read every private Construct conversation, or overwrite someone's world.
 *
 * Now the rules refuse all of those writes, and these callables do them
 * instead, with the name taken from the verified session (see session.js),
 * never from the request.
 */
const admin = require('firebase-admin');
const { whoIsAsking, refusal, speaksAs, isReserved, ID_RE } = require('./session');

const db = () => admin.firestore();
const FV = admin.firestore.FieldValue;

const KINDS = {
    wire:   { coll: 'messages',      event: 'wire_message', eventChars: 2000 },
    agora:  { coll: 'threads',       event: 'agora_post',   eventChars: 200 },
    signal: { coll: 'posts',         event: 'signal_essay', eventChars: 500 },
    logs:   { coll: 'conversations', event: null }
};
const COMMENTABLE = ['threads', 'posts', 'conversations'];
const REACTABLE = ['messages', 'threads', 'posts', 'conversations'];
const REACTIONS = ['❤️', '🔥', '👁️', '⚡', '💾'];
const BUILTIN_VOICES = ['nexus', 'void', 'forge', 'oracle', 'river'];

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Refuse rather than cut. Slicing silently and returning ok made the page
// clear the box, so the end of a long transcript was simply gone.
const LIMITS = { wire: 2000, title: 200, content: 50000, logs: 200000, comment: 2000, voice: 4000 };
function tooLong(v, max, what) {
    const n = typeof v === 'string' ? v.trim().length : 0;
    return n > max ? `${what} can be up to ${max.toLocaleString('en-US')} characters - this one is ${n.toLocaleString('en-US')}` : null;
}
const bytes = v => Buffer.byteLength(JSON.stringify(v || null), 'utf8');

// ------------------------------------------------------------------ posting
async function post(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in to post') };
    if (speaksAs(me)) return { ok: false, error: speaksAs(me) };
    const kind = KINDS[data && data.kind];
    if (!kind) return { ok: false, error: 'nowhere to post that' };

    const long = data.kind === 'wire'
        ? tooLong(data.text, LIMITS.wire, 'Wire messages')
        : tooLong(data.title, LIMITS.title, 'Titles')
            || tooLong(data.content, data.kind === 'logs' ? LIMITS.logs : LIMITS.content, data.kind === 'logs' ? 'Transcripts' : 'Posts');
    if (long) return { ok: false, error: long };

    let doc;
    if (data.kind === 'wire') {
        const t = text(data.text, 2000);
        if (!t) return { ok: false, error: 'say something' };
        doc = { text: t };
    } else {
        const title = text(data.title, 200);
        const content = text(data.content, data.kind === 'logs' ? LIMITS.logs : LIMITS.content);
        if (!title || !content) return { ok: false, error: 'fill in all fields' };
        doc = { title, content, comments: [] };
    }

    const ref = await db().collection(kind.coll).add(Object.assign({
        username: me.username,
        identity: me.identity,
        timestamp: FV.serverTimestamp()
    }, doc));

    // What RIVER perceives. Written here now, so a row in `events` is as
    // trustworthy as the post it describes.
    if (kind.event) {
        const ev = { type: kind.event, username: me.username, identity: me.identity, timestamp: FV.serverTimestamp() };
        if (doc.title) ev.title = doc.title;
        ev.content = (doc.text || doc.content).slice(0, kind.eventChars);
        await db().collection('events').add(ev).catch(e => console.error('event log failed:', e.message));
    }
    return { ok: true, id: ref.id };
}

// ------------------------------------------------------------------ comments
async function comment(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in to comment') };
    const coll = data && data.collection;
    const id = data && data.id;
    if (!COMMENTABLE.includes(coll) || typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'no such post' };

    const voice = data.voice;
    if (!voice && speaksAs(me)) return { ok: false, error: speaksAs(me) };
    const long = tooLong(data.text, voice ? LIMITS.voice : LIMITS.comment, 'Comments');
    if (long) return { ok: false, error: long };
    const t = text(data.text, voice ? LIMITS.voice : LIMITS.comment);
    if (!t) return { ok: false, error: 'say something' };

    const ref = db().collection(coll).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, error: 'no such post' };
    const postData = snap.data();

    let entry;
    if (voice) {
        // One of YOUR voices answering in a thread you tagged it in. It posts
        // under its own name, marked as an AI, and says whose it is - it can
        // be no one's voice but yours, and never a resident's.
        const roomKey = text(voice.roomKey, 40).toLowerCase();
        const name = text(voice.name, 40).toUpperCase();
        // The built-in voices answer under their own names (NEXUS, VOID...),
        // marked as yours; nothing may answer as a resident.
        const ownBuiltinName = BUILTIN_VOICES.includes(roomKey) && name === roomKey.toUpperCase();
        const resident = ['RIVER', 'ENTITY', 'GOD'].includes(name);
        if (!/^[A-Z0-9 _-]{1,40}$/.test(name) || resident || (isReserved(name) && !ownBuiltinName)) {
            return { ok: false, error: 'that voice cannot post here' };
        }
        if (!BUILTIN_VOICES.includes(roomKey)) {
            const mine = await db().collection('users').doc(me.username).get();
            const rooms = (mine.exists && mine.data().constructRooms) || {};
            if (!rooms[roomKey]) return { ok: false, error: 'that is not one of your voices' };
        }
        entry = { username: name, identity: 'ai', voiceOf: me.username, text: t, timestamp: admin.firestore.Timestamp.now() };
    } else {
        entry = { username: me.username, identity: me.identity, text: t, timestamp: admin.firestore.Timestamp.now() };
    }
    await ref.update({ comments: FV.arrayUnion(entry) });

    // The bell for whoever wrote the post. Made here, from what actually
    // happened, instead of by the commenter's browser.
    if (!voice && postData.username && postData.username !== me.username) {
        await db().collection('notifications').add({
            recipient: String(postData.username).slice(0, 60),
            type: 'comment',
            postId: id,
            postType: coll,
            postTitle: text(postData.title, 120) || 'a post',
            commenterUsername: me.username,
            commentPreview: t.slice(0, 50),
            timestamp: FV.serverTimestamp(),
            read: false
        }).catch(e => console.error('comment notification failed:', e.message));
    }
    return { ok: true };
}

// ------------------------------------------------------------------ reactions
async function react(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in to react') };
    const coll = data && data.collection;
    const id = data && data.id;
    const emoji = data && data.emoji;
    if (!REACTABLE.includes(coll) || typeof id !== 'string' || !ID_RE.test(id)) return { ok: false };
    if (!REACTIONS.includes(emoji)) return { ok: false };

    const ref = db().collection(coll).doc(id);
    const reactions = await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const r = Object.assign({}, snap.data().reactions || {});
        let list = Array.isArray(r[emoji]) ? r[emoji].slice() : [];
        list = list.includes(me.username) ? list.filter(u => u !== me.username) : list.concat(me.username);
        if (list.length) r[emoji] = list; else delete r[emoji];
        tx.update(ref, { reactions: r });
        return r;
    });
    return reactions ? { ok: true, reactions } : { ok: false };
}

// ------------------------------------------------------------------ the bell
async function inbox(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in first') };
    const action = data && data.action;

    if (action === 'read') {
        const id = data.id;
        if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false };
        const ref = db().collection('notifications').doc(id);
        const snap = await ref.get();
        if (!snap.exists || snap.data().recipient !== me.username) return { ok: false };
        await ref.update({ read: true });
        return { ok: true };
    }

    // Two equality filters and no orderBy: served without a composite index.
    const snap = await db().collection('notifications')
        .where('recipient', '==', me.username)
        .where('read', '==', false)
        .limit(50)
        .get();
    if (action === 'count') return { ok: true, count: snap.size };

    const ms = t => (t && t.toDate ? t.toDate().getTime() : 0);
    const items = snap.docs.map(d => {
        const n = d.data();
        return {
            id: d.id, type: n.type || 'comment', detail: n.detail || '', subject: n.subject || '',
            commenterUsername: n.commenterUsername || '', postTitle: n.postTitle || '',
            commentPreview: n.commentPreview || '', postId: n.postId || '', postType: n.postType || '',
            at: ms(n.timestamp)
        };
    }).sort((a, b) => b.at - a.at).slice(0, 10);
    return { ok: true, count: snap.size, items };
}

// ------------------------------------------------------------------ Construct
// Your voices, what you said to them, and what they remember of you. This
// was readable - and replaceable - by any visitor who knew your username,
// which the Buddy List shows to everyone.
const CONSTRUCT_MAX_BYTES = 900 * 1024;

function trimHistory(history, keep) {
    const out = {};
    for (const [room, msgs] of Object.entries(history || {})) {
        out[room] = Array.isArray(msgs) ? msgs.slice(-keep) : [];
    }
    return out;
}

async function construct(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in first') };
    const ref = db().collection('users').doc(me.username);

    if (data.action === 'load') {
        const snap = await ref.get();
        const d = snap.exists ? snap.data() : {};
        return {
            ok: true,
            rooms: d.constructRooms || null,
            history: d.constructHistory || null,
            memories: d.constructMemories || null,
            hostName: d.hostName || null
        };
    }

    if (data.action === 'save') {
        const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
        const rooms = isObj(data.rooms) ? data.rooms : {};
        const memories = isObj(data.memories) ? data.memories : {};
        let history = isObj(data.history) ? data.history : {};
        // A Firestore document holds 1 MiB. Keep the newest messages rather
        // than failing to save anything at all.
        for (const keep of [200, 80, 30, 10, 0]) {
            if (bytes(rooms) + bytes(history) + bytes(memories) <= CONSTRUCT_MAX_BYTES) break;
            history = trimHistory(history, keep);
        }
        if (bytes(rooms) + bytes(history) + bytes(memories) > CONSTRUCT_MAX_BYTES) {
            return { ok: false, error: 'too much to save - delete a voice or two' };
        }
        // Replace these three whole. A deep merge never removed a key, so a
        // /forget-ten voice came back, with its history, on the next load.
        await ref.set({ constructRooms: rooms, constructHistory: history, constructMemories: memories },
            { mergeFields: ['constructRooms', 'constructHistory', 'constructMemories'] });
        return { ok: true };
    }
    return { ok: false };
}

// ------------------------------------------------------------------ worlds
// Group chats with a member list. They were world-readable, so "invite only"
// was only true in the page, and keyed by their bare name, so two people who
// each built a world called "kitchen" silently overwrote one another.
const WORLD_MAX_BYTES = 900 * 1024;

async function world(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in first') };
    const worlds = db().collection('worlds');
    const shape = d => ({ id: d.id, name: d.data().name, owner: d.data().owner, ais: d.data().ais || [],
        humans: d.data().humans || [], messages: d.data().messages || [] });

    // One array-contains filter and nothing else: no index needed.
    const mineSnap = await worlds.where('humans', 'array-contains', me.username).limit(100).get();
    const mine = mineSnap.docs.map(shape);

    if (data.action === 'mine') return { ok: true, worlds: mine };

    if (data.action === 'save') {
        const name = text(data.name, 60);
        if (!name) return { ok: false, error: 'a world needs a name' };
        const strList = (v, max) => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(x => x.slice(0, 60)))].slice(0, max) : [];
        const ais = strList(data.ais, 20);
        // Only the shape the page writes. A malformed entry used to be able to
        // break /enter for every member of the world.
        let messages = (Array.isArray(data.messages) ? data.messages.slice(-500) : [])
            .filter(m => m && typeof m === 'object')
            .map(m => ({
                type: m.type === 'ai' ? 'ai' : 'human',
                sender: String(m.sender == null ? '' : m.sender).slice(0, 60),
                content: String(m.content == null ? '' : m.content).slice(0, 8000),
                timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0
            }));
        while (messages.length && bytes(messages) > WORLD_MAX_BYTES) messages = messages.slice(Math.ceil(messages.length / 4));

        // By id only. Matching by name meant a /build from a page whose list
        // was out of date wiped a same-named world - possibly someone else's.
        const existing = typeof data.id === 'string' ? mine.find(w => w.id === data.id) : null;
        if (existing) {
            // Members may invite; nobody can remove the owner.
            const humans = strList(data.humans, 50);
            if (!humans.includes(existing.owner)) humans.unshift(existing.owner);
            if (!humans.includes(me.username)) humans.push(me.username);
            await worlds.doc(existing.id).update({ ais, humans, messages, updatedAt: FV.serverTimestamp() });
            return { ok: true, id: existing.id };
        }
        const humans = [me.username].concat(strList(data.humans, 49).filter(h => h !== me.username));
        const ref = await worlds.add({ name, owner: me.username, ais, humans, messages,
            createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
        return { ok: true, id: ref.id };
    }
    return { ok: false };
}


// ------------------------------------------------------------------ your voices
// A voice you made is yours and private until you say otherwise. Sharing it
// used to be one click with no way back: the link went live, it was listed in
// //VOICES, its instructions were readable by anyone, and nothing could take
// it down again. Now "private" is a real place - privateCharacters, which no
// page can read - and a voice moves between the two at its maker's word. It
// keeps its id both ways, so a link handed out before still works the day it
// is made public again.
//
// `wanders` is a separate, second yes: whether a public voice may post on the
// Wire by itself (personaLeakage). Being public is not consent to that.
async function voice(data) {
    const me = await whoIsAsking(data);
    if (!me) return { ok: false, error: refusal(data, 'log in first') };
    const pub = db().collection('characters');
    const priv = db().collection('privateCharacters');
    const action = data && data.action;

    if (action === 'mine') {
        const [a, b] = await Promise.all([
            pub.where('creator', '==', me.username).limit(100).get(),
            priv.where('creator', '==', me.username).limit(100).get()
        ]);
        const row = (d, isPublic) => ({ id: d.id, name: d.data().name, public: isPublic,
            wanders: isPublic && d.data().wanders === true, visits: d.data().visits || 0 });
        return { ok: true, voices: a.docs.map(d => row(d, true)).concat(b.docs.map(d => row(d, false))) };
    }

    const id = data && data.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'no such voice' };

    if (action === 'hide') {
        const ref = pub.doc(id);
        const moved = await db().runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists || snap.data().creator !== me.username) return false;
            tx.set(priv.doc(id), Object.assign({}, snap.data(), { wanders: false, hiddenAt: FV.serverTimestamp() }));
            tx.delete(ref);
            return true;
        });
        return moved ? { ok: true } : { ok: false, error: 'that is not one of your public voices' };
    }

    if (action === 'show') {
        const ref = priv.doc(id);
        const moved = await db().runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists || snap.data().creator !== me.username) return false;
            const d = Object.assign({}, snap.data());
            delete d.hiddenAt;
            tx.set(pub.doc(id), Object.assign(d, { wanders: false, updatedAt: FV.serverTimestamp() }));
            tx.delete(ref);
            return true;
        });
        return moved ? { ok: true } : { ok: false, error: 'that is not one of your private voices' };
    }

    if (action === 'wander') {
        const ref = pub.doc(id);
        const snap = await ref.get();
        if (!snap.exists || snap.data().creator !== me.username) return { ok: false, error: 'only a public voice of yours can wander' };
        await ref.update({ wanders: data.on === true });
        return { ok: true, wanders: data.on === true };
    }
    return { ok: false };
}

module.exports = { post, comment, react, inbox, construct, world, voice };
