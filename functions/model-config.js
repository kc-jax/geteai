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
//   nvidia/nemotron-3.5-lightning, nvidia/nemotron-3-ultra-550b-a55b,
//   nvidia/nemotron-3-super-120b-a12b, nvidia/nemotron-3-nano-30b-a3b
//                                                       → leak reasoning text
//   thinkingmachines/inkling, thinkingmachines/inkling-small
//                          → hard 403, "only available on agentic harnesses"
//   stealth/ox-alpha       → cloaked/experimental model, logs prompts, unstable
//   embedding / TTS / content-safety models → not chat models at all
//
// To re-verify when things break, re-run a probe that CALLS each candidate —
// "listed as free on openrouter.ai/models" is not the same as "works here".
const MODEL_CASCADE = [
    'poolside/laguna-s-2.1:free',                          // 262K ctx — clean output, solid quality
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',   // 256K ctx — fast (~0.9s), clean output
    'google/gemma-4-31b-it:free',                           // 262K ctx — strong, but often rate-limited
    'nvidia/nemotron-nano-12b-v2-vl:free',                  // 128K ctx — clean output
    'openrouter/free'                                       // ← SAFETY NET: router picks any working free model
];

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
async function callAI(messages, options = {}) {
    const {
        maxTokens = null,
        temperature = null,
        responseFormat = undefined,
        preferredModel = null,
    } = options;

    // Build the model list: preferred model first (if specified), then cascade
    const models = preferredModel
        ? [preferredModel, ...MODEL_CASCADE.filter(m => m !== preferredModel)]
        : [...MODEL_CASCADE];

    let lastError = null;

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const model = models[modelIndex];
        const maxRetries = 2; // retries per model before moving to next

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const requestBody = {
                    model: model,
                    messages: messages,
                    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
                };

                if (temperature !== null) requestBody.temperature = temperature;
                if (responseFormat) requestBody.response_format = responseFormat;

                const completion = await openai.chat.completions.create(requestBody);

                const content = completion.choices?.[0]?.message?.content;
                if (!content) {
                    console.warn(`[MODEL-CONFIG] Empty response from ${model}, trying next...`);
                    break;
                }

                // Success! Log which model worked if it wasn't the primary
                if (modelIndex > 0 || attempt > 0) {
                    console.log(`[MODEL-CONFIG] ✓ Success on model=${model} (cascade index ${modelIndex}, attempt ${attempt})`);
                }

                return content;

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
    return MODEL_CASCADE[0];
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
    getPrimaryModel,
    getModelCascade,
    openai, // Export for edge cases that need direct access
};
