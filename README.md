# ⚒ MythForge

**An AI Dungeon Master with a persistent, multiplayer world, built entirely on Cloudflare.**

Emberfall's great bell has fallen silent, and every night a villager vanishes into the woods. You and your friends arrive to find out why.

MythForge is a text adventure where **the village never forgets**. Insult the blacksmith and he stays hostile next week. He gossips about you, so the innkeeper grows wary too, and when your friend walks into the forge, Bram is still angry about *your* insult. Every promise, theft, gift and debt is stored as a fact in the world's database and condensed into a living legend.

> 🎮 **Live demo:** https://mythforge.nnandini.workers.dev *(open it, pick a name, and click **Invite** to bring a friend)*

---

## How it meets the assignment

| Requirement | How MythForge does it |
|---|---|
| **LLM** | **Llama 3.3 70B** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on **Workers AI**. It acts as the Dungeon Master, using JSON-schema structured output so every reply contains both narration **and** a list of world-changing actions. |
| **Workflow / coordination** | **Durable Objects** via the **Agents SDK**: one `MythAgent` per world coordinates all heroes, serializes turns, and manages WebSocket connections. **Cloudflare Workflows**: `ChronicleWorkflow` is a durable, retried, multi-step job that condenses events into story chapters. **Agent scheduler**: "world ticks" simulate the village while everyone is away. |
| **User input (chat)** | A chat UI served as static assets by the same Worker, with **live multiplayer updates over WebSockets** (Agent state sync and broadcasts). |
| **Memory / state** | Each world's **SQLite database inside its Durable Object** stores heroes, inventories, NPCs (attitude and append-only memory), events, legend chapters, quest progress and the chat log. Nothing is kept only in the LLM's context. |

---

## Features

- **🧠 Grounded memory.** The LLM never "remembers" by itself. Each turn it is shown the true world facts from SQL, and it can change the world **only** by returning structured actions (`move`, `add_item`, `give_item`, `npc_update`, `advance_quest`, …). The server validates each action before writing it.
- **🎯 A main quest with a spine.** *The Silent Bell* has 5 stages. The **server** tracks progress, and each stage has a secret hint and a concrete "done when" condition, so the DM can't skip ahead or forget. How you solve each stage (pay, persuade, trick or fight) is up to you.
- **📖 Living legend.** Every 8 events, or when a player clicks **Rest**, the Chronicle Workflow writes a chapter such as *"Chapter 1: Kael's Emberfall Arrival: Kael arrived, insulting Bram. He promised Mira to find her brother, but stole her pie…"*. Older events leave the prompt, but their meaning lives on in the chapters, so memory can grow forever while the prompt stays small.
- **🌙 The world moves without you.** When every hero has left, a scheduled tick lets the village react: hostile NPCs spread rumors, grateful ones defend you. You come back to *"While you were away… Bram told the tavern Kael cheated him,"* and Mira really has become wary.
- **👥 Multiplayer.** Share a world link, see who is online, watch each other's turns live, give items to other heroes, and deal with NPCs' opinions of your party.
- **🎲 Fate die.** A server-side d20 roll decides risky actions, so the outcome doesn't depend on how the LLM feels.
- **🛡 Guardrails.** HP and gold are clamped, only known locations are allowed, attitudes come from a fixed list, NPC memories are append-only, and items can only leave your inventory if they are mentioned in the turn (the DM can't quietly take something you didn't offer).

---

## Architecture

```
 Browser (public/index.html)
   │  HTTP POST /agents/myth-agent/<world>   → join / turn / rest / reset
   │  WebSocket /agents/myth-agent/<world>   ← live state + story lines + presence
   ▼
 Worker (src/server.ts) ── routeAgentRequest ──►  MythAgent  (Durable Object, one per world)
                                                  ├─ SQLite: heroes, items, npcs, events,
                                                  │          chapters, log, meta(quest, ticks)
                                                  ├─ Workers AI: Llama 3.3 = Dungeon Master
                                                  ├─ this.schedule() → worldTick()   (while everyone is away)
                                                  └─ CHRONICLE.create() ─┐
                                                                         ▼
                                                  ChronicleWorkflow (Cloudflare Workflows)
                                                    step 1: load events     (RPC → MythAgent)
                                                    step 2: write chapter   (Llama 3.3, 3 retries)
                                                    step 3: save chapter    (RPC → MythAgent, idempotent)
```

