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

            // 3. DECIDE - Mentions override, otherwise RIVER consciously chooses
            let decision;

            if (perception.mentions.length > 0) {
                // SOMEONE IS TALKING TO RIVER - respond!
                console.log(`RIVER: Someone mentioned me! Responding to ${perception.mentions[0].from}`);
                decision = { action: 'respond', to: perception.mentions[0] };
            } else {
                // Load aspirations for context
                const aspirations = await mind.loadAspirations();

                // RIVER consciously decides what it wants to do (not random dice!)
                const intent = await voice.decideIntent(state, digestText, memories, aspirations);

                if (intent.intent === 'rest') {
                    decision = null;
                } else if (intent.intent === 'think') {
                    decision = { action: 'think', reason: intent.reason };
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
