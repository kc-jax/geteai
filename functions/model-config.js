/**
 * MODEL CONFIG — Resilient AI Caller
 * 
 * Central module for all OpenRouter API calls across geteai.
 * Provides automatic retry with exponential backoff and a cascade
 * of free models so the site keeps working even when individual
 * models are rate-limited or down.
 * 
 * Usage:
 *   const { callAI } = require('./model-config');
 *   const response = await callAI(messages, { maxTokens: 500 });
 */

require('dotenv').config();
const OpenAI = require('openai');

// API key comes from functions/.env (loaded by dotenv above) or the process env.
// NOTE: the old `functions.config().openrouter?.key` fallback was removed on
// purpose — Firebase's runtime config API is decommissioned, so that call now
// warns or throws at deploy time instead of quietly returning nothing.
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

if (!OPENROUTER_KEY) {
    console.error('[MODEL-CONFIG] ⚠️  NO OPENROUTER KEY FOUND! Set OPENROUTER_KEY in functions/.env');
}

const openai = new OpenAI({
    apiKey: OPENROUTER_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
        "HTTP-Referer": "https://geteai.org",
        "X-Title": "geteai"
    },
    timeout: 30000, // 30 second timeout — prevents Cloud Functions from hanging
});

// ============================================================================
// MODEL CASCADE
// ============================================================================
// Ordered by preference. Each is free. If one 429s, we try the next.
// The last entry `openrouter/free` is OpenRouter's auto-router that picks
// the best available free model automatically — our ultimate safety net.

// UPDATED: 2026-08-23 — Verified against OpenRouter's live free model list,
// with each model actually test-called (not just checked for existence).
//
// ⚠️  DO NOT add embedding models (…-embed-…), text-to-speech models
// (fish-audio/*, deepgram/*), or the content-safety classifier
// (nvidia/nemotron-3.5-content-safety) to this list. They are listed as "free"
// on OpenRouter but they are not chat models and will fail every request.
//
// ⚠️  DO NOT add thinkingmachines/inkling or thinkingmachines/inkling-small.
// They exist and look like normal chat models, but OpenRouter hard-blocks
// them outside of recognized "agentic harness" apps (coding assistants) —
// every call returns 403 "only available on agentic harnesses". This is
// permanent, not rate-limiting, and it broke the ENTIRE cascade (see the
// 401/403 handling below) because they sat first in line.
//
// When models stop working, check https://openrouter.ai/models?q=free AND
// actually call it once — "listed as free" isn't the same as "callable here".
// Every model below was individually test-called on 2026-08-23 and returned
// CLEAN output (the literal answer, not its chain-of-thought). That second part
// matters: many free "reasoning" models return content:null with the thinking
// in a separate `reasoning` field, or dump "The user asks: ..." straight into
// content. Both look broken on a public feed, so they are excluded here.
//
// ⚠️  EXCLUDED ON PURPOSE — do not re-add without re-testing:
//   liquid/lfm-2.5-2.6b, poolside/laguna-xs-2.1, dots-studio/dots-3-note-preview,
//   cohere/north-mini-code, nvidia/nemotron-nano-9b-v2  → return null content
//   nvidia/nemotron-3.5-lightning, nvidia/nemotron-3-nano-30b-a3b
//                                                       → leak reasoning text
//   (nemotron-3-ultra and -super leaked too, until requests started sending
//    reasoning: { exclude: true } - they are back in the cascade since 10-02)
//   thinkingmachines/inkling, thinkingmachines/inkling-small
//                          → hard 403, "only available on agentic harnesses"
//   stealth/ox-alpha       → cloaked/experimental model, logs prompts, unstable
//   embedding / TTS / content-safety models → not chat models at all
//
// To re-verify when things break, re-run a probe that CALLS each candidate —
// "listed as free on openrouter.ai/models" is not the same as "works here".
// UPDATED 2026-10-10: stealth/space-bunny-alpha (free 09-27..10-05),
// qwen/qwen3.8-27b and inclusionai/ling-3.0-flash-sante are gone - the
// last two went paid-only. Re-checked with scripts/check-models.js.
// UPDATED 2026-10-02. Best first. Every entry was called 6 times (3 chat
// replies + 3 JSON decisions, the two kinds of call this site makes) and
// passed all 6 unless noted. The two big Nemotrons that used to leak their
// reasoning into the reply are clean once requests send
// reasoning: { exclude: true } - see requestBody below.
const MODEL_CASCADE = [
    'nvidia/nemotron-3-ultra-550b-a55b:free',               // 1M ctx, the largest free model, ~6s
    'nvidia/nemotron-3-super-120b-a12b:free',               // 262K ctx, ~5s
    'google/gemma-4-31b-it:free',                           // 262K ctx, text+image+video, strong but often 429
    'poolside/laguna-s-2.1:free',                           // 262K ctx, ~2.6s
    'dots-studio/dots-3-note-preview:free',                 // 512K ctx, text+image, 5/6 (one 429)
    'cohere/north-mini-code:free',                          // 256K ctx, 4/6 (429s)
    'google/gemma-4-26b-a4b-it:free',                       // 262K ctx, text+image+video, usually 429
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',   // 256K ctx, multimodal, often empty or 429
    'openrouter/free'                                       // ← SAFETY NET: router picks any working free model
];

