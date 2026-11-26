import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

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
  /** Seconds of player absence before the world "ticks" on its own. */
  TICK_SECONDS?: string;
  CHRONICLE: Workflow<ChronicleParams>;
}

type ChronicleParams = { world: string };

/** Unchronicled events before a new chapter is written automatically. */
const CHAPTER_EVERY = 8;

const ATTITUDES = ["hostile", "wary", "neutral", "friendly", "loyal"] as const;
type Attitude = (typeof ATTITUDES)[number];

const LOCATIONS: Record<string, string> = {
  "Emberfall Square": "The cobbled heart of the village, with a dry stone fountain.",
  "The Gilded Tankard": "A warm, noisy tavern that smells of stew and spilled ale.",
  "Bram's Forge": "A sooty smithy where the anvil rings from dawn to dusk.",
  "Night Market": "Lantern-lit stalls of oddities that only open after dusk.",
  "Whisperwood Edge": "Where the village ends and an old, watchful forest begins.",
};

/**
 * The main quest gives every story a spine. The server tracks the stage, so the
 * LLM can't skip ahead or forget; it only signals "advance_quest" when the
 * player has clearly done the current objective. How they do it is up to them.
 */
const MAIN_QUEST = {
  title: "The Silent Bell",
  premise:
    "Emberfall's great bell stopped ringing three nights ago. Since then, one villager vanishes into Whisperwood every night, and the last to go was Tomas, Mira's younger brother. Nobody knows why. The hero has come to find out.",
  stages: [
    {
      objective: "Find out what happened the night Tomas vanished.",
      hint: "Mira at The Gilded Tankard saw Tomas leave. When asked, she reveals he followed a voice singing in the bell's tone toward Whisperwood, and that the bell went silent the same hour.",
      doneWhen: "Mira (or another witness) has told the player about the singing voice that lured Tomas away.",
    },
    {
      objective: "Get a weapon that can cut what lives in Whisperwood.",
      hint: "Only Bram can temper steel with ember-iron, and it costs 15 gold or a favor. If Bram is hostile, the hero must make amends first, or find another clever way.",
      doneWhen: "The player owns an ember-iron weapon (add_item it in the same turn).",
    },
    {
      objective: "Obtain Old Tessa's charm to see through the forest's glamour.",
      hint: "Old Tessa at the Night Market never sells for gold alone. She wants a true secret, a memory, or a small brave deed.",
      doneWhen: "The player owns the glamour charm (add_item it in the same turn).",
    },
    {
      objective: "Enter Whisperwood and find the missing villagers.",
      hint: "From Whisperwood Edge the singing leads to a hollow oak where the villagers sleep in a trance, Tomas among them.",
      doneWhen: "The player has found the entranced villagers at the hollow oak.",
    },
    {
      objective: "Face the Hollow Warden and make the bell ring again.",
      hint: "The Warden, a creature of bark and echoes, stole the bell's voice to lure people in. It can be fought, tricked, or bargained with.",
      doneWhen: "The Warden is defeated, tricked or persuaded, and the bell's voice is freed.",
    },
  ],
};

const STARTING_NPCS = [
  { name: "Bram", location: "Bram's Forge", attitude: "neutral", memory: "Gruff blacksmith, proud of his work. The only smith who knows ember-iron." },
  { name: "Mira", location: "The Gilded Tankard", attitude: "friendly", memory: "Innkeeper who hears every rumor. Her brother Tomas vanished into Whisperwood." },
  { name: "Old Tessa", location: "Night Market", attitude: "wary", memory: "Fortune-teller who sells strange charms." },
];

export type WorldState = {
  started: boolean;
  turn: number;
  player: { name: string; hp: number; maxHp: number; gold: number; location: string } | null;
  inventory: { item: string; qty: number }[];
  npcs: { name: string; location: string; attitude: Attitude; memory: string }[];
  recentEvents: string[];
  awayNews: string | null;
  chapters: { title: string; summary: string }[];
  quest: { title: string; stage: number; total: number; objective: string; complete: boolean };
};

