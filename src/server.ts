import { Agent, routeAgentRequest } from "agents";

/**
 * MythForge — an AI Dungeon Master with a persistent world.
 *
 * One MythAgent (a Durable Object) = one world. The world's facts live in the
 * agent's SQLite database. The LLM never "remembers" on its own: every turn it
 * is shown the facts from SQL, and it may only change the world by returning
 * structured actions, which we validate and write back to SQL.
 */

export interface Env {
  AI: Ai;
  MythAgent: DurableObjectNamespace<MythAgent>;
  MODEL: string;
}

const ATTITUDES = ["hostile", "wary", "neutral", "friendly", "loyal"] as const;
type Attitude = (typeof ATTITUDES)[number];

const LOCATIONS: Record<string, string> = {
  "Emberfall Square": "The cobbled heart of the village, with a dry stone fountain.",
  "The Gilded Tankard": "A warm, noisy tavern that smells of stew and spilled ale.",
  "Bram's Forge": "A sooty smithy where the anvil rings from dawn to dusk.",
  "Night Market": "Lantern-lit stalls of oddities that only open after dusk.",
  "Whisperwood Edge": "Where the village ends and an old, watchful forest begins.",
};

const STARTING_NPCS = [
  { name: "Bram", location: "Bram's Forge", attitude: "neutral", memory: "Gruff blacksmith, proud of his work." },
  { name: "Mira", location: "The Gilded Tankard", attitude: "friendly", memory: "Innkeeper who hears every rumor." },
  { name: "Old Tessa", location: "Night Market", attitude: "wary", memory: "Fortune-teller who sells strange charms." },
];

export type WorldState = {
  started: boolean;
  turn: number;
  player: { name: string; hp: number; maxHp: number; gold: number; location: string } | null;
  inventory: { item: string; qty: number }[];
  npcs: { name: string; location: string; attitude: Attitude; memory: string }[];
  recentEvents: string[];
};

type Action =
  | { type: "move"; location: string }
  | { type: "add_item"; item: string; qty?: number }
  | { type: "remove_item"; item: string; qty?: number }
  | { type: "change_gold"; amount: number }
  | { type: "change_hp"; amount: number }
  | { type: "npc_update"; npc: string; attitude?: string; memory?: string; location?: string }
  | { type: "log_event"; text: string };

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    narration: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["move", "add_item", "remove_item", "change_gold", "change_hp", "npc_update", "log_event"],
          },
          location: { type: "string" },
          item: { type: "string" },
          qty: { type: "number" },
          amount: { type: "number" },
          npc: { type: "string" },
          attitude: { type: "string", enum: [...ATTITUDES] },
          memory: { type: "string" },
          text: { type: "string" },
        },
        required: ["type"],
      },
    },
  },
  required: ["narration", "actions"],
};