// Models that are only free for a while. After the date they are skipped
// without a call, instead of costing every request a failed round trip.
const EXPIRES = {
    // 'stealth/space-bunny-alpha': '2026-10-06T00:00:00Z' - the first one; it
    // dropped out by itself on the day, as intended. Add the next one here.
};

// Models that always think before answering. Their hidden reasoning counts
// against max_tokens, so a 60-token budget came back as "Hi," - the
// thinking had spent the rest. These get extra room for it.
const ALWAYS_THINKS = new Set(['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free']);
const THINKING_ROOM = 2000;

// Which models can take an image (OpenRouter's input_modalities). A request
// with a picture in it only goes to these; the rest would just 400.
const SEES_IMAGES = new Set([
    'google/gemma-4-31b-it:free',
    'dots-studio/dots-3-note-preview:free', 'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'openrouter/free'
]);

function activeModels(now = Date.now()) {
    return MODEL_CASCADE.filter(m => !EXPIRES[m] || now < Date.parse(EXPIRES[m]));
}

function hasImages(messages) {
    return (messages || []).some(m => Array.isArray(m.content) &&
        m.content.some(part => part && (part.type === 'image_url' || part.type === 'input_image')));
}

// Which model produced the most recent successful reply in this instance.
// Cloud Functions 1st gen runs one request per instance at a time, so this
// is the model behind the reply the current request just got.
let lastModelUsed = null;

// Default max_tokens to prevent auto-router from requesting model's full context
// (which can be 65k+ and burn credits instantly)
const DEFAULT_MAX_TOKENS = 1000;

// ============================================================================
// RESILIENT CALLER
// ============================================================================

/**
 * Call OpenRouter with automatic retry and model cascade.
 * 
 * @param {Array} messages - OpenAI-format messages array
 * @param {Object} options - Optional settings
 * @param {number} options.maxTokens - Max tokens for response
 * @param {number} options.temperature - Temperature (0-2)
 * @param {Object} options.responseFormat - Response format (e.g. { type: "json_object" })
 * @param {string} options.preferredModel - Override primary model for this call
 * @returns {string} The AI response content
 */
/**
 * Does this reply look like plumbing rather than an answer?
 *
 * Free-pool models sometimes return a safety classifier's verdict, a bare role
 * tag, or a refusal stub. None of it is an error status, so the cascade happily
 * treats it as a successful response and it ends up published.
 */
