/**
 * WHO IS ASKING.
 *
 * The site's login is not Firebase Auth. Every visitor is signed in
 * anonymously, so to Firestore's rules a stranger and a student look the
 * same. Real accounts live in the server-only `accounts` collection, and
 * accountLogin hands back the account document's id - the accountId - to
 * whoever gave the right password. It is never written anywhere public, so
 * holding it is the proof of having logged in.
 *
 * Every callable that acts on someone's behalf used to take the username in
 * the request at its word. That is how a stranger could edit someone's
 * profile, overwrite their shared voices, answer the day's question as them,
 * or open a conversation with ENTITY as them and hear what it remembers about
 * the real person. Now they all start here.
 */
const admin = require('firebase-admin');

const RELOGIN = 'please log out and back in, then try again';

// Names no human account may act as. The residents, the built-in Construct
// voices, and the site's own system voices: a human answering the day's
// question as "RIVER" would put words in RIVER's mouth for everyone.
const RESERVED = ['river', 'entity', 'god', 'nexus', 'void', 'forge', 'oracle',
    'system', 'admin', 'geteai', 'witness', 'someone'];

function isReserved(name) {
    return RESERVED.includes(String(name || '').trim().toLowerCase());
}

// What a NEW username may look like. Existing accounts keep working whatever
// they are called; this only stops new names that are markup, or that look
// like someone else's name with invisible characters in it.
const USERNAME_RE = /^[A-Za-z0-9_-]{2,24}$/;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function whoIsAsking(data) {
    try {
        const { username, accountId } = data || {};
        if (typeof username !== 'string' || !username) return null;
        if (typeof accountId !== 'string' || !ID_RE.test(accountId)) return null;
        const acct = await admin.firestore().collection('accounts').doc(accountId).get();
        if (!acct.exists || acct.data().username !== username) return null;
        // An account made before names were checked may be called "river" or
        // "admin". It still logs in and keeps its own Construct, bell and
        // worlds - but see speaksAs(): it cannot put that name on anything
        // public.
        return { username, accountId, identity: acct.data().identity || null, reserved: isReserved(username) };
    } catch (e) {
        console.error('whoIsAsking failed:', e.message);
        return null;
    }
}

// Anything that shows the caller's name to other people goes through this.
// Returns an error to hand back, or null when the name may be used.
const RESERVED_NAME = 'this username belongs to someone who lives here, so it cannot post or appear publicly - please make a new account';
function speaksAs(me) {
    return me && me.reserved ? RESERVED_NAME : null;
}

// The reason to give when a request carries a name but no proof.
function refusal(data, whenLoggedOut) {
    return (data && data.username) ? RELOGIN : whenLoggedOut;
}

module.exports = { whoIsAsking, refusal, speaksAs, isReserved, RELOGIN, RESERVED, USERNAME_RE, ID_RE };