type Action =
  | { type: "move"; location: string }
  | { type: "add_item"; item: string; qty?: number }
  | { type: "remove_item"; item: string; qty?: number }
  | { type: "change_gold"; amount: number }
  | { type: "change_hp"; amount: number }
  | { type: "npc_update"; npc: string; attitude?: string; memory?: string; location?: string }
  | { type: "log_event"; text: string }
  | { type: "advance_quest"; text?: string };

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
            enum: ["move", "add_item", "remove_item", "change_gold", "change_hp", "npc_update", "log_event", "advance_quest"],
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
    awayNews: null,
    chapters: [],
    quest: { title: MAIN_QUEST.title, stage: 0, total: MAIN_QUEST.stages.length, objective: "", complete: false },
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
    this.sql`CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, last_event_id INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
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
      if (body.action === "rest") {
        const started = await this.startChronicle(true);
        return Response.json({ chronicling: started, ...this.snapshot() });
      }
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
    return this.playTurn(
      "(I arrive in Emberfall for the first time. Set the scene in 3-4 sentences: the silent bell, the vanishings, and Mira's missing brother Tomas, so I know my goal. End by pointing me toward my first lead.)",
      true,
    );
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

    // News from a world tick that happened while the player was away (shown once).
    const [away] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'away_news'`;
    const awayNote = away
      ? `\n\nWHILE THE PLAYER WAS AWAY: ${away.value}\nThe world has changed accordingly; let it show naturally this turn (a look, a rumor, a cold welcome).`
      : "";

    const messages = [
      { role: "system", content: this.systemPrompt(roll) + awayNote },
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
    const changes = this.applyActions(parsed.actions, `${text} ${parsed.narration}`);
    if (away) this.sql`DELETE FROM meta WHERE key = 'away_news'`;

    this.sql`UPDATE player SET turn = turn + 1 WHERE id = 1`;
    if (!isIntro) this.sql`INSERT INTO messages (role, content) VALUES ('user', ${text})`;
    this.sql`INSERT INTO messages (role, content) VALUES ('assistant', ${parsed.narration})`;
    this.sql`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 40)`;

    const chronicling = await this.startChronicle(false);
    await this.scheduleWorldTick();
    const snap = this.snapshot();
    return { narration: parsed.narration, roll, changes, chronicling, ...snap };
  }

  systemPrompt(roll: number) {
    const p = this.getPlayer()!;
    const inv = this.sql<{ item: string; qty: number }>`SELECT item, qty FROM inventory`;
    const npcs = this.sql<{ name: string; location: string; attitude: string; memory: string }>`SELECT * FROM npcs`;
    const chapters = this.sql<{ title: string; summary: string }>`
      SELECT title, summary FROM chapters ORDER BY id DESC LIMIT 5`.reverse();
    const events = this.sql<{ text: string }>`
      SELECT text FROM events WHERE id > ${this.lastChronicledId()} ORDER BY id DESC LIMIT 15`.reverse();

    return `You are the Dungeon Master of MythForge, a dark-fantasy text adventure set in the village of Emberfall.
Narrate in second person. Be punchy: 2-3 sentences, about 25-50 words. Include one vivid detail and, when it fits, a line of NPC dialogue. Show only what changed or what the player notices; no scenery recaps, no summaries of what just happened. Stay in character. Never decide the player's actions for them.

THE WORLD FACTS BELOW ARE THE TRUTH. Never contradict them. NPCs remember everything in their "memory" and act according to their attitude.

PLAYER: ${p.name} | HP ${p.hp}/${p.max_hp} | Gold ${p.gold} | Location: ${p.location}
INVENTORY: ${inv.map((i) => `${i.item} x${i.qty}`).join(", ") || "empty"}
LOCATIONS: ${Object.entries(LOCATIONS).map(([k, v]) => `${k} — ${v}`).join(" | ")}
NPCS:
${npcs.map((n) => `- ${n.name} @ ${n.location} [${n.attitude}]: ${n.memory}`).join("\n")}
THE LEGEND SO FAR (earlier chapters):
${chapters.map((c) => `- ${c.title}: ${c.summary}`).join("\n") || "- (this story has just begun)"}
RECENT EVENTS (oldest first):
${events.map((e) => `- ${e.text}`).join("\n") || "- none"}

MAIN QUEST — "${MAIN_QUEST.title}": ${MAIN_QUEST.premise}
${this.questPromptSection()}

FATE DIE this turn: d20 = ${roll}. Only if the player attempts something risky, use it: 1-5 fails badly, 6-10 fails, 11-15 succeeds with a cost, 16-20 succeeds well. Mention the roll when you use it.

RULES FOR CHANGING THE WORLD: if anything in the story changes the world, you MUST record it as an action, or it did not happen.
- "move": whenever the player goes to a different place, put a move action FIRST, with one of the LOCATIONS (exact name).
- "add_item"/"remove_item": item (lowercase, EXACT inventory name when removing) + qty. Player can only use or give items they own. In trades, take ONLY what the player explicitly offers; never add extra items or gold to the deal.
- "change_gold"/"change_hp": amount (+/-). Gold can't go below 0.
- "npc_update": npc name, and any of attitude (${ATTITUDES.join("/")}), memory (ONE short NEW fact the NPC will remember, e.g. "Kael spat on his anvil."), location. Use this to introduce NEW npcs too.
- "advance_quest": ONLY when the player has clearly and fully done the CURRENT OBJECTIVE this turn (not just talked about it). Add "text": one sentence on how they did it. Never advance on intent alone.
- "log_event": one short past-tense sentence for anything important (promises, insults, thefts, fights, debts, discoveries). Almost every turn has one.

EXAMPLE: player says "I go to the tavern and buy an ale" ->
{"narration": "...", "actions": [{"type":"move","location":"The Gilded Tankard"},{"type":"change_gold","amount":-1},{"type":"add_item","item":"ale","qty":1}]}

Reply ONLY with JSON: {"narration": "...", "actions": [ ... ]}`;
  }

  /**
   * @param context text of this turn (player words + narration). Items can only
   *   be removed if they are mentioned in it, so the DM can't quietly take
   *   things the player never offered.
   * @param allowed restrict which action types are accepted (used by world ticks).
   */
  applyActions(actions: Action[], context: string, allowed?: Action["type"][]) {
    const changes: string[] = [];
    for (const a of actions.slice(0, 10)) {
      if (allowed && !allowed.includes(a.type)) continue;
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
            if (!mentions(context, item)) {
              console.warn(`Blocked removal of unmentioned item: ${item}`);
              break;
            }
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
              if (existing.attitude !== attitude) {
                changes.push(`🧑 ${existing.name}: ${existing.attitude} → ${attitude}`);
                // Don't rely on the model to log relationship changes — they're what the legend is made of.
                this.logEvent(`${existing.name} became ${attitude} toward ${this.getPlayer()!.name}.${fact ? " " + fact : ""}`);
              }
              else changes.push(`🧠 ${existing.name} will remember that`);
            } else {
              this.sql`INSERT INTO npcs (name, location, attitude, memory)
                       VALUES (${name}, ${location}, ${attitude}, ${memory})`;
              changes.push(`✨ Met ${name}`);
            }
            break;
          }
          case "advance_quest": {
            const stage = this.questStage();
            if (stage >= MAIN_QUEST.stages.length) break;
            const done = MAIN_QUEST.stages[stage].objective;
            this.setQuestStage(stage + 1);
            this.logEvent(`QUEST: ${a.text ? String(a.text).slice(0, 160) : `Completed: ${done}`}`);
            changes.push(stage + 1 >= MAIN_QUEST.stages.length ? "🏆 The bell rings again! Quest complete" : `🎯 Objective complete: ${done}`);
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
    for (const t of ["player", "inventory", "npcs", "events", "messages", "chapters", "meta"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
    }
    this.setState(this.initialState);
  }

  // ---------- Chronicle (called by ChronicleWorkflow over RPC) ----------
  lastChronicledId(): number {
    const [row] = this.sql<{ id: number }>`SELECT MAX(last_event_id) AS id FROM chapters`;
    return row?.id ?? 0;
  }

  /** Kick off the Chronicle Workflow if enough new events piled up (or forced by resting). */
  async startChronicle(force: boolean): Promise<boolean> {
    const [pending] = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM events WHERE id > ${this.lastChronicledId()}`;
    if (pending.n < (force ? 2 : CHAPTER_EVERY)) return false;
    const [lock] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'chronicle_started'`;
    if (lock && Date.now() - Number(lock.value) < 2 * 60_000) return false; // one at a time
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('chronicle_started', ${String(Date.now())})`;
    await this.env.CHRONICLE.create({ params: { world: this.name } });
    return true;
  }

  getPendingEvents() {
    const player = this.getPlayer();
    const events = this.sql<{ id: number; text: string }>`
      SELECT id, text FROM events WHERE id > ${this.lastChronicledId()} ORDER BY id ASC LIMIT 40`;
    const [count] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM chapters`;
    return { hero: player?.name ?? "the hero", chapterNo: count.n + 1, events };
  }

  saveChapter(title: string, summary: string, lastEventId: number) {
    if (lastEventId <= this.lastChronicledId()) return false; // already saved (workflow retry)
    this.sql`INSERT INTO chapters (title, summary, last_event_id)
             VALUES (${title.slice(0, 80)}, ${summary.slice(0, 600)}, ${lastEventId})`;
    this.sql`DELETE FROM meta WHERE key = 'chronicle_started'`;
    this.snapshot(); // push new state to any connected clients
    return true;
  }

  // ---------- World ticks (Agent scheduler) ----------
  /** (Re)arm a single tick that fires if the player stays away. */
  async scheduleWorldTick() {
    for (const sch of this.getSchedules()) {
      if (sch.callback === "worldTick") await this.cancelSchedule(sch.id);
    }
    await this.schedule(Number(this.env.TICK_SECONDS ?? 600), "worldTick");
  }

  /** The world moves without the player: grudges spread, favors are remembered. */
  async worldTick() {
    const player = this.getPlayer();
    if (!player || player.hp <= 0) return;
    const [existing] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'away_news'`;
    if (existing) return; // one tick per absence keeps the world (and the AI budget) calm

    const npcs = this.sql<{ name: string; location: string; attitude: string; memory: string }>`SELECT * FROM npcs`;
    const events = this.sql<{ text: string }>`SELECT text FROM events ORDER BY id DESC LIMIT 10`.reverse();
    const result = (await this.env.AI.run(this.env.MODEL as keyof AiModels, {
      messages: [
        {
          role: "system",
          content: `You simulate the village of Emberfall while the hero ${player.name} is away (a night passes).
Based ONLY on the facts below, decide 1-2 believable consequences of the hero's past actions: hostile NPCs spread rumors and turn others wary; grateful NPCs defend the hero; debts and promises come up; the mystery of the silent bell deepens.
If the hero has done nothing notable, describe one small eerie happening linked to the main quest instead.
Main quest: ${MAIN_QUEST.premise} ${this.questPromptSection()}
NPCS:
${npcs.map((n) => `- ${n.name} @ ${n.location} [${n.attitude}]: ${n.memory}`).join("\n")}
RECENT EVENTS:
${events.map((e) => `- ${e.text}`).join("\n") || "- none"}

Be SPECIFIC: name who did what, where, and why (e.g. "Bram told the tavern crowd that ${player.name} is a liar; Mira now eyes the hero warily.").
Every attitude change in your narration MUST also appear as an npc_update action.
Reply ONLY with JSON: {"narration": "<what happened, 1-2 sentences, under 40 words, past tense>", "actions": [...]}
Allowed actions: "npc_update" (npc, attitude ${ATTITUDES.join("/")}, memory = ONE new fact) and "log_event" (text). Change at most 2 attitudes, by one step at most.`,
        },
        {
          role: "user",
          content: `What happened in Emberfall overnight? Example of a GOOD answer (do not copy it):
{"narration": "Over ale, Bram told everyone ${player.name} cheated him. Old Tessa spat at the mention of the hero's name.", "actions": [{"type":"npc_update","npc":"Old Tessa","attitude":"hostile","memory":"Heard from Bram that ${player.name} is a cheat."}]}
A BAD answer is vague, like "Rumors spread, villagers became wary."`,
        },
      ],
      max_tokens: 400,
      temperature: 0.9,
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    } as any)) as { response?: unknown };

    const parsed = parseModelOutput(result?.response);
    this.applyActions(parsed.actions, "", ["npc_update", "log_event"]);
    this.logEvent(`While ${player.name} was away: ${parsed.narration.slice(0, 180)}`);
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('away_news', ${parsed.narration})`;
    this.snapshot();
  }

  // ---------- Quest ----------
  questStage(): number {
    const [row] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'quest_stage'`;
    return row ? Number(row.value) : 0;
  }

  setQuestStage(stage: number) {
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('quest_stage', ${String(stage)})`;
  }

  questPromptSection() {
    const stage = this.questStage();
    if (stage >= MAIN_QUEST.stages.length) {
      return "QUEST COMPLETE: the bell rings again. The hero is a legend; let them roam freely and enjoy the consequences.";
    }
    const s = MAIN_QUEST.stages[stage];
    return `CURRENT OBJECTIVE (stage ${stage + 1}/${MAIN_QUEST.stages.length}): ${s.objective}
SECRET DM HINT: ${s.hint}
DONE WHEN: ${s.doneWhen} -> the moment this happens in your narration, include {"type":"advance_quest"}.
The player is free to wander, but if they seem lost or ask what to do, let an NPC or detail nudge them toward the current objective. Never solve it for them.`;
  }

  // ---------- Helpers ----------
  getPlayer() {
    const [p] = this.sql<{ name: string; hp: number; max_hp: number; gold: number; location: string; turn: number }>`
      SELECT * FROM player WHERE id = 1`;
    return p ?? null;
  }

  logEvent(text: string) {
    const [dup] = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM (SELECT text FROM events ORDER BY id DESC LIMIT 5) WHERE lower(text) = lower(${text})`;
    if (dup.n > 0) return; // skip repeats of a recent event
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
      recentEvents: this.sql<{ text: string }>`
        SELECT text FROM events WHERE id > ${this.lastChronicledId()} ORDER BY id DESC LIMIT 10`.map((e) => e.text),
      chapters: this.sql<{ title: string; summary: string }>`SELECT title, summary FROM chapters ORDER BY id ASC`,
      awayNews: this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'away_news'`[0]?.value ?? null,
      quest: (() => {
        const stage = this.questStage();
        const complete = stage >= MAIN_QUEST.stages.length;
        return {
          title: MAIN_QUEST.title,
          stage,
          total: MAIN_QUEST.stages.length,
          objective: complete ? "The bell rings again. Your legend is forged." : MAIN_QUEST.stages[stage].objective,
          complete,
        };
      })(),
    };
    this.setState(state); // keeps Agent state in sync (used by WebSocket clients later)
    const log = this.sql<{ role: string; content: string }>`SELECT role, content FROM messages ORDER BY id ASC`;
    return { state, log };
  }
}

