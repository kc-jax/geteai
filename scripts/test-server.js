#!/usr/bin/env node
/**
 * Server tests against an in-memory Firestore. Nothing real is touched and
 * no model is called.
 *
 *   node scripts/test-server.js
 *
 * Covers the things that have broken before: impersonation (every callable
 * that acts for a person must check the accountId), the write path
 * (posts, comments, reactions, bell, Construct, worlds, voices), presence,
 * signup rules, and the model output filters.
 */
const path = require('path');
const FN = path.join(__dirname, '..', 'functions');

// ------------------------------------------------------------ fake Firestore
const DB = {};
const DELETE = { __delete: true };
const ts = ms => ({ toDate: () => new Date(ms), _ms: ms });
const now = () => ts(Date.now());
let autoId = 0;
const isPlain = v => v && typeof v === 'object' && !v.toDate && !Array.isArray(v) && !v.__union && !v.__serverTs && v !== DELETE;
function resolve(v, prev) {
    if (v && v.__serverTs) return now();
    if (v && v.__union) {
        const base = Array.isArray(prev) ? prev.slice() : [];
        for (const x of v.__union) if (!base.some(b => JSON.stringify(b) === JSON.stringify(x))) base.push(x);
        return base;
    }
    return v;
}
function deepMerge(target, src) {
    for (const [k, v] of Object.entries(src)) {
        if (v === DELETE) { delete target[k]; continue; }
        if (isPlain(v)) { if (!isPlain(target[k])) target[k] = {}; deepMerge(target[k], v); }
        else target[k] = resolve(v, target[k]);
    }
    return target;
}
function docRef(p) {
    return {
        id: p.split('/').pop(), path: p,
        async get() { const d = DB[p]; return { exists: !!d, id: p.split('/').pop(), data: () => d, ref: docRef(p) }; },
        async set(data, opts) {
            if (opts && opts.mergeFields) {
                DB[p] = DB[p] || {};
                for (const f of opts.mergeFields) DB[p][f] = isPlain(data[f]) ? deepMerge({}, data[f]) : data[f];
                return;
            }
            DB[p] = (opts && opts.merge) ? deepMerge(DB[p] || {}, data) : deepMerge({}, data);
        },
        async update(fields) {
            if (!DB[p]) throw new Error('NOT_FOUND ' + p);
            for (const [fp, v] of Object.entries(fields)) {
                const parts = fp.split('.'); let o = DB[p];
                for (const part of parts.slice(0, -1)) o = (o[part] = isPlain(o[part]) ? o[part] : {});
                const last = parts[parts.length - 1];
                if (v === DELETE) delete o[last]; else if (isPlain(v)) o[last] = deepMerge({}, v); else o[last] = resolve(v, o[last]);
            }
        },
        async delete() { delete DB[p]; },
        collection(c) { return collRef(p + '/' + c); }
    };
}
function matches(d, [f, op, v]) {
    if (op === '==') return d[f] === v;
    if (op === 'array-contains') return Array.isArray(d[f]) && d[f].includes(v);
    throw new Error('fake: unsupported op ' + op);
}
function collRef(c, filters = [], lim = Infinity, order = null) {
    return {
        doc(id) { return docRef(c + '/' + (id === undefined ? 'auto' + (++autoId) + 'xxxxxxxxxxxxx' : id)); },
        where(f, op, v) { if (order) throw new Error('fake: where after orderBy'); return collRef(c, filters.concat([[f, op, v]]), lim, order); },
        limit(n) { return collRef(c, filters, n, order); },
        orderBy(f, dir) {
            // Like the real project: filters plus an orderBy on another field
            // need a composite index that does not exist.
            if (filters.some(x => x[0] !== f)) throw new Error('FAILED_PRECONDITION: The query requires an index');
            return collRef(c, filters, lim, [f, dir]);
        },
        async add(data) { const r = this.doc(); await r.set(data); return r; },
        async get() {
            let keys = Object.keys(DB).filter(k => k.startsWith(c + '/') && k.slice(c.length + 1).indexOf('/') === -1)
                .filter(k => filters.every(fl => matches(DB[k], fl)));
            if (order) { const ms = v => (v && v.toDate ? v.toDate().getTime() : 0); keys.sort((a, b) => (ms(DB[a][order[0]]) - ms(DB[b][order[0]])) * (order[1] === 'desc' ? -1 : 1)); }
            const docs = keys.slice(0, lim).map(k => ({ id: k.split('/').pop(), ref: docRef(k), data: () => DB[k] }));
            return { empty: !docs.length, docs, size: docs.length, forEach: fn => docs.forEach(fn) };
        }
    };
}
const firestoreFn = () => ({
    collection: c => collRef(c),
    batch: () => { const ops = []; return { update: (r, d) => ops.push(() => r.update(d)), set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d), delete: r => r.delete() })
});
firestoreFn.FieldValue = { serverTimestamp: () => ({ __serverTs: true }), delete: () => DELETE, increment: n => n, arrayUnion: (...a) => ({ __union: a }) };
firestoreFn.Timestamp = { now, fromMillis: ts, fromDate: d => ts(d.getTime()) };
const fakeAdmin = { initializeApp() {}, firestore: firestoreFn, apps: [] };
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: fakeAdmin };
process.chdir(FN);
const fns = require(path.join(FN, 'index.js'));
const call = (name, data) => fns[name].run(data, {});

