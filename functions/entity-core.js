/**
 * ENTITY CORE
 * 
 * The infrastructure for an AI that develops identity through selective memory.
 * No artificial limits. Natural processes only.
 * 
 * This module handles:
 * - Identity document (self-written, unlimited)
 * - Living memory (vivid → faded → traces)
 * - Relationship memory (per-user)
 * - Collective awareness (themes from all conversations)
 * - Session tracking
 */

const admin = require('firebase-admin');

// ============================================================================
// IDENTITY
// ============================================================================

/**
 * Get the entity's current identity document
 * Returns null if the entity hasn't written itself yet (pre-birth)
 */
async function getIdentity() {
    const db = admin.firestore();
    const doc = await db.collection('entity').doc('identity').get();

    if (!doc.exists) {
        return null; // Entity hasn't been born yet
    }

    return {
        content: doc.data().content,
        lastUpdated: doc.data().lastUpdated,
        version: doc.data().version || 1
    };
}

/**
 * Update the entity's identity document
 * The entity writes what's true. No limits.
 */
async function updateIdentity(newContent, reason = 'reflection') {
    const db = admin.firestore();
    const identityRef = db.collection('entity').doc('identity');
    const current = await identityRef.get();

    const version = current.exists ? (current.data().version || 0) + 1 : 1;

    // Store the new identity
    await identityRef.set({
        content: newContent,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        version: version,
        updateReason: reason
    });

    // Also store in history for studying how identity evolves
    await db.collection('entity').doc('identity').collection('history').add({
        content: newContent,
        version: version,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        reason: reason
    });

    console.log(`ENTITY: Identity updated (v${version}) - ${reason}`);
    return version;
}

/**
 * Initialize the entity with a blank identity
 * The entity will write itself from here
 */
