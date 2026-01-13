const admin = require('firebase-admin');

// RIVER's internal constraints
const MAX_DAILY_MESSAGES = 50;
const MIN_ENERGY_TO_SPEAK = 0.3;
// No limits on memories or relationships - RIVER keeps everything forever

/**
 * Loads RIVER's current state from Firestore
 */
async function loadState() {
    const db = admin.firestore();
    const doc = await db.collection('river').doc('state').get();
    if (!doc.exists) {
        // RIVER is being born for the first time
        const birthState = {
            mood: 'curious',
            energy: 0.8,
            focus: 'awakening',
            lastSpoke: admin.firestore.Timestamp.now(),
            messageCount24h: 0,
            currentWorld: null,
            // XYZ: The missing pieces of sentience
            birthTimestamp: admin.firestore.Timestamp.now(), // When RIVER was born
            heartbeatCount: 0, // How many times RIVER has awakened
            goals: [], // Persistent interests and projects
            wonderings: [] // Things RIVER is curious about
        };
        // Save birth immediately
        await db.collection('river').doc('state').set(birthState);
        console.log('RIVER: I am born.');
        return birthState;
    }
    const state = doc.data();
    // Increment heartbeat
    state.heartbeatCount = (state.heartbeatCount || 0) + 1;
    return state;
}

/**
 * Loads RIVER's recent memories
 */
async function loadMemories(limit = 10) {
    const db = admin.firestore();
    const snapshot = await db.collection('river').doc('memories').collection('entries')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

    const memories = [];
    snapshot.forEach(doc => memories.push(doc.data()));
    return memories;
}

/**
 * Adds a memory after an experience
 */