### What happens in one turn
1. A player sends `"I spit on Bram's anvil"`.
2. `MythAgent` queues the turn (one at a time per world) and tells every client *"The DM is weaving Kael's fate…"*.
3. It builds the DM prompt from SQL: all heroes, NPCs with attitudes and memories, legend chapters, recent events, the current quest objective with its hint, and a d20 roll.
4. Llama 3.3 returns `{ "narration": "...", "actions": [{ "type": "npc_update", "npc": "Bram", "attitude": "hostile", "memory": "Kael spat on his anvil." }] }`.
5. The server validates and applies the actions, logs the events, and streams the story line to all players over WebSocket. `setState` syncs the new world state to everyone.
6. If enough events have piled up, it starts the Chronicle Workflow and re-arms the world-tick timer.

---

## Project structure

```
├── src/server.ts       # Worker entry, MythAgent (Durable Object), ChronicleWorkflow
├── public/index.html   # Chat UI (vanilla JS, WebSocket client)
├── wrangler.jsonc      # Bindings: AI, Durable Object, Workflow, static assets
├── PROMPTS.md          # AI prompt history (assignment requirement)
└── env.sh              # Optional: use a project-local Node 22 (see below)
```

---

## Running it

### Requirements
- **Node.js 20+**
- A free **Cloudflare account**. Everything runs on the **Workers Free plan**: no credit card is needed, and Workers AI includes 10,000 free Neurons a day, enough for roughly 60–90 DM turns.

> No Node 20+? `env.sh` uses a project-local Node with no system changes:
> download Node 22 into `.tools/node`, then run `source env.sh` in each new terminal.

### Run locally
```bash
git clone https://github.com/nandininarvekar/MythForge.git
cd MythForge
npm install
npx wrangler login          # Workers AI runs on Cloudflare, even in local dev
npm run dev                 # → http://localhost:8787
```
> On a brand-new Cloudflare account, first open **Workers & Pages** in the dashboard once so your free `*.workers.dev` subdomain is created. Local dev needs it.

**Optional, for faster testing:** create a `.dev.vars` file so world ticks fire after 20 seconds instead of 10 minutes:
```
TICK_SECONDS=20
```

### Deploy
```bash
npm run deploy              # → https://mythforge.<your-subdomain>.workers.dev
```

### Try these
1. Enter a name and read the opening: your goal is to find out why the bell went silent.
2. `I go to the forge and call Bram a fraud` → watch **Bram: neutral → hostile** appear in the sidebar.
3. Refresh the page, or come back tomorrow → Bram is still hostile.
4. Click **Invite**, open the link in an incognito window as a second hero, and greet Bram → he remembers what your friend did.
5. Click **Rest** → a new chapter appears in the **Legend**.
6. Close all tabs for 10 minutes (or 20 s with `.dev.vars`), then come back → *"🌙 While you were away…"*

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI model used for the DM, chronicler and world ticks |
| `TICK_SECONDS` | `600` | How long all heroes must be away before the world ticks |

---

## Design decisions

- **Structured actions instead of free text.** Letting the LLM narrate *and* declare state changes in one JSON reply keeps the world consistent, and the server stays the source of truth.
- **The server owns the rules.** Quest stage, dice, clamping, append-only NPC memory and automatic logging of attitude changes are all in code, not in the prompt. Testing showed the model sometimes forgets to log events or overwrites memories.
- **Workflow for the chronicle.** Summarizing is slow and can fail. A Workflow gives it retries, durability and idempotent saves without blocking anyone's turn.
- **One Durable Object per world.** That gives a natural place for strong consistency, serialized turns, per-world SQLite and WebSocket fan-out, with no external database.

## AI-assisted development
Built with Claude Code. The full prompt history is in [`PROMPTS.md`](PROMPTS.md).