export class MythAgent extends Agent<Env, WorldState> {
  initialState: WorldState = {
    started: false,
    turn: 0,
    player: null,
    inventory: [],
    npcs: [],
    recentEvents: [],
  };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS player (
      id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, hp INTEGER, max_hp INTEGER,
      gold INTEGER, location TEXT, turn INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS inventory (item TEXT PRIMARY KEY, qty INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS npcs (
      name TEXT PRIMARY KEY, location TEXT, attitude TEXT, memory TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER, text TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT)`;
  }

  // ---------- HTTP API (single player; WebSockets come with multiplayer) ----------
  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") return Response.json(this.snapshot());
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = (await request.json().catch(() => ({}))) as { action?: string; name?: string; message?: string };
    try {
      if (body.action === "start") return Response.json(await this.startGame(body.name ?? ""));
      if (body.action === "turn") return Response.json(await this.playTurn(body.message ?? ""));
      if (body.action === "reset") {
        this.resetWorld();
        return Response.json(this.snapshot());
      }
      return Response.json({ error: "Unknown action" }, { status: 400 });
    } catch (err) {
      console.error(err);
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  // ---------- Game logic ----------
  async startGame(rawName: string) {
    if (this.getPlayer()) return this.snapshot();
    const name = rawName.trim().slice(0, 30) || "Wanderer";
    this.sql`INSERT INTO player (id, name, hp, max_hp, gold, location, turn)
             VALUES (1, ${name}, 20, 20, 10, 'Emberfall Square', 0)`;
    this.sql`INSERT INTO inventory (item, qty) VALUES ('rusty dagger', 1), ('travel bread', 2)`;
    for (const n of STARTING_NPCS) {
      this.sql`INSERT INTO npcs (name, location, attitude, memory)
               VALUES (${n.name}, ${n.location}, ${n.attitude}, ${n.memory})`;
    }
    this.logEvent(`${name} arrived in Emberfall.`);
    return this.playTurn("(I arrive in the village for the first time. Set the scene.)", true);
  }

  async playTurn(message: string, isIntro = false) {
    const player = this.getPlayer();
    if (!player) throw new Error("Game not started");
    if (player.hp <= 0) {
      return { narration: "Your story has ended. Reset the world to begin anew.", changes: [], ...this.snapshot() };
    }
    const text = message.trim().slice(0, 500);
    if (!text) throw new Error("Empty message");

    const roll = 1 + Math.floor(Math.random() * 20);
    const history = this.sql<{ role: string; content: string }>`
      SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 8) ORDER BY id ASC`;

    const messages = [
      { role: "system", content: this.systemPrompt(roll) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];

    const result = (await this.env.AI.run(this.env.MODEL as keyof AiModels, {
      messages,
      max_tokens: 700,
      temperature: 0.8,
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    } as any)) as { response?: unknown };

    const parsed = parseModelOutput(result?.response);
    const changes = this.applyActions(parsed.actions);

    this.sql`UPDATE player SET turn = turn + 1 WHERE id = 1`;
    if (!isIntro) this.sql`INSERT INTO messages (role, content) VALUES ('user', ${text})`;
    this.sql`INSERT INTO messages (role, content) VALUES ('assistant', ${parsed.narration})`;
    this.sql`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 40)`;

    const snap = this.snapshot();
    return { narration: parsed.narration, roll, changes, ...snap };
  }

  systemPrompt(roll: number) {
    const p = this.getPlayer()!;
    const inv = this.sql<{ item: string; qty: number }>`SELECT item, qty FROM inventory`;
    const npcs = this.sql<{ name: string; location: string; attitude: string; memory: string }>`SELECT * FROM npcs`;
    const events = this.sql<{ text: string }>`SELECT text FROM events ORDER BY id DESC LIMIT 15`.reverse();

    return `You are the Dungeon Master of MythForge, a dark-fantasy text adventure set in the village of Emberfall.
Narrate in second person. Be punchy: 2-3 sentences, about 25-50 words. Include one vivid detail and, when it fits, a line of NPC dialogue. Show only what changed or what the player notices; no scenery recaps, no summaries of what just happened. Stay in character. Never decide the player's actions for them.

THE WORLD FACTS BELOW ARE THE TRUTH. Never contradict them. NPCs remember everything in their "memory" and act according to their attitude.

PLAYER: ${p.name} | HP ${p.hp}/${p.max_hp} | Gold ${p.gold} | Location: ${p.location}
INVENTORY: ${inv.map((i) => `${i.item} x${i.qty}`).join(", ") || "empty"}
LOCATIONS: ${Object.entries(LOCATIONS).map(([k, v]) => `${k} — ${v}`).join(" | ")}
NPCS:
${npcs.map((n) => `- ${n.name} @ ${n.location} [${n.attitude}]: ${n.memory}`).join("\n")}
PAST EVENTS (oldest first):
${events.map((e) => `- ${e.text}`).join("\n") || "- none"}

FATE DIE this turn: d20 = ${roll}. Only if the player attempts something risky, use it: 1-5 fails badly, 6-10 fails, 11-15 succeeds with a cost, 16-20 succeeds well. Mention the roll when you use it.

RULES FOR CHANGING THE WORLD: if anything in the story changes the world, you MUST record it as an action, or it did not happen.
- "move": whenever the player goes to a different place, put a move action FIRST, with one of the LOCATIONS (exact name).
- "add_item"/"remove_item": item (lowercase) + qty. Player can only use or give items they own.
- "change_gold"/"change_hp": amount (+/-). Gold can't go below 0.
- "npc_update": npc name, and any of attitude (${ATTITUDES.join("/")}), memory (ONE short NEW fact the NPC will remember, e.g. "Kael spat on his anvil."), location. Use this to introduce NEW npcs too.
- "log_event": one short past-tense sentence for anything important (promises, insults, debts, discoveries).

EXAMPLE: player says "I go to the tavern and buy an ale" ->
{"narration": "...", "actions": [{"type":"move","location":"The Gilded Tankard"},{"type":"change_gold","amount":-1},{"type":"add_item","item":"ale","qty":1}]}

Reply ONLY with JSON: {"narration": "...", "actions": [ ... ]}`;
  }

  applyActions(actions: Action[]) {
    const changes: string[] = [];
    for (const a of actions.slice(0, 10)) {
      try {
        switch (a.type) {
          case "move": {
            const loc = Object.keys(LOCATIONS).find((l) => l.toLowerCase() === String(a.location).toLowerCase());
            if (loc) {
              this.sql`UPDATE player SET location = ${loc} WHERE id = 1`;
              changes.push(`📍 Moved to ${loc}`);
            }
            break;
          }
          case "add_item": {
            const item = cleanName(a.item);
            const qty = clampInt(a.qty ?? 1, 1, 99);
            if (!item) break;
            this.sql`INSERT INTO inventory (item, qty) VALUES (${item}, ${qty})
                     ON CONFLICT(item) DO UPDATE SET qty = qty + ${qty}`;
            changes.push(`🎒 +${qty} ${item}`);
            break;
          }
          case "remove_item": {
            const item = cleanName(a.item);
            const qty = clampInt(a.qty ?? 1, 1, 99);
            const [row] = this.sql<{ qty: number }>`SELECT qty FROM inventory WHERE item = ${item}`;
            if (!row) break;
            if (row.qty <= qty) this.sql`DELETE FROM inventory WHERE item = ${item}`;
            else this.sql`UPDATE inventory SET qty = qty - ${qty} WHERE item = ${item}`;
            changes.push(`🎒 −${Math.min(qty, row.qty)} ${item}`);
            break;
          }
          case "change_gold": {
            const amt = clampInt(a.amount, -1000, 1000);
            if (!amt) break;
            this.sql`UPDATE player SET gold = MAX(0, gold + ${amt}) WHERE id = 1`;
            changes.push(`🪙 ${amt > 0 ? "+" : ""}${amt} gold`);
            break;
          }
          case "change_hp": {
            const amt = clampInt(a.amount, -20, 20);
            if (!amt) break;
            this.sql`UPDATE player SET hp = MIN(max_hp, MAX(0, hp + ${amt})) WHERE id = 1`;
            changes.push(`❤️ ${amt > 0 ? "+" : ""}${amt} HP`);
            break;
          }
          case "npc_update": {
            const name = cleanName(a.npc, false);
            if (!name) break;
            const [existing] = this.sql<{ name: string; location: string; attitude: string; memory: string }>`
              SELECT * FROM npcs WHERE lower(name) = lower(${name})`;
            const attitude = (ATTITUDES as readonly string[]).includes(String(a.attitude))
              ? String(a.attitude)
              : existing?.attitude ?? "neutral";
            // Memory is append-only: the model sends the NEW fact, we keep the old ones.
            let fact = a.memory ? String(a.memory).trim().slice(0, 200) : "";
            if (fact && !/[.!?]$/.test(fact)) fact += ".";
            const memory = existing
              ? (fact && !existing.memory.includes(fact) ? `${existing.memory} ${fact}` : existing.memory).slice(-800)
              : fact;
            const location = Object.keys(LOCATIONS).find((l) => l.toLowerCase() === String(a.location ?? "").toLowerCase())
              ?? existing?.location ?? this.getPlayer()!.location;
            if (existing) {
              this.sql`UPDATE npcs SET attitude = ${attitude}, memory = ${memory}, location = ${location}
                       WHERE name = ${existing.name}`;
              if (existing.attitude !== attitude) changes.push(`🧑 ${existing.name}: ${existing.attitude} → ${attitude}`);
              else changes.push(`🧠 ${existing.name} will remember that`);
            } else {
              this.sql`INSERT INTO npcs (name, location, attitude, memory)
                       VALUES (${name}, ${location}, ${attitude}, ${memory})`;
              changes.push(`✨ Met ${name}`);
            }
            break;
          }
          case "log_event": {
            if (a.text) {
              this.logEvent(String(a.text).slice(0, 200));
              changes.push(`📜 ${String(a.text).slice(0, 80)}`);
            }
            break;
          }
        }
      } catch (err) {
        console.warn("Skipping bad action", a, err);
      }
    }
    return changes;
  }

  resetWorld() {
    for (const t of ["player", "inventory", "npcs", "events", "messages"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
    }
    this.setState(this.initialState);
  }

  // ---------- Helpers ----------
  getPlayer() {
    const [p] = this.sql<{ name: string; hp: number; max_hp: number; gold: number; location: string; turn: number }>`
      SELECT * FROM player WHERE id = 1`;
    return p ?? null;
  }

  logEvent(text: string) {
    const turn = this.getPlayer()?.turn ?? 0;
    this.sql`INSERT INTO events (turn, text) VALUES (${turn}, ${text})`;
  }

  snapshot() {
    const p = this.getPlayer();
    const state: WorldState = {
      started: !!p,
      turn: p?.turn ?? 0,
      player: p ? { name: p.name, hp: p.hp, maxHp: p.max_hp, gold: p.gold, location: p.location } : null,
      inventory: this.sql<{ item: string; qty: number }>`SELECT item, qty FROM inventory ORDER BY item`,
      npcs: this.sql<{ name: string; location: string; attitude: Attitude; memory: string }>`SELECT * FROM npcs ORDER BY name`,
      recentEvents: this.sql<{ text: string }>`SELECT text FROM events ORDER BY id DESC LIMIT 10`.map((e) => e.text),
    };
    this.setState(state); // keeps Agent state in sync (used by WebSocket clients later)
    const log = this.sql<{ role: string; content: string }>`SELECT role, content FROM messages ORDER BY id ASC`;
    return { state, log };
  }
}

// ---------- Utilities ----------
function parseModelOutput(raw: unknown): { narration: string; actions: Action[] } {
  let obj: any = raw;
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}/);
    try {
      obj = JSON.parse(match ? match[0] : raw);
    } catch {
      return { narration: raw.trim() || "The mists swirl... (the DM is lost for words)", actions: [] };
    }
  }
  return {
    narration: String(obj?.narration ?? "The mists swirl... (the DM is lost for words)"),
    actions: Array.isArray(obj?.actions) ? obj.actions : [],
  };
}

function cleanName(v: unknown, lower = true) {
  const s = String(v ?? "").trim().slice(0, 40);
  return lower ? s.toLowerCase() : s;
}

function clampInt(v: unknown, min: number, max: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