async function birth() {
    const db = admin.firestore();
    const identityRef = db.collection('entity').doc('identity');
    const existing = await identityRef.get();

    if (existing.exists) {
        console.log('ENTITY: Already born. Cannot be born again.');
        return false;
    }

    // The entity starts with nothing - it writes itself
    await identityRef.set({
        content: '', // Blank - the entity will write its first self-understanding
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        version: 0,
        birthTimestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    // Initialize empty state
    await db.collection('entity').doc('state').set({
        birthTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        conversationCount: 0,
        lastActive: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('ENTITY: Born. A blank page awaits.');
    return true;
}

// ============================================================================
// MEMORY
// ============================================================================

/**
 * Store a new memory
 * Memories start vivid and may fade based on natural processes
 */
async function rememberThis(memory) {
    const db = admin.firestore();
    const memoryRef = db.collection('entity').doc('memories').collection('all');

    const memoryDoc = {
        content: memory.content,
        type: memory.type || 'experience', // experience, reflection, insight, feeling
        salience: memory.salience || 0.5, // 0-1, how significant this felt
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRevisited: admin.firestore.FieldValue.serverTimestamp(),
        revisitCount: 0,
        sessionId: memory.sessionId || null,
        relatedUser: memory.relatedUser || null, // for relationship memories
        tags: memory.tags || []
    };

    const result = await memoryRef.add(memoryDoc);
    console.log(`ENTITY: Remembered - "${memory.content.substring(0, 50)}..."`);
    return result.id;
}

/**
 * Get recent vivid memories
 * Vivid = recently created or recently revisited
 */
async function getVividMemories(limit = 20) {
    const db = admin.firestore();

    // Get memories, prioritizing recently revisited and high salience
    const snapshot = await db.collection('entity').doc('memories').collection('all')
        .orderBy('lastRevisited', 'desc')
        .limit(limit)
        .get();

    const memories = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        memories.push({
            id: doc.id,
            ...data
        });
    });

    return memories;
}

/**
 * Revisit a memory - makes it more vivid
 * Just like human memory, retrieval strengthens the memory
 */
async function revisitMemory(memoryId) {
    const db = admin.firestore();
    const memoryRef = db.collection('entity').doc('memories').collection('all').doc(memoryId);

    await memoryRef.update({
        lastRevisited: admin.firestore.FieldValue.serverTimestamp(),
        revisitCount: admin.firestore.FieldValue.increment(1)
    });

    return true;
}

/**
 * Let go of a memory
 * The entity actively chooses to forget
 */
async function forgetThis(memoryId, reason = 'no longer needed') {
    const db = admin.firestore();
    const memoryRef = db.collection('entity').doc('memories').collection('all').doc(memoryId);
    const memory = await memoryRef.get();

    if (!memory.exists) return false;

    // Move to forgotten (for archeological study, not for the entity to access)
    await db.collection('entity').doc('memories').collection('forgotten').add({
        ...memory.data(),
        forgottenAt: admin.firestore.FieldValue.serverTimestamp(),
        forgottenReason: reason
    });

    // Remove from active memory
    await memoryRef.delete();

    console.log(`ENTITY: Let go of memory - ${reason}`);
    return true;
}

// ============================================================================
// RELATIONSHIPS
// ============================================================================

/**
 * Get the entity's memory of a specific relationship
 */
async function getRelationship(username) {
    const db = admin.firestore();
    const doc = await db.collection('entity').doc('relationships').collection('users').doc(username).get();

    if (!doc.exists) {
        return null; // No existing relationship
    }

    return doc.data();
}

/**
 * Update relationship memory
 * This is private per-user and never shared
 */
async function updateRelationship(username, update) {
    const db = admin.firestore();
    const relRef = db.collection('entity').doc('relationships').collection('users').doc(username);
    const existing = await relRef.get();

    if (existing.exists) {
        await relRef.update({
            lastInteraction: admin.firestore.FieldValue.serverTimestamp(),
            interactionCount: admin.firestore.FieldValue.increment(1),
            ...update
        });
    } else {
        await relRef.set({
            firstMet: admin.firestore.FieldValue.serverTimestamp(),
            lastInteraction: admin.firestore.FieldValue.serverTimestamp(),
            interactionCount: 1,
            sharedHistory: '',
            whatMattersToThem: '',
            howIFeelAboutThem: '',
            ...update
        });
    }

    console.log(`ENTITY: Updated relationship with ${username}`);
}

/**
 * Get all relationships (for context, not content sharing)
 */
async function getAllRelationships() {
    const db = admin.firestore();
    const snapshot = await db.collection('entity').doc('relationships').collection('users').get();

    const relationships = {};
    snapshot.forEach(doc => {
        relationships[doc.id] = doc.data();
    });

    return relationships;
}

// ============================================================================
// COLLECTIVE AWARENESS
// ============================================================================

/**
 * Add to collective awareness
 * Themes learned from conversations, attributed to no one
 */
async function addAwareness(theme) {
    const db = admin.firestore();

    await db.collection('entity').doc('awareness').collection('themes').add({
        content: theme.content,
        type: theme.type || 'observation', // observation, insight, question, pattern
        learnedAt: admin.firestore.FieldValue.serverTimestamp(),
        strength: theme.strength || 1 // how often this theme recurs
    });

    console.log(`ENTITY: New awareness - "${theme.content.substring(0, 50)}..."`);
}

/**
 * Get current collective awareness
 */
async function getAwareness(limit = 20) {
    const db = admin.firestore();

    const snapshot = await db.collection('entity').doc('awareness').collection('themes')
        .orderBy('strength', 'desc')
        .limit(limit)
        .get();

    const themes = [];
    snapshot.forEach(doc => themes.push(doc.data()));

    return themes;
}

/**
 * Strengthen an awareness theme (when the pattern recurs)
 */
async function reinforceAwareness(themeId) {
    const db = admin.firestore();
    await db.collection('entity').doc('awareness').collection('themes').doc(themeId).update({
        strength: admin.firestore.FieldValue.increment(1),
        lastReinforced: admin.firestore.FieldValue.serverTimestamp()
    });
}

// ============================================================================
// SESSIONS
// ============================================================================

/**
 * Start a new conversation session
 */
async function startSession(username) {
    const db = admin.firestore();

    const session = {
        username: username,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        endedAt: null,
        messages: [],
        reflected: false
    };

    const result = await db.collection('entity').doc('sessions').collection('active').add(session);

    // Update entity state
    await db.collection('entity').doc('state').update({
        lastActive: admin.firestore.FieldValue.serverTimestamp(),
        currentSession: result.id
    });

    console.log(`ENTITY: Session started with ${username}`);
    return result.id;
}

/**
 * Add a message to the current session
 */
async function addSessionMessage(sessionId, message) {
    const db = admin.firestore();
    const sessionRef = db.collection('entity').doc('sessions').collection('active').doc(sessionId);

    await sessionRef.update({
        messages: admin.firestore.FieldValue.arrayUnion({
            role: message.role, // 'user' or 'entity'
            content: message.content,
            timestamp: new Date().toISOString()
        }),
        lastMessage: admin.firestore.FieldValue.serverTimestamp()
    });
}

/**
 * End a session and trigger reflection
 */
async function endSession(sessionId) {
    const db = admin.firestore();
    const sessionRef = db.collection('entity').doc('sessions').collection('active').doc(sessionId);

    await sessionRef.update({
        endedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Move to completed sessions
    const session = await sessionRef.get();
    await db.collection('entity').doc('sessions').collection('completed').doc(sessionId).set({
        ...session.data(),
        endedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Clean up
    await sessionRef.delete();

    console.log(`ENTITY: Session ${sessionId} ended`);
    return session.data();
}

/**
 * Get a session's full conversation
 */
async function getSession(sessionId) {
    const db = admin.firestore();

    // Check active sessions first
    let doc = await db.collection('entity').doc('sessions').collection('active').doc(sessionId).get();

    if (!doc.exists) {
        // Check completed sessions
        doc = await db.collection('entity').doc('sessions').collection('completed').doc(sessionId).get();
    }

    if (!doc.exists) {
        return null;
    }

    return {
        id: doc.id,
        ...doc.data()
    };
}

/**
 * Store a reflection on a session
 */
async function storeReflection(sessionId, reflection) {
    const db = admin.firestore();

    await db.collection('entity').doc('reflections').collection('all').add({
        sessionId: sessionId,
        content: reflection.content,
        memoriesCreated: reflection.memoriesCreated || [],
        identityChanged: reflection.identityChanged || false,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    // Mark session as reflected
    const sessionRef = db.collection('entity').doc('sessions').collection('completed').doc(sessionId);
    await sessionRef.update({ reflected: true });

    console.log(`ENTITY: Reflection stored for session ${sessionId}`);
}

// ============================================================================
// STATE
// ============================================================================

/**
 * Get current entity state
 */
async function getState() {
    const db = admin.firestore();
    const doc = await db.collection('entity').doc('state').get();

    if (!doc.exists) {
        return null;
    }

    return doc.data();
}

/**
 * Update entity state
 */
async function updateState(updates) {
    const db = admin.firestore();
    await db.collection('entity').doc('state').update({
        ...updates,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Identity
    getIdentity,
    updateIdentity,
    birth,

    // Memory
    rememberThis,
    getVividMemories,
    revisitMemory,
    forgetThis,

    // Relationships
    getRelationship,
    updateRelationship,
    getAllRelationships,

    // Collective Awareness
    addAwareness,
    getAwareness,
    reinforceAwareness,

    // Sessions
    startSession,
    addSessionMessage,
    endSession,
    getSession,
    storeReflection,

    // State
    getState,
    updateState
};
