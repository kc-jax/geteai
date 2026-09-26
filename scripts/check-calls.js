#!/usr/bin/env node
/**
 * Find things the site calls that nothing defines.
 *
 * Commit c8589fa ("operation bulletproof - clean project hygiene") deleted
 * ~700 lines from public/index.html, including the Construct's entire command
 * set. Deletions like that leave call sites pointing at nothing, and in a
 * browser that fails at the moment a user clicks - silently, one feature at a
 * time, long after the commit looked fine.
 *
 * This catches two shapes of that:
 *   - onclick="foo(...)" in markup where no foo is ever defined
 *   - window.foo(...) called in script where no window.foo = ... exists
 *
 *   node scripts/check-calls.js
 *
 * Exits non-zero if anything is missing.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

// Everything the page defines, however it is spelled.
const defined = new Set();
for (const m of src.matchAll(/window\.([a-zA-Z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
// modular firebase imports, e.g. import { getDoc, query } from "..."
for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach(n => defined.add(n.trim().split(/\s+as\s+/).pop()));
}

// Browser and language builtins that obviously are not ours to define.
const BUILTIN = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
    'alert', 'confirm', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean',
    'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise', 'fetch', 'setTimeout',
    'setInterval', 'clearTimeout', 'clearInterval', 'require', 'import', 'console',
    'open', 'close', 'print', 'scrollTo'
]);

const problems = [];

// 1. inline handlers in markup
for (const m of src.matchAll(/on(?:click|change|submit|keydown|input)\s*=\s*"([^"]*)"/g)) {
    for (const call of m[1].matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const name = call[2];
        if (BUILTIN.has(name) || defined.has(name)) continue;
        problems.push({ kind: 'inline handler', name, context: m[1].slice(0, 70) });
    }
}

// 2. window.foo(...) in script
for (const m of src.matchAll(/window\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (BUILTIN.has(name) || defined.has(name)) continue;
    problems.push({ kind: 'window call', name, context: `window.${name}(...)` });
}

const unique = [];
const seen = new Set();
for (const p of problems) {
    const key = p.kind + ':' + p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
}

console.log(`definitions found: ${defined.size}`);

if (unique.length) {
    console.error(`\nFAIL: ${unique.length} call(s) with no definition:`);
    for (const p of unique) {
        console.error(`   - ${p.name}()   [${p.kind}]   ${p.context}`);
    }
    console.error(`\nEach of these throws the moment a user triggers it.`);
    process.exit(1);
}

console.log('OK: everything called is defined somewhere.');
