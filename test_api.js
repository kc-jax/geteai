// Quick end-to-end test of the model cascade
const fs = require('fs');
const https = require('https');

// Read key from .env file directly
const envContent = fs.readFileSync('./functions/.env', 'utf8');
const API_KEY = envContent.match(/OPENROUTER_KEY=(.*)/)?.[1]?.trim();
const MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-4-31b-it:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'google/gemma-3-27b-it:free',
    'openrouter/auto',
];

async function testModel(model) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: 'Say hello in exactly 5 words.' }],
            max_tokens: 50
        });

        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://geteai.org',
                'X-Title': 'geteai - API Test'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const json = JSON.parse(data);
                    resolve({
                        model,
                        status: 'OK',
                        response: json.choices[0].message.content.substring(0, 80)
                    });
                } else {
                    resolve({
                        model,
                        status: `FAIL (${res.statusCode})`,
                        error: data.substring(0, 120)
                    });
                }
            });
        });

        req.on('error', (e) => resolve({ model, status: 'ERROR', error: e.message }));
        req.write(body);
        req.end();
    });
}

async function main() {
    console.log('=== Testing Model Cascade ===\n');
    console.log(`API Key: ${API_KEY ? API_KEY.substring(0, 15) + '...' : 'MISSING!'}\n`);

    for (const model of MODELS) {
        process.stdout.write(`Testing ${model}... `);
        const result = await testModel(model);
        if (result.status === 'OK') {
            console.log(`✓ OK — "${result.response}"`);
        } else {
            console.log(`✗ ${result.status} — ${result.error}`);
        }
    }

    console.log('\n=== Test Complete ===');
}

main();
