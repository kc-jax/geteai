const fs = require('fs');
const https = require('https');

const envContent = fs.readFileSync('./functions/.env', 'utf8');
const API_KEY = envContent.match(/OPENROUTER_KEY=(.*)/)?.[1]?.trim();

const MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-3-27b-it:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'qwen/qwen3-coder:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'arcee-ai/trinity-large-preview:free',
    'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    'minimax/minimax-m2.5:free',
    'openai/gpt-oss-120b:free',
    'stepfun/step-3.5-flash:free'
];

async function testModel(model) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: 'Say "YES" if you can hear me. Say nothing else.' }],
            max_tokens: 20
        });

        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://geteai.org',
                'X-Title': 'geteai test'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const json = JSON.parse(data);
                    resolve({ model, status: 'OK', content: json.choices[0].message.content });
                } else if (res.statusCode === 429) {
                    resolve({ model, status: '429 Rate Limit' });
                } else {
                    resolve({ model, status: `Error ${res.statusCode}` });
                }
            });
        });
        req.on('error', () => resolve({ model, status: 'Network Error' }));
        req.write(body);
        req.end();
    });
}

async function main() {
    console.log("Testing models concurrently...");
    const promises = MODELS.map(async (m) => {
        const t1 = Date.now();
        const res = await testModel(m);
        const t2 = Date.now();
        console.log(`[${res.status.padEnd(15)}] ${m} (${t2-t1}ms) -> ${res.content || ''}`);
        return res;
    });
    const results = await Promise.all(promises);
    const working = results.filter(r => r.status === 'OK');
    console.log(`\nWorking models: ${working.length}/${MODELS.length}`);
}

main();