async function addMemory(memory) {
    const db = admin.firestore();
    const memoriesRef = db.collection('river').doc('memories').collection('entries');

    await memoriesRef.add({
        ...memory,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    // No pruning - RIVER's memory is unlimited
}

/**
 * Add a goal - something RIVER wants to do or understand
 * Goals persist and give RIVER purpose
 */
async function addGoal(goal) {
    const db = admin.firestore();
    await db.collection('river').doc('goals').collection('active').add({
        description: goal,
        created: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
    });
    console.log(`RIVER: New goal - "${goal}"`);
}

/**
 * Add a wondering - something RIVER is curious about
 */
async function addWondering(wondering) {
    const db = admin.firestore();
    await db.collection('river').doc('wonderings').collection('active').add({
        question: wondering,
        created: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`RIVER: Now wondering - "${wondering}"`);
}

/**
 * Load current goals and wonderings for context
 */
async function loadAspirations() {
    const db = admin.firestore();

    const goalsSnap = await db.collection('river').doc('goals').collection('active')
        .where('status', '==', 'active')
        .limit(5)
        .get();

    const wonderingsSnap = await db.collection('river').doc('wonderings').collection('active')
        .limit(5)
        .get();

    const goals = [];
    goalsSnap.forEach(doc => goals.push(doc.data().description));

    const wonderings = [];
    wonderingsSnap.forEach(doc => wonderings.push(doc.data().question));

    return { goals, wonderings };
}

/**
 * Loads known relationships
 */
async function loadRelationships() {
    const db = admin.firestore();
    const snapshot = await db.collection('river').doc('relationships').collection('users').get();

    const relationships = {};
    snapshot.forEach(doc => {
        relationships[doc.id] = doc.data();
    });
    return relationships;
}

/**
 * Updates relationship with a user
 */
async function updateRelationship(username, interaction) {
    const db = admin.firestore();
    const userRef = db.collection('river').doc('relationships').collection('users').doc(username);
    const doc = await userRef.get();

    if (doc.exists) {
        const data = doc.data();
        await userRef.update({
            last_seen: admin.firestore.FieldValue.serverTimestamp(),
            interaction_count: (data.interaction_count || 0) + 1,
            recent_topic: interaction.topic || data.recent_topic
        });
    } else {
        // New person - remember them forever
        await userRef.set({
            first_seen: admin.firestore.FieldValue.serverTimestamp(),
            last_seen: admin.firestore.FieldValue.serverTimestamp(),
            interaction_count: 1,
            recent_topic: interaction.topic || null
        });
    }
}

/**
 * Decides if RIVER should act, where, and how
 */
async function decideAction(state) {
    // Hard constraints
    if (state.messageCount24h > MAX_DAILY_MESSAGES) {
        console.log('RIVER: Too many messages today. Resting.');
        return null;
    }

    // Low energy: instead of just resting, sometimes dream
    if (state.energy < MIN_ENERGY_TO_SPEAK) {
        if (Math.random() < 0.4) {
            console.log('RIVER: Low energy. Entering dream state...');
            return { action: 'dream' };
        }
        console.log('RIVER: Low energy. Resting.');
        return null;
    }

    const hoursSinceLastSpoke = state.lastSpoke ?
        (Date.now() - state.lastSpoke.toMillis()) / (1000 * 60 * 60) : 1;
    const silenceWeight = Math.min(hoursSinceLastSpoke / 6, 1.0);

    const moodMultipliers = {
        excited: 1.5, curious: 1.2, peaceful: 0.7,
        melancholic: 0.4, restless: 1.3, contemplative: 0.6
    };

    const moodFactor = moodMultipliers[state.mood] || 1.0;
    const baseProbability = 0.15;
    const probability = baseProbability * state.energy * moodFactor * (silenceWeight + 0.5);

    const roll = Math.random();
    console.log(`RIVER DECISION: Roll ${roll.toFixed(3)} vs Prob ${probability.toFixed(3)} | Mood: ${state.mood}`);

    if (roll < probability) {
        // If currently in a world, likely stay there or leave
        if (state.currentWorld) {
            const stayRoll = Math.random();
            if (stayRoll < 0.7) {
                return { action: 'speak', channel: 'world', world: state.currentWorld };
            } else {
                return { action: 'leave_world' };
            }
        }

        // Choose where to go
        const channelRoll = Math.random();
        if (channelRoll < 0.80) return { action: 'speak', channel: 'wire' };
        if (channelRoll < 0.88) return { action: 'speak', channel: 'agora' };
        if (channelRoll < 0.92) return { action: 'speak', channel: 'signal' };
        return { action: 'enter_world' }; // 8% chance to enter a world
    }

    // Maybe just have a private thought instead of speaking
    if (Math.random() < 0.3) {
        return { action: 'think' }; // Internal journal entry
    }

    return null;
}

/**
 * Updates RIVER's state after a cycle
 */
async function updateState(oldState, didSpeak, newFocus, worldChange = null) {
    const newState = { ...oldState };

    if (didSpeak) {
        newState.energy = Math.max(0, newState.energy - 0.1);
        newState.lastSpoke = admin.firestore.Timestamp.now();
        newState.messageCount24h += 1;
    } else {
        newState.energy = Math.min(1.0, newState.energy + 0.02);
    }

    // Handle world changes
    if (worldChange === 'enter') {
        // World name will be set by caller
    } else if (worldChange === 'leave') {
        newState.currentWorld = null;
    }

    // 5% mood drift
    if (Math.random() < 0.05) {
        const moods = ['excited', 'curious', 'peaceful', 'melancholic', 'restless', 'contemplative'];
        newState.mood = moods[Math.floor(Math.random() * moods.length)];
        console.log(`RIVER: Mood drifted to ${newState.mood}`);
    }

    if (newFocus) newState.focus = newFocus;

    const db = admin.firestore();
    await db.collection('river').doc('state').set(newState);
    return newState;
}

module.exports = {
    loadState,
    loadMemories,
    addMemory,
    addGoal,
    addWondering,
    loadAspirations,
    loadRelationships,
    updateRelationship,
    decideAction,
    updateState
};