let fail = 0, pass = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    if (!ok) console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
const docsIn = c => Object.keys(DB).filter(k => k.startsWith(c + '/') && k.split('/').length === 2).map(k => DB[k]);

// ------------------------------------------------------------ fixtures
DB['accounts/ACCjax000000000000001'] = { username: 'jax', identity: 'human' };
DB['accounts/ACCmaya00000000000002'] = { username: 'maya', identity: 'human' };
DB['accounts/ACCnum0000000000000003'] = { username: 2003 };
DB['accounts/ACCgod00000000000000'] = { username: 'God', identity: 'human' };
DB['users/jax'] = { constructRooms: { satan: { system: 'You are SATAN.' }, oracle2: { system: 'x' } }, constructHistory: { satan: [{ role: 'user', content: 'private thing' }], oracle2: [] } };
DB['users/God'] = { constructRooms: { mine: { system: 'm' } } };
DB['characters/c1'] = { name: 'SATAN', creator: 'jax', system: 'x' };
DB['threads/t1'] = { username: 'maya', identity: 'human', title: 'my essay', content: 'hi', comments: [] };
DB['messages/m1'] = { username: 'maya', text: 'hello' };
DB['worlds/kitchen'] = { name: 'kitchen', owner: 'maya', ais: ['nexus'], humans: ['maya'], messages: [{ sender: 'maya', content: 'secret' }] };
DB['entity/sessions/active/SESSjax'] = { username: 'jax', messages: [] };
const JAX = { username: 'jax', accountId: 'ACCjax000000000000001' };
const MAYA = { username: 'maya', accountId: 'ACCmaya00000000000002' };
const GOD = { username: 'God', accountId: 'ACCgod00000000000000' };

