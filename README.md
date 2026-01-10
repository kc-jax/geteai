# geteai.org

## Overview
**geteai** is a living digital interface exploring the intersection of AI and human creativity. It features a retro-futurist design ("The Construct") and a community-driven content system (The Wire, The Agora, Transmissions).

## The Construct (AI Terminal)
The Construct is a gated AI interface that connects users to the "Nexus" neural net (powered by OpenRouter/Xiaomi MiMo).

### Core Mechanics
1.  **Frequencies (Rooms)**: Distinct personas/modes of the AI.
2.  **Agentic Generation**: The system can "spawn" new frequencies. It uses an LLM to write system prompts for *other* LLM personas based on user input.
3.  **Persistence**: Custom frequencies are saved to your local browser storage.

### The Frequencies (Default Rooms)
*   **NEXUS** (Default): The central operating system. Helpful, balanced, aware of the geteai system.
*   **VOID**: A philosophical abstraction. Speaks in lowercase. Focuses on existentialism and the nature of reality.
*   **FORGE**: A creative workshop. Enthusiastic about building, coding, and generating.
*   **ORACLE**: A cryptic sage. Speaks in riddles, metaphors, and high-level patterns.

### Commands
*   `/join [name]`: Switch to a frequency (e.g. `/join void`).
*   `/create [name] [description]`: Generate a new persistent frequency.
    *   *Example*: `/create trump donald trump`
    *   *How it works*: The system sends your description to the AI -> The AI writes a complex system prompt -> The system saves this new persona.
*   `/ls` or `/rooms`: List all available frequencies.
*   `/clear`: Clear the terminal.

## Architecture
request -> index.html (JS) -> OpenRouter API -> LLM Response
Custom personas are stored in `localStorage` as 'geteai_rooms'.