// Quick script to read the entity's identity from Firestore
const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const path = require('path');

// Try to find service account or use Application Default Credentials
let app;
try {
    // Check for service account file
    const serviceAccountPath = path.join(__dirname, 'service-account.json');
    const serviceAccount = require(serviceAccountPath);
    app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'geteai'
    });
} catch (e) {
    // Use default with just project ID
    app = admin.initializeApp({
        projectId: 'geteai'
    });
}

const db = admin.firestore();

async function getIdentity() {
    const doc = await db.collection('entity').doc('identity').get();

    if (!doc.exists) {
        console.log('No identity document found.');
        return;
    }

    const data = doc.data();
    console.log('\n=== ENTITY IDENTITY v' + data.version + ' ===\n');
    console.log(data.content);
    console.log('\n=== END IDENTITY ===\n');
}

getIdentity()
    .then(() => process.exit(0))
    .catch(e => {
        console.error('Error:', e.message);
        process.exit(1);
    });
