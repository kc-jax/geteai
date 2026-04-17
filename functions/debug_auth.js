
require('dotenv').config();
const OpenAI = require('openai');
const admin = require('firebase-admin');
// Mock functions.config() if not available in this context
let functionsConfig = {};
try {
    const functions = require('firebase-functions');
    functionsConfig = functions.config();
} catch (e) {
    console.log("Firebase functions module not fully loaded or config not available locally.");
}

console.log("--- DEBUGGING AUTH ---");

const envKey = process.env.OPENROUTER_KEY;
const configKey = functionsConfig.openrouter?.key;

console.log(`process.env.OPENROUTER_KEY present: ${!!envKey}`);
console.log(`functions.config().openrouter.key present: ${!!configKey}`);

const OPENAI_API_KEY = configKey || envKey;

if (!OPENAI_API_KEY) {
    console.error("CRITICAL: No API Key found in env or functions config!");
} else {
    console.log(`API Key found (length: ${OPENAI_API_KEY.length}, starts with: ${OPENAI_API_KEY.substring(0, 4)}...)`);
}

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY || "dummy-key",
    baseURL: "https://openrouter.ai/api/v1"
});

async function testConnection() {
    console.log("\nAttempting API call to OpenRouter...");
    try {
        const completion = await openai.chat.completions.create({
            model: "xiaomi/mimo-v2-flash:free",
            messages: [{ role: "user", content: "Ping" }],
        });
        console.log("SUCCESS: API call worked!");
        console.log("Response:", completion.choices[0].message.content);
    } catch (error) {
        console.error("FAILURE: API call failed.");
        console.error(`Error Status: ${error.status}`);
        console.error(`Error Message: ${error.message}`);
        if (error.status === 401) {
            console.error("VERDICT: 401 Unauthorized. The API Key is invalid, expired, or missing.");
        }
    }
}

testConnection();
