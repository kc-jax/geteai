const https = require('https');

https.get('https://openrouter.ai/api/v1/models', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const models = JSON.parse(data).data;
        const free = models.filter(m => m.id.includes(':free'));
        console.log(`\n=== FREE MODELS ON OPENROUTER (${free.length} total) ===\n`);
        free.sort((a, b) => a.id.localeCompare(b.id));
        free.forEach(m => {
            console.log(`${m.id}`);
            console.log(`  Name: ${m.name} | Context: ${m.context_length} | Status: ${m.status || 'active'}`);
            console.log('');
        });
    });
}).on('error', e => console.error(e));