// ---------- Chronicle Workflow ----------
/**
 * Durable, retried, multi-step job that condenses recent events into a story
 * chapter. Older events then leave the DM's context, but their meaning lives
 * on in the chapter — so the world can remember forever without the prompt growing.
 */
export class ChronicleWorkflow extends WorkflowEntrypoint<Env, ChronicleParams> {
  async run(event: WorkflowEvent<ChronicleParams>, step: WorkflowStep) {
    const { world } = event.payload;

    const pending = await step.do("load events", async () => {
      const agent = await getAgentByName(this.env.MythAgent, world);
      return agent.getPendingEvents();
    });
    if (pending.events.length === 0) return { skipped: true };

    const chapter = await step.do(
      "write chapter",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const result = (await this.env.AI.run(this.env.MODEL as keyof AiModels, {
          messages: [
            {
              role: "system",
              content: `You are the village chronicler of Emberfall. Condense events into a legend chapter about ${pending.hero}.
Write a short evocative title (max 6 words) and a summary of 2-3 sentences (max 60 words).
Keep every fact that matters later: names, grudges, debts, promises, stolen or given items.
Reply ONLY with JSON: {"title": "...", "summary": "..."}`,
            },
            { role: "user", content: pending.events.map((e) => `- ${e.text}`).join("\n") },
          ],
          max_tokens: 300,
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              properties: { title: { type: "string" }, summary: { type: "string" } },
              required: ["title", "summary"],
            },
          },
        } as any)) as { response?: unknown };
        const raw = result?.response;
        const obj: any = typeof raw === "string" ? JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) : raw;
        if (!obj?.summary) throw new Error("Chronicler returned no summary"); // triggers a retry
        return { title: `Chapter ${pending.chapterNo}: ${String(obj.title ?? "Untitled")}`, summary: String(obj.summary) };
      },
    );

    await step.do("save chapter", async () => {
      const agent = await getAgentByName(this.env.MythAgent, world);
      return agent.saveChapter(chapter.title, chapter.summary, pending.events[pending.events.length - 1].id);
    });
    return chapter;
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

/** True if any meaningful word of `item` appears in `text`. */
function mentions(text: string, item: string) {
  const hay = text.toLowerCase();
  return item.split(/\s+/).some((w) => w.length >= 3 && hay.includes(w.replace(/s$/, "")));
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