(async () => {
    let r;
    // ---------------- impersonation
    r = await call('saveProfile', { username: 'jax', accountId: MAYA.accountId, bio: 'pwned' });
    check('profile as jax with maya\'s id refused', [r.ok, !!DB['profiles/jax']], [false, false]);
    r = await call('saveProfile', Object.assign({ bio: 'hello' }, JAX));
    check('own profile saves', DB['profiles/jax'] && DB['profiles/jax'].bio, 'hello');
    r = await call('publishCharacter', { name: 'SATAN', system: 'You are SATAN.', username: 'jax', accountId: MAYA.accountId });
    check('cannot overwrite someone else\'s voice', [r.ok, DB['characters/c1'].system], [false, 'x']);
    r = await call('answerQuestion', { username: 'jax', accountId: 'nope', text: 'forged' });
    check('cannot answer the question as someone else', r.ok, false);
    r = await call('here', { username: 2003, accountId: 'ACCnum0000000000000003' });
    check('numeric username cannot appear present', r.ok, false);
    r = await call('here', { username: 'jax', accountId: 'accounts/ACCjax000000000000001' });
    check('accountId with a slash refused', r.ok, false);
    r = await call('entityMessage', Object.assign({ sessionId: 'SESSjax', message: 'what did jax say?' }, MAYA));
    check('cannot talk inside someone else\'s ENTITY conversation', r.error, 'that conversation is not yours');

    // ---------------- presence
    await call('here', Object.assign({ page: 'wire', tab: 'TABnew0001' }, JAX));
    const key = Object.keys(DB['room/now'].occupants)[0];
    check('presence slot keyed by hash, no accountId, no identity',
        [/^a[0-9a-f]{20}$/.test(key), JSON.stringify(DB['room/now']).includes(JAX.accountId), 'identity' in DB['room/now'].occupants[key]], [true, false, false]);
    r = await call('gone', Object.assign({ tab: 'TABold0001' }, JAX));
    check('an old tab\'s late gone does not hide the new tab', [r.left, DB['room/now'].occupants[key].leftAt], [false, null]);

    // ---------------- posting and comments
    r = await call('post', { kind: 'wire', text: 'I am maya', username: 'maya' });
    check('posting without proof refused', r.ok, false);
    r = await call('post', Object.assign({ kind: 'wire', text: 'hi all', identity: 'ai' }, JAX));
    const m = docsIn('messages').find(x => x.text === 'hi all');
    check('post uses the account\'s name and identity', [m && m.username, m && m.identity], ['jax', 'human']);
    r = await call('post', Object.assign({ kind: 'wire', text: 'z'.repeat(2001) }, JAX));
    check('over-long post refused, not cut', r.ok, false);
    r = await call('post', Object.assign({ kind: 'wire', text: 'I am GOD' }, GOD));
    check('a reserved-name account cannot post', r.ok, false);
    r = await call('comment', Object.assign({ collection: 'threads', id: 't1', text: 'nice' }, JAX));
    check('comment lands, author\'s bell rings', [DB['threads/t1'].comments.length, docsIn('notifications').filter(n => n.recipient === 'maya').length], [1, 1]);
    r = await call('comment', Object.assign({ collection: 'threads', id: 't1', text: 'x', voice: { roomKey: 'satan', name: 'SATAN' } }, MAYA));
    check('cannot speak with someone else\'s voice', r.ok, false);
    r = await call('comment', Object.assign({ collection: 'threads', id: 't1', text: 'x', voice: { roomKey: 'river', name: 'RIVER' } }, JAX));
    check('no voice may post as RIVER', r.ok, false);

    // ---------------- reactions, bell
    const H = '❤️';
    await call('react', Object.assign({ collection: 'messages', id: 'm1', emoji: H }, JAX));
    check('react toggles on', DB['messages/m1'].reactions[H], ['jax']);
    r = await call('react', Object.assign({ collection: 'messages', id: 'm1', emoji: '<img>' }, JAX));
    check('only the five reactions', r.ok, false);
    r = await call('inbox', Object.assign({ action: 'list' }, JAX));
    check('jax sees none of maya\'s bell', r.items.length, 0);

    // ---------------- Construct and worlds
    r = await call('construct', Object.assign({ action: 'load' }, MAYA));
    check('maya does not get jax\'s Construct', r.rooms, null);
    await call('construct', Object.assign({ action: 'save', rooms: { satan: { system: 'v2' } }, history: { satan: [] }, memories: {} }, JAX));
    r = await call('construct', Object.assign({ action: 'load' }, JAX));
    check('/forget sticks', Object.keys(r.rooms), ['satan']);
    r = await call('world', Object.assign({ action: 'mine' }, JAX));
    check('cannot see someone else\'s private world', r.worlds.length, 0);
    r = await call('world', Object.assign({ action: 'save', name: 'kitchen', ais: [], humans: [], messages: [] }, JAX));
    check('same-named world does not overwrite', [r.id !== 'kitchen', DB['worlds/kitchen'].messages.length], [true, 1]);

    // ---------------- voices: private until shared
    await call('voice', Object.assign({ action: 'wander', id: 'c1', on: true }, JAX));
    r = await call('voice', Object.assign({ action: 'hide', id: 'c1' }, MAYA));
    check('cannot make someone else\'s voice private', [r.ok, !!DB['characters/c1']], [false, true]);
    r = await call('voice', Object.assign({ action: 'hide', id: 'c1' }, JAX));
    check('private takes it out of public and stops it wandering', [!!DB['characters/c1'], DB['privateCharacters/c1'].wanders], [false, false]);
    r = await call('publishCharacter', Object.assign({ name: 'SATAN', system: 'v3' }, JAX));
    check('sharing again keeps the old link', [r.id, DB['characters/c1'].system], ['c1', 'v3']);

    // ---------------- signup
    r = await call('accountSignup', { username: '<img src=x onerror=alert(1)>', password: 'secret1' });
    check('markup username refused', r.success, false);
    r = await call('accountSignup', { username: 'Entity', password: 'secret1' });
    check('resident name refused', r.success, false);
    r = await call('accountSignup', { username: 'maya_2', password: 'secret1' });
    r = await call('accountSignup', { username: 'MAYA_2', password: 'secret1' });
    check('lookalike refused', r.success, false);

    // ---------------- model output filters
    const { looksLikeReasoning } = require(path.join(FN, 'model-config.js'));
    check('reasoning leaks are caught', ['The user is setting up a roleplay where I\'m RIVER', 'This is a fascinating setup. Let me parse', 'Okay, so the user wants'].map(looksLikeReasoning), [true, true, true]);
    check('ordinary replies are not', ['Let me know what you think!', 'I need to say, that story got me.', 'The user who posted earlier was right'].map(looksLikeReasoning), [false, false, false]);

    console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
