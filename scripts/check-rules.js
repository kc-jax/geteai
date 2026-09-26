#!/usr/bin/env node
/**
 * Guard against the "collection with no rule" bug.
 *
 * Firestore denies any path no rule matches, and the frontend swallows the
 * permission error, so the failure is completely silent: the page just renders
 * empty forever. It has bitten this project twice — the login lockout, and the
 * //LOGS page, which read a `conversations` collection that firestore.rules
 * never mentioned and so was dead from the day the rules were tightened.
 *
 * The rules file is a hand-maintained list of collection names. Nothing made
 * it agree with what the site actually reads. This does.
 *
 *   node scripts/check-rules.js
 *
 * Exits non-zero if the site touches a collection the rules do not cover.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RULES = path.join(ROOT, 'firestore.rules');
const CLIENT = path.join(ROOT, 'public', 'index.html');

// Collections only ever reached by Cloud Functions via the Admin SDK, which
// bypasses rules entirely. They legitimately need no client-facing rule.
const SERVER_ONLY = new Set(['chorus']);

function collectionsInRules(src) {
    const found = new Set();
    for (const m of src.matchAll(/match\s+\/([A-Za-z_][A-Za-z0-9_]*)\//g)) {
        if (m[1] !== 'databases') found.add(m[1]);
    }
    return found;
}

function collectionsInClient(src) {
    const found = new Set();
    // collection(db, 'name')  and  collection(db, "name")
    for (const m of src.matchAll(/collection\(\s*db\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
        found.add(m[1]);
    }
    return found;
}

const rules = collectionsInRules(fs.readFileSync(RULES, 'utf8'));
const client = collectionsInClient(fs.readFileSync(CLIENT, 'utf8'));

const missing = [...client].filter(c => !rules.has(c) && !SERVER_ONLY.has(c)).sort();
const unused = [...rules].filter(c => !client.has(c) && !SERVER_ONLY.has(c)).sort();

console.log(`rules cover : ${[...rules].sort().join(', ')}`);
console.log(`site reads  : ${[...client].sort().join(', ')}`);

if (unused.length) {
    // Not a failure: functions and rules legitimately guard server-side data
    // (river/*, entity/*) that the client never touches directly.
    console.log(`\nnote: covered but not read by the client (fine if server-owned): ${unused.join(', ')}`);
}

if (missing.length) {
    console.error(`\nFAIL: the site reads ${missing.length} collection(s) with NO matching rule:`);
    for (const c of missing) {
        console.error(`   - ${c}   -> every read/write silently returns PERMISSION_DENIED`);
    }
    console.error(`\nAdd a match /<name>/{id} block to firestore.rules for each, then re-run.`);
    process.exit(1);
}

console.log('\nOK: every collection the site touches has a rule.');
