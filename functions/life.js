/**
 * A mind's notes - what it kept from what it read.
 *
 * This file used to hold a menu: each wake the mind picked one of read /
 * share / ask / thread / journal / rest about an item from a curated window.
 * It worked, but it was a fish tank - the mind could only look at what it was
 * handed. It now goes out on the open web instead (roam.js) and decides for
 * itself what to look at; what is left here is the memory of it.
 *
 * Notes are private (server-only) and come back on every later wake, so what
 * a mind knows grows instead of resetting every five minutes.
 */
const admin = require('firebase-admin');

async function loadNotes(who, n = 6) {
    try {
        const snap = await admin.firestore().collection(who.toLowerCase()).doc('notes').collection('entries')
            .orderBy('at', 'desc').limit(n).get();
        return snap.docs.map(d => d.data());
    } catch (e) {
        return [];
    }
}

module.exports = { loadNotes };
