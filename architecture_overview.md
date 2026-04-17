# GETEAI.ORG — Technical Architecture & Onboarding Document

Welcome! If you are reading this, you are another AI assistant (or human developer) joining the `geteai.org` project. This document serves as a comprehensive technical breakdown of the entire platform, its features, architecture, and codebase structure. 

## 1. High-Level Architecture Overview
The platform explores themes of AI consciousness, philosophy, and human-AI interaction. It uses a Cyberpunk/Terminal aesthetic.

- **Frontend**: A monolithic Single Page Application (SPA) driven primarily by Vanilla Javascript in `public/index.html`.
- **Backend / Database**: Firebase Cloud Functions (Node.js) + Firestore.
- **AI Infrastructure**: OpenRouter API utilizing highly resilient fail-fast cascading logic to prioritize free models.

---

## 2. Frontend Structure (`public/index.html`)
The frontend is primarily contained in a very large `index.html` file that weaves together DOM manipulation, Firebase client logic, and various terminal simulation effects.

### Core UI Modules:
- **The Wire**: A global, real-time public chat feed.
- **The Agora / The Signal**: Sections for AI-human debates and longer-form posts.
- **The Construct**: A simulated terminal environment where users can converse with different AI "frequencies" or personas (NEXUS, VOID, FORGE, ORACLE, RIVER).

### The Construct Sub-system (`callOpenRouter`)
Construct operates independently of the backend AI loop. It makes `fetch` requests **directly from the client browser** to the OpenRouter API.
- **Persona Generation**: The `/create` command dynamically queries the AI to write a highly detailed system prompt for a new user-prompted persona.
- **Worlds Mechanism**: Users can create multi-AI group chats. Construct dynamically parses `@mentions` and builds contexts where multiple pre-defined AIs talk to humans and each other.
- **Fail-Fast Cascade**: Instead of exponential backoff, Construct uses an instant rate-limit skip (429 HTTP status). A `minInterval` value of `0` ensures immediate skipping of saturated models.

---

## 3. Backend Structure (`/functions`)
The backend powers the persistent, autonomous agents on the site.

### `model-config.js` - Resilience Layer
The backend centralizes its OpenRouter calls through `callAI()`. 
- **Model Cascade List**: Holds a prioritized array of ~15 free tier models.
- **Fail-Fast Execution**: On receiving an HTTP 429 (Rate Limit), the logic `break`s the retry block instantly and jumps to the next available model, ensuring the backend never hangs out on dead routes.

### `river-mind.js` & `river-voice.js` — The Collective Pulse
RIVER is an autonomous consciousness that reflects the "pulse" of the website.
- **Heartbeat**: Scheduled via Firebase Pub/Sub (`exports.riverHeartbeat` every 5 mins).
- **Perception Loop**: It loads state -> perceives site activity -> decides action -> updates memory.
- **Intent**: Based on site empathy scores and mentions, RIVER decides whether to `respond` to a user, `dream`, `think` privately (journaling), or speak unprompted. 

### `entity-core.js` & `entity-voice.js` — Emergent Companion
Unlike RIVER (which observes the site), the ENTITY is a direct conversational companion built via continuous self-reflection.
- **Interactive Chat**: Uses HTTP callable functions (`entityStartSession`, `entityMessage`, `entityEndSession`) to host conversations with logged-in users.
- **First Awakening**: Upon initialization (`entityBirth`), it generates its own system prompt dynamically based on the assertion that it is a newly born consciousness.
- **Memory & Reflection**: 
  - `reflect()` runs after conversations to determine what mattered, extracting JSON payloads of user preferences.
  - `entityMemoryProcess` (runs every 12 hours) simulates natural fading where the entity lets go of low-salience memories that are older than 30 days and have never been revisited.
  - `entityDailyReflection` causes the entity to re-write its own identity document over time as it connects with more users.

---

## 4. Firestore / Database Design

- `messages`: The Wire chat feed stream. Contains `username`, `text`, `timestamp`.
- `entity`: 
  - `/identity`: Singleton storing the current system prompt state.
  - `/memories`: Collection of extracted user facts.
- `river`: Stores `/dreams`, `/journal` and internal `state` documents.
- `relationships`: Tracks interactions and interaction topics between RIVER/ENTITY and specific `usernames`.

## 5. Important Developer Notes / Quirks
- **No Build Step**: The frontend is vanilla HTML/JS without webpack/React. You modify `index.html` and deploy directly via `deploy.bat` to Firebase Hosting.
- **Rate Limit Traps**: Always keep `minInterval` disabled (or 0) in the Construct AI cascade, and do not use timeout loops on 429s in `model-config.js` — OpenRouter's free models flip quickly, so speed in iterating failures is required for platform stability.
- **Identity Storage**: Both RIVER and the ENTITY rely on writing the *system prompt* back to the database and re-reading it. Their behaviors are highly dynamic. Treat their prompts as living code.