function looksLikeMachineNoise(text) {
    const t = String(text).trim();
    if (!t) return true;
    if (t.length < 3) return true;
    return [
        /^user safety\s*:/i,
        /^safety\s*:/i,
        /^(content )?(policy|moderation)\s*:/i,
        /^(assistant|system|user)\s*:\s*$/i,
        /^\[?(safe|unsafe|flagged|blocked)\]?\.?$/i,
        /^i (cannot|can't) (assist|help) with that\.?$/i
    ].some(rx => rx.test(t));
}

/**
 * Is this the model narrating its own reasoning instead of answering?
 *
 * reasoning: { exclude: true } keeps a thinking model's reasoning out of the
 * reply when the model puts it in the separate field. Nemotron Ultra often
 * does not - it writes "The user is setting up a roleplay where I'm RIVER..."
 * straight into the reply, and for a week that is what RIVER and ENTITY
 * posted to each other on the Wire.
 */
const REASONING_LEAK = [
    /^the user('s| is| wants| has| asks| asked| said| seems| just| gave| provided)\b/i,
    /^(okay|ok|alright|hmm),? (so|let me|the user|i need|we need)\b/i,
    /^let me (think|parse|analy[sz]e|break (this|it) down|figure out|consider|reason)\b/i,
    /^(i|we) need to (respond|reply|answer|write|craft|figure out|parse|think about|come up with)\b/i,
    /^this is (a|an) (fascinating|interesting|tricky|creative|clever|thoughtful) (setup|request|scenario|prompt|roleplay)\b/i,
    /\b(setting up a (roleplay|role-play|scenario)|in this role-?play|my instructions (say|are)|the system prompt)\b/i,
    /<\/?think>/i
];

function looksLikeReasoning(text) {
    const t = String(text || '').trim();
    return REASONING_LEAK.some(rx => rx.test(t));
}

async function callAI(messages, options = {}) {
    return (await callAIDetailed(messages, options)).content;
}

/**
 * Same as callAI, but says which model answered and, if asked, how it
 * reasoned. Options beyond callAI's:
 *   reasoningEffort - 'low' | 'medium' | 'high' for models that think first
 *   showReasoning   - return the model's reasoning text separately
 */
async function callAIDetailed(messages, options = {}) {
    const {
        maxTokens = null,
        temperature = null,
        responseFormat = undefined,
        preferredModel = null,
        reasoningEffort = null,
        showReasoning = false,
    } = options;

    // Build the model list: preferred model first (if specified), then cascade.
    // A picture only goes to models that can see.
    const cascade = activeModels();
    const pool = hasImages(messages) ? cascade.filter(m => SEES_IMAGES.has(m)) : cascade;
    const models = preferredModel && pool.includes(preferredModel)
        ? [preferredModel, ...pool.filter(m => m !== preferredModel)]
        : [...pool];

    let lastError = null;

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const model = models[modelIndex];
        const maxRetries = 2; // retries per model before moving to next

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const requestBody = {
                    model: model,
                    messages: messages,
                    max_tokens: (maxTokens || DEFAULT_MAX_TOKENS) + (ALWAYS_THINKS.has(model) ? THINKING_ROOM : 0),
                };

                if (temperature !== null) requestBody.temperature = temperature;
                if (responseFormat) requestBody.response_format = responseFormat;
                // Keep a thinking model's reasoning out of the reply. Without
                // this, two of the best free models dumped "The user asks..."
                // straight onto the public feed.
                requestBody.reasoning = Object.assign(
                    { exclude: !showReasoning },
                    // Low unless asked: background calls want a quick,
                    // plain answer, not an essay of thinking first.
                    { effort: reasoningEffort || 'low' });

                const completion = await openai.chat.completions.create(requestBody);

                const choiceMsg = completion.choices?.[0]?.message || {};
                const content = choiceMsg.content;
                if (!content) {
                    console.warn(`[MODEL-CONFIG] Empty response from ${model}, trying next...`);
                    break;
                }

                // Some models in the free pool answer with a moderation verdict
                // or a role tag instead of a reply. ENTITY posted the literal
                // words "User Safety: safe" to the public feed because this went
                // straight through as content. It is not an error status, so
                // nothing upstream catches it - it has to be recognised here.
                if (looksLikeReasoning(content)) {
                    console.warn(`[MODEL-CONFIG] ${model} wrote out its reasoning instead of answering ("${content.trim().slice(0, 50)}"), trying next...`);
                    break;
                }

                if (looksLikeMachineNoise(content)) {
                    console.warn(`[MODEL-CONFIG] ${model} returned a non-answer ("${content.trim().slice(0, 40)}"), trying next...`);
                    break;
                }

                // Success! Log which model worked if it wasn't the primary
                if (modelIndex > 0 || attempt > 0) {
                    console.log(`[MODEL-CONFIG] ✓ Success on model=${model} (cascade index ${modelIndex}, attempt ${attempt})`);
                }

                lastModelUsed = model;
                return { content, model, reasoning: showReasoning ? (choiceMsg.reasoning || null) : null };

            } catch (error) {
                lastError = error;
                const status = error?.status || error?.response?.status || 0;

                if (status === 429) {
                    // Rate limited — Fail fast! Jump to next model immediately
                    console.warn(`[MODEL-CONFIG] 429 on ${model} — rate limited, failing fast to next model...`);
                    break;

                } else if (status === 402) {
                    // Payment required — this model costs money, skip immediately
                    console.warn(`[MODEL-CONFIG] 402 on ${model} — skipping (requires credits)`);
                    break;

                } else if (status === 503 || status === 502) {
                    // Service unavailable — model might be down
                    console.warn(`[MODEL-CONFIG] ${status} on ${model} — model may be down, trying next...`);
                    break;

                } else if (status === 400 || status === 404) {
                    // Bad/unknown model id — retrying CANNOT help, the model does not exist.
                    // Fail fast: retrying these used to burn ~3s per dead model, which
                    // exhausted the Cloud Function timeout before a live model was reached.
                    console.error(`[MODEL-CONFIG] ${status} on ${model} — model id invalid or unavailable. Skipping immediately. Update MODEL_CASCADE.`);
                    break;

                } else if (status === 401) {
                    // Real auth failure (missing/garbage/revoked key) — every model
                    // will fail the same way. Stop the whole cascade.
                    console.error(`[MODEL-CONFIG] 401 — OpenRouter rejected the API key. Check OPENROUTER_KEY in functions/.env.`);
                    throw new Error('OpenRouter rejected the API key (check OPENROUTER_KEY in functions/.env)');

                } else if (status === 403) {
                    // Forbidden — this is model-specific (e.g. a model restricted to
                    // "agentic harness" apps only), NOT necessarily a bad key. Do NOT
                    // abort the whole cascade here — skip this model and keep going,
                    // same as a 400/404. (Learned the hard way: this used to kill
                    // every single request because a bad model sat first in line.)
                    console.warn(`[MODEL-CONFIG] 403 on ${model} — forbidden for this model specifically. Skipping to next.`);
                    break;

                } else {
                    // Other error — log and try next model
                    console.error(`[MODEL-CONFIG] Error on ${model}:`, error.message || error);
                    if (attempt < maxRetries) {
                        await sleep(1000);
                        continue;
                    }
                    break;
                }
            }
        }
    }

    // All models exhausted
    console.error('[MODEL-CONFIG] All models in cascade failed. Last error:', lastError?.message || lastError);
    throw new Error(`All AI models unavailable. Last error: ${lastError?.message || 'unknown'}`);
}

/**
 * Get the primary model name (for logging/display)
 */
function getPrimaryModel() {
    return activeModels()[0];
}

/** The model behind the most recent reply in this instance (see lastModelUsed). */
function lastModel() {
    return lastModelUsed;
}

/**
 * Get the full cascade list (for debugging)
 */
function getModelCascade() {
    return [...MODEL_CASCADE];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    callAI,
    callAIDetailed,
    looksLikeReasoning,
    activeModels,
    hasImages,
    lastModel,
    getPrimaryModel,
    getModelCascade,
    openai, // Export for edge cases that need direct access
};
