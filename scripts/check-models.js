#!/usr/bin/env node
/**
 * Call every model in the cascade and report which ones actually work.
 *
 * OpenRouter's free tier churns constantly: nvidia/nemotron-nano-12b-v2-vl was
 * verified by calling it on 2026-08-23 and was returning 404 by 2026-09-26.
 * Twice now this project has been "completely broken" purely because the model
 * list had rotted, and both times it took a live debugging session to find out.
 *
 * "Listed as free on openrouter.ai/models" is not the same as "callable here":
 * some ids 404, some are gated to agentic-harness apps (403), and some return
 * a null content field with the answer hidden in `reasoning`, which reads as an
 * empty response and is worse than an error because nothing looks wrong.
 *
 *   node scripts/check-models.js
 *
 * Exits non-zero if any model is permanently broken (404/403/no-content).
 * A 429 is not a failure - it means rate-limited right now, which is expected
 * and is exactly what the cascade exists to route around.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envText = fs.readFileSync(path.join(ROOT, 'functions', '.env'), 'utf8');
const KEY = (envText.match(/^\s*OPENROUTER_KEY\s*=\s*(.+)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, '');

function listFrom(file, varName) {
    // Deliberately not RegExp(varName + '\s*=...'): inside a JS string literal
    // a lone backslash is swallowed before the regex ever sees it, silently
    // producing a pattern that matches nothing.
    const src = fs.readFileSync(path.join(ROOT, 'functions', file), 'utf8');
    const at = src.indexOf(varName);
    if (at === -1) return [];
    const open = src.indexOf('[', at);
    const close = src.indexOf(']', open);
    if (open === -1 || close === -1) return [];
    const lines = src.slice(open + 1, close).split(/\r?\n/);
    const cleaned = lines.map(l => l.split('//')[0]).join('\n');
    return [...cleaned.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
}

const cascade = listFrom('model-config.js', 'MODEL_CASCADE');
const worksheet = listFrom('index.js', 'WORKSHEET_MODELS');
const all = [...new Set([...cascade, ...worksheet])];

(async () => {
    console.log(`checking ${all.length} model id(s)\n`);
    const dead = [];
    for (const model of all) {
        let line;
        try {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
                    max_tokens: 30
                })
            });
            const body = await r.json();
            const content = body?.choices?.[0]?.message?.content;
            if (r.status === 200 && content && content.trim()) {
                line = `  OK        ${model}`;
            } else if (r.status === 429) {
                line = `  ratelimit ${model}  (fine - the cascade routes around this)`;
            } else if (r.status === 200) {
                line = `  NO TEXT   ${model}  (returns empty content - unusable)`;
                dead.push(model);
            } else {
                line = `  ${String(r.status).padEnd(9)} ${model}  ${(body?.error?.message || '').slice(0, 70)}`;
                dead.push(model);
            }
        } catch (e) {
            line = `  ERROR     ${model}  ${e.message}`;
            dead.push(model);
        }
        console.log(line);
    }

    if (dead.length) {
        console.error(`\nFAIL: ${dead.length} model id(s) are permanently broken:`);
        dead.forEach(m => console.error(`   - ${m}`));
        console.error(`\nReplace them in functions/model-config.js (MODEL_CASCADE) and/or`);
        console.error(`functions/index.js (WORKSHEET_MODELS). Check https://openrouter.ai/models?q=free`);
        console.error(`and re-run this - do not trust the listing without calling it.`);
        process.exit(1);
    }
    console.log('\nOK: every model id is live.');
})();
