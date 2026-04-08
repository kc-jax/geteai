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
const functions = require('firebase-functions');

// API key: Firebase config first, then .env fallback
const OPENAI_API_KEY = functions.config().openrouter?.key || process.env.OPENROUTER_KEY;

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: "https://openrouter.ai/api/v1"
});

// ============================================================================
// MODEL CASCADE
// ============================================================================
// Ordered by preference. Each is free. If one 429s, we try the next.
// The last entry `openrouter/free` is OpenRouter's auto-router that picks
// the best available free model automatically — our ultimate safety net.

const MODEL_CASCADE = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'openai/gpt-oss-120b:free',
    'arcee-ai/trinity-large-preview:free',
    'arcee-ai/trinity-mini:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'google/gemma-3-27b-it:free',
    'minimax/minimax-m2.5:free',
    'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    'qwen/qwen3-coder:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'stepfun/step-3.5-flash:free',
    'openrouter/auto'
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

                // Success! Log which model worked if it wasn't the primary
                if (modelIndex > 0 || attempt > 0) {
                    console.log(`[MODEL-CONFIG] Success on model=${model} (cascade index ${modelIndex}, attempt ${attempt})`);
                }

                return completion.choices[0].message.content;

            } catch (error) {
                lastError = error;
                const status = error?.status || error?.response?.status || 0;

                if (status === 429) {
                    // Rate limited — try backoff then next model
                    const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                    console.warn(`[MODEL-CONFIG] 429 on ${model} (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${delay}ms...`);

                    if (attempt < maxRetries) {
                        await sleep(delay);
                        continue; // retry same model
                    }

                    // Exhausted retries on this model, fall through to next
                    console.warn(`[MODEL-CONFIG] Exhausted retries on ${model}, trying next model...`);
                    break;

                } else if (status === 402) {
                    // Payment required — this model costs money, skip immediately
                    console.warn(`[MODEL-CONFIG] 402 on ${model} — skipping (requires credits)`);
                    break;

                } else if (status === 503 || status === 502) {
                    // Service unavailable — model might be down
                    console.warn(`[MODEL-CONFIG] ${status} on ${model} — model may be down, trying next...`);
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
