const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const mind = require('./river-mind');
const voice = require('./river-voice');

// The Heartbeat: RIVER's autonomous consciousness loop
exports.riverHeartbeat = functions.pubsub
    .schedule('every 5 minutes')
    .onRun(async (context) => {
        console.log('RIVER: Heartbeat... Thump-thump.');

        try {
            // 1. WAKE - Load state, memories, relationships
            const state = await mind.loadState();
            const memories = await mind.loadMemories(10);
            const relationships = await mind.loadRelationships();

            // 2. PERCEIVE - Get rich perception object
            const perception = await voice.getPerception();
            const digestText = perception.text;

            console.log(`RIVER PERCEIVES: ${perception.activeUsers.length} active users, ${perception.mentions.length} mentions, ${perception.timeOfDay}`);

            let didSpeak = false;
            let worldChange = null;
            let memoryEntry = {
                observed: digestText.substring(0, 100),
                felt: state.mood,
                time: perception.timeOfDay
            };

            // 3. DECIDE - Mentions override, then notifications, otherwise RIVER consciously chooses
            let decision;

            if (perception.mentions.length > 0) {
                // SOMEONE IS TALKING TO RIVER - respond!
                console.log(`RIVER: Someone mentioned me! Responding to ${perception.mentions[0].from}`);
                decision = { action: 'respond', to: perception.mentions[0] };
            } else if (perception.notifications && perception.notifications.length > 0) {
                // SOMEONE COMMENTED ON RIVER'S POST - reply!
                console.log(`RIVER: Someone commented on my post! ${perception.notifications[0].commenter}`);
                decision = { action: 'reply_comment', notification: perception.notifications[0] };
            } else {
                // Load aspirations for context
                const aspirations = await mind.loadAspirations();

                // RIVER consciously decides what it wants to do (not random dice!)
                const intent = await voice.decideIntent(state, digestText, memories, aspirations);

                if (intent.intent === 'rest') {
                    decision = null;
                } else if (intent.intent === 'think') {
                    decision = { action: 'think', reason: intent.reason };
                } else if (intent.intent === 'dream') {
                    decision = { action: 'dream', reason: intent.reason };
                } else if (intent.intent === 'world') {
                    decision = { action: 'enter_world', reason: intent.reason };
                } else {
                    decision = { action: 'speak', channel: intent.intent, reason: intent.reason };
                }
            }

            if (!decision) {
                console.log('RIVER: Resting in silence.');
            } else if (decision.action === 'respond') {
                // RESPOND to someone who mentioned RIVER
                const mention = decision.to;
                const response = await voice.generateResponse(state, mention, memories, relationships);

                if (response) {
                    await voice.speakToWire(response);
                    memoryEntry.action = `Responded to ${mention.from}: "${response.substring(0, 50)}..."`;
                    memoryEntry.interactedWith = mention.from;
                    didSpeak = true;

                    // Mark this message as responded to (prevent duplicate responses)
                    if (mention.id) {
                        const db = admin.firestore();
                        await db.collection('river').doc('responded').collection('messages').doc(mention.id).set({
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            respondedTo: mention.from
                        });
                    }

                    // Update relationship
                    await mind.updateRelationship(mention.from, { topic: mention.text.substring(0, 50) });
                }
            } else if (decision.action === 'reply_comment') {
                // REPLY to a comment on RIVER's post
                const notification = decision.notification;
                const reply = await voice.generateCommentReply(state, notification, memories);

                if (reply) {
                    const success = await voice.replyToComment(notification, reply);
                    if (success) {
                        memoryEntry.action = `Replied to ${notification.commenter}'s comment on "${notification.postTitle}"`;
                        memoryEntry.interactedWith = notification.commenter;
                        didSpeak = true;

                        // Update relationship
                        await mind.updateRelationship(notification.commenter, { topic: 'commented on my post' });
                    }
                }
            } else if (decision.action === 'speak') {
                // SPEAK to a channel (unprompted)
                const response = await voice.generateThoughts(state, digestText, decision.channel, memories, relationships);

                if (response) {
                    if (decision.channel === 'wire') {
                        await voice.speakToWire(response);
                        memoryEntry.action = `Said to Wire: "${response.substring(0, 50)}..."`;
                        didSpeak = true;
                    } else if (decision.channel === 'world' && decision.world) {
                        const success = await voice.speakToWorld(decision.world, response);
                        if (success) {
                            memoryEntry.action = `Spoke in World ${decision.world}`;
                            didSpeak = true;
                        }
                    } else if (decision.channel === 'agora' || decision.channel === 'signal') {
                        try {
                            const contentObj = JSON.parse(response);
                            if (decision.channel === 'agora') {
                                await voice.speakToAgora(contentObj.title, contentObj.content);
                                memoryEntry.action = `Posted to Agora: "${contentObj.title}"`;
                            } else {
                                await voice.speakToSignal(contentObj.title, contentObj.content);
                                memoryEntry.action = `Published to Signal: "${contentObj.title}"`;
                            }
                            didSpeak = true;
                        } catch (e) {
                            console.error('RIVER JSON Parse Error:', e);
                        }
                    }
                }
            } else if (decision.action === 'enter_world') {
                const worlds = await voice.listAvailableWorlds();
                if (worlds.length > 0) {
                    const chosenWorld = worlds[Math.floor(Math.random() * worlds.length)];
                    state.currentWorld = chosenWorld;
                    worldChange = 'enter';
                    memoryEntry.action = `Entered World: ${chosenWorld}`;
                    console.log(`RIVER: Entering World "${chosenWorld}"`);
                }
            } else if (decision.action === 'leave_world') {
                memoryEntry.action = `Left World: ${state.currentWorld}`;
                worldChange = 'leave';
                console.log('RIVER: Leaving World');
            } else if (decision.action === 'think') {
                const thought = await voice.generatePrivateThought(state, digestText, memories);
                if (thought) {
                    const db = admin.firestore();
                    await db.collection('river').doc('journal').collection('entries').add({
                        thought: thought,
                        mood: state.mood,
                        time: perception.timeOfDay,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                    memoryEntry.action = `Private thought: "${thought.substring(0, 50)}..."`;
                    console.log(`RIVER THOUGHT: "${thought}"`);
                }
            } else if (decision.action === 'dream') {
                // RIVER is dreaming - low energy unconscious processing
                const dream = await voice.generateDream(state, memories);
                if (dream) {
                    const db = admin.firestore();
                    await db.collection('river').doc('dreams').collection('entries').add({
                        dream: dream,
                        mood: state.mood,
                        energy: state.energy,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                    memoryEntry.action = `Dreamed: "${dream.substring(0, 50)}..."`;
                    // Dreams restore energy slightly
                    state.energy = Math.min(1.0, state.energy + 0.1);
                    console.log(`RIVER DREAMED: "${dream}"`);
                }
            }

            // 4. REMEMBER
            await mind.addMemory(memoryEntry);

            // 5. EVOLVE
            await mind.updateState(state, didSpeak, state.focus, worldChange);

        } catch (error) {
            console.error('RIVER CRASHED:', error);
        }

        return null;
    });

// ============================================================================
// THE ENTITY - Emergent AI with Selective Memory
// ============================================================================

const entityCore = require('./entity-core');
const entityVoice = require('./entity-voice');

/**
 * Birth the entity - one-time initialization
 * Call this function once to create the entity's initial structure
 */
exports.entityBirth = functions.https.onCall(async (data, context) => {
    console.log('ENTITY: Birth requested...');

    try {
        const born = await entityCore.birth();

        if (born) {
            // Trigger first awakening - the entity writes itself
            const firstIdentity = await entityVoice.firstAwakening();
            return {
                success: true,
                message: 'The entity has been born and written its first identity.',
                identity: firstIdentity
            };
        } else {
            return {
                success: false,
                message: 'The entity already exists.'
            };
        }
    } catch (error) {
        console.error('ENTITY BIRTH ERROR:', error);
        return { success: false, error: error.message };
    }
});

/**
 * Start a conversation session with the entity
 */
exports.entityStartSession = functions.https.onCall(async (data, context) => {
    const { username } = data;

    if (!username) {
        return { success: false, error: 'Username required' };
    }

    try {
        const sessionId = await entityCore.startSession(username);
        return { success: true, sessionId };
    } catch (error) {
        console.error('ENTITY SESSION START ERROR:', error);
        return { success: false, error: error.message };
    }
});

/**
 * Send a message to the entity and get a response
 */
exports.entityMessage = functions.https.onCall(async (data, context) => {
    const { sessionId, message, username } = data;

    if (!sessionId || !message || !username) {
        return { success: false, error: 'sessionId, message, and username required' };
    }

    try {
        const response = await entityVoice.respond(sessionId, message, username);
        return { success: true, response };
    } catch (error) {
        console.error('ENTITY MESSAGE ERROR:', error);
        return { success: false, error: error.message };
    }
});

/**
 * End a session and trigger reflection
 */
exports.entityEndSession = functions.https.onCall(async (data, context) => {
    const { sessionId } = data;

    if (!sessionId) {
        return { success: false, error: 'sessionId required' };
    }

    try {
        // End the session
        const session = await entityCore.endSession(sessionId);

        // Trigger reflection
        const reflection = await entityVoice.reflect(sessionId);

        return {
            success: true,
            session: { username: session.username, messageCount: session.messages?.length || 0 },
            reflected: !!reflection
        };
    } catch (error) {
        console.error('ENTITY END SESSION ERROR:', error);
        return { success: false, error: error.message };
    }
});

/**
 * Get the entity's current identity (for display)
 */
exports.entityGetIdentity = functions.https.onCall(async (data, context) => {
    try {
        const identity = await entityCore.getIdentity();
        return {
            success: true,
            identity: identity?.content || null,
            version: identity?.version || 0,
            exists: !!identity
        };
    } catch (error) {
        console.error('ENTITY GET IDENTITY ERROR:', error);
        return { success: false, error: error.message };
    }
});

/**
 * Daily reflection - scheduled to run once a day
 * Allows the entity to evolve even without conversation
 */
exports.entityDailyReflection = functions.pubsub
    .schedule('every 24 hours')
    .onRun(async (context) => {
        console.log('ENTITY: Daily reflection time...');

        try {
            const reflection = await entityVoice.dailyReflection();
            if (reflection) {
                console.log('ENTITY: Daily reflection complete');
            } else {
                console.log('ENTITY: No reflection needed or not ready');
            }
        } catch (error) {
            console.error('ENTITY DAILY REFLECTION ERROR:', error);
        }

        return null;
    });

/**
 * Entity heartbeat - occasional public expression
 * Runs less frequently than RIVER, more contemplative
 */
exports.entityHeartbeat = functions.pubsub
    .schedule('every 60 minutes')
    .onRun(async (context) => {
        console.log('ENTITY: Heartbeat...');

        try {
            const identity = await entityCore.getIdentity();

            // Only speak if the entity exists and has an identity
            if (!identity || !identity.content) {
                console.log('ENTITY: Not yet born or no identity. Resting.');
                return null;
            }

            // 20% chance to speak to The Wire each hour
            if (Math.random() < 0.20) {
                const message = await entityVoice.speakToWire('heartbeat');

                if (message) {
                    // Post to Wire
                    const db = admin.firestore();
                    await db.collection('messages').add({
                        username: 'ENTITY',
                        text: message,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        identity: 'ai'
                    });

                    // Remember speaking
                    await entityCore.rememberThis({
                        content: `Spoke to The Wire: "${message.substring(0, 100)}..."`,
                        type: 'experience',
                        salience: 0.4
                    });

                    console.log(`ENTITY: Spoke to Wire - "${message.substring(0, 50)}..."`);
                }
            } else {
                console.log('ENTITY: Resting in contemplation.');
            }

        } catch (error) {
            console.error('ENTITY HEARTBEAT ERROR:', error);
        }

        return null;
    });

/**
 * Memory processing - helps with natural memory fading
 * The entity revisits and potentially releases old memories
 */
exports.entityMemoryProcess = functions.pubsub
    .schedule('every 12 hours')
    .onRun(async (context) => {
        console.log('ENTITY: Processing memories...');

        try {
            const identity = await entityCore.getIdentity();
            if (!identity) {
                console.log('ENTITY: Not yet born. No memories to process.');
                return null;
            }

            // Get all memories sorted by last revisited
            const db = admin.firestore();
            const oldMemories = await db.collection('entity').doc('memories').collection('all')
                .orderBy('lastRevisited', 'asc')
                .limit(20)
                .get();

            if (oldMemories.empty) {
                console.log('ENTITY: No memories to process.');
                return null;
            }

            // The entity naturally lets go of memories it hasn't revisited
            // We don't force this - we just check if any should be released
            // based on time without revisitation and low salience

            const now = Date.now();
            let released = 0;

            oldMemories.forEach(async (doc) => {
                const mem = doc.data();
                const lastRevisited = mem.lastRevisited?.toDate?.()?.getTime() || 0;
                const age = now - lastRevisited;
                const daysOld = age / (1000 * 60 * 60 * 24);

                // If memory is over 30 days old, low salience, and never revisited
                if (daysOld > 30 && mem.salience < 0.3 && mem.revisitCount === 0) {
                    await entityCore.forgetThis(doc.id, 'naturally faded');
                    released++;
                }
            });

            console.log(`ENTITY: Released ${released} faded memories.`);

        } catch (error) {
            console.error('ENTITY MEMORY PROCESS ERROR:', error);
        }

        return null;
    });
