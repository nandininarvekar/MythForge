import { Agent, getAgentByName, routeAgentRequest, type Connection, type ConnectionContext } from "agents";
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

type Hero = {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  gold: number;
  location: string;
  inventory: { item: string; qty: number }[];
  online: boolean;
};

export type WorldState = {
  started: boolean;
  heroes: Hero[];
  npcs: { name: string; location: string; attitude: Attitude; memory: string }[];
  recentEvents: string[];
  awayNews: string | null;
  chapters: { title: string; summary: string }[];
  quest: { title: string; stage: number; total: number; objective: string; complete: boolean };
};

type LogEntry = { role: "user" | "assistant" | "system"; hero: string | null; content: string; changes?: string[]; roll?: number };

type Action =
  | { type: "move"; location: string }
  | { type: "add_item"; item: string; qty?: number }
  | { type: "remove_item"; item: string; qty?: number }
  | { type: "give_item"; item: string; qty?: number; to: string }
  | { type: "change_gold"; amount: number }
  | { type: "change_hp"; amount: number }
  | { type: "npc_update"; npc: string; attitude?: string; memory?: string; location?: string }
  | { type: "log_event"; text: string }
  | { type: "advance_quest"; text?: string };

const ACTION_TYPES: Action["type"][] = [
  "move", "add_item", "remove_item", "give_item", "change_gold", "change_hp", "npc_update", "log_event", "advance_quest",
];

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    narration: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ACTION_TYPES },
          location: { type: "string" },
          item: { type: "string" },
          qty: { type: "number" },
          to: { type: "string" },
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

type HeroRow = { id: string; name: string; hp: number; max_hp: number; gold: number; location: string };
type NpcRow = { name: string; location: string; attitude: string; memory: string };

/**
 * One MythAgent (a Durable Object) = one shared world. Any number of heroes can
 * join it via a link. NPCs, quest, chronicle and events are shared; each hero
 * has their own stats and inventory. Clients get live updates over WebSockets:
 * world state via Agent state sync, story lines via broadcast.
 */
export class MythAgent extends Agent<Env, WorldState> {
  initialState: WorldState = {
    started: false,
    heroes: [],
    npcs: [],
    recentEvents: [],
    awayNews: null,
    chapters: [],
    quest: { title: MAIN_QUEST.title, stage: 0, total: MAIN_QUEST.stages.length, objective: "", complete: false },
  };

  /** Turns run one at a time so two heroes can't race on the same world facts. */
  private turnQueue: Promise<unknown> = Promise.resolve();

  async onStart() {
    // Single-player tables from Step 1/2 are replaced by per-hero tables.
    for (const t of ["player", "inventory", "messages"]) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    this.sql`CREATE TABLE IF NOT EXISTS heroes (
      id TEXT PRIMARY KEY, name TEXT UNIQUE, hp INTEGER, max_hp INTEGER, gold INTEGER,
      location TEXT, last_seen INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS items (
      hero_id TEXT, item TEXT, qty INTEGER, PRIMARY KEY (hero_id, item))`;
    this.sql`CREATE TABLE IF NOT EXISTS npcs (
      name TEXT PRIMARY KEY, location TEXT, attitude TEXT, memory TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER, text TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, last_event_id INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, hero TEXT, content TEXT)`;
  }

  // ---------- Live connections (presence) ----------
  onConnect(connection: Connection, ctx: ConnectionContext) {
    const hero = new URL(ctx.request.url).searchParams.get("hero");
    connection.setState({ hero: validId(hero) ? hero : null });
    this.snapshot(); // pushes state (with updated "online" flags) to everyone
  }

  async onClose() {
    this.snapshot();
    // When the last hero leaves, start the "while you were away" clock.
    if (this.onlineHeroIds().size === 0 && this.allHeroes().length > 0) await this.scheduleWorldTick();
  }

  onlineHeroIds() {
    const ids = new Set<string>();
    for (const c of this.getConnections<{ hero: string | null }>()) if (c.state?.hero) ids.add(c.state.hero);
    return ids;
  }

  // ---------- HTTP API ----------
  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") return Response.json(this.snapshot());
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = (await request.json().catch(() => ({}))) as {
      action?: string; hero?: string; name?: string; message?: string;
    };
    try {
      const heroId = validId(body.hero) ? body.hero! : null;
      if (!heroId) return Response.json({ error: "Missing hero id" }, { status: 400 });
      switch (body.action) {
        case "join":
          return Response.json(await this.exclusive(() => this.joinWorld(heroId, body.name ?? "")));
        case "turn":
          return Response.json(await this.exclusive(() => this.playTurn(heroId, body.message ?? "")));
        case "rest": {
          const started = await this.startChronicle(true);
          return Response.json({ chronicling: started, ...this.snapshot() });
        }
        case "reset":
          this.resetWorld();
          return Response.json(this.snapshot());
      }
      return Response.json({ error: "Unknown action" }, { status: 400 });
    } catch (err) {
      console.error(err);
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turnQueue.then(fn, fn);
    this.turnQueue = run.catch(() => {});
    return run;
  }

  // ---------- Game logic ----------
  initWorld() {
    const [done] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'world_init'`;
    if (done) return false;
    for (const n of STARTING_NPCS) {
      this.sql`INSERT OR REPLACE INTO npcs (name, location, attitude, memory)
               VALUES (${n.name}, ${n.location}, ${n.attitude}, ${n.memory})`;
    }
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('world_init', '1')`;
    return true;
  }

  async joinWorld(heroId: string, rawName: string) {
    if (this.getHero(heroId)) return this.snapshot();
    const fresh = this.initWorld();

    let name = rawName.trim().replace(/\s+/g, " ").slice(0, 24) || "Wanderer";
    const taken = (n: string) => this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM heroes WHERE lower(name) = lower(${n})`[0].n > 0;
    for (let i = 2; taken(name); i++) name = `${name.replace(/ \d+$/, "")} ${i}`;

    this.sql`INSERT INTO heroes (id, name, hp, max_hp, gold, location, last_seen)
             VALUES (${heroId}, ${name}, 20, 20, 10, 'Emberfall Square', ${Date.now()})`;
    this.sql`INSERT INTO items (hero_id, item, qty) VALUES (${heroId}, 'rusty dagger', 1), (${heroId}, 'travel bread', 2)`;
    this.logEvent(`${name} arrived in Emberfall.`);

    const intro = fresh
      ? "(I arrive in Emberfall for the first time. Set the scene in 3-4 sentences: the silent bell, the vanishings, and Mira's missing brother Tomas, so I know my goal. End by pointing me toward my first lead.)"
      : "(I arrive in Emberfall, joining the heroes already here. In 2-3 sentences, welcome me: mention the silent bell, the current objective, and who is already in the village and what they are known for.)";
    return this.playTurn(heroId, intro, true);
  }

  async playTurn(heroId: string, message: string, isIntro = false) {
    const hero = this.getHero(heroId);
    if (!hero) throw new Error("Join the world first");
    this.sql`UPDATE heroes SET last_seen = ${Date.now()} WHERE id = ${heroId}`;
    if (hero.hp <= 0) {
      return { narration: "You have fallen. Your tale is told by others now.", changes: [], ...this.snapshot() };
    }
    const text = message.trim().slice(0, 500);
    if (!text) throw new Error("Empty message");

    if (!isIntro) this.pushLog({ role: "user", hero: hero.name, content: text });
    this.broadcast(JSON.stringify({ type: "mf_thinking", hero: hero.name }));

    const roll = 1 + Math.floor(Math.random() * 20);
    const history = this.sql<{ role: string; hero: string | null; content: string }>`
      SELECT role, hero, content FROM (SELECT * FROM log WHERE role != 'system' ORDER BY id DESC LIMIT 10) ORDER BY id ASC`;
    if (!isIntro) history.pop(); // the current message is appended below

    // News from a world tick that happened while everyone was away (shown once).
    const [away] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'away_news'`;
    const awayNote = away
      ? `\n\nWHILE THE HEROES WERE AWAY: ${away.value}\nThe world has changed accordingly; let it show naturally this turn (a look, a rumor, a cold welcome).`
      : "";

    const messages = [
      { role: "system", content: this.systemPrompt(hero, roll) + awayNote },
      ...history.map((m) => ({ role: m.role, content: m.role === "user" ? `${m.hero}: ${m.content}` : m.content })),
      { role: "user", content: `${hero.name}: ${text}` },
    ];

    let parsed: { narration: string; actions: Action[] };
    try {
      const result = (await this.env.AI.run(this.env.MODEL as keyof AiModels, {
        messages,
        max_tokens: 700,
        temperature: 0.8,
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      } as any)) as { response?: unknown };
      parsed = parseModelOutput(result?.response);
    } finally {
      this.broadcast(JSON.stringify({ type: "mf_thinking", hero: null }));
    }

    const changes = this.applyActions(parsed.actions, `${text} ${parsed.narration}`, heroId);
    if (away) this.sql`DELETE FROM meta WHERE key = 'away_news'`;

    this.pushLog({ role: "assistant", hero: hero.name, content: parsed.narration, changes, roll: isIntro ? undefined : roll });

    const chronicling = await this.startChronicle(false);
    await this.scheduleWorldTick();
    const snap = this.snapshot();
    return { narration: parsed.narration, roll, changes, chronicling, ...snap };
  }

  systemPrompt(hero: HeroRow, roll: number) {
    const heroes = this.allHeroes();
    const npcs = this.sql<NpcRow>`SELECT * FROM npcs`;
    const chapters = this.sql<{ title: string; summary: string }>`
      SELECT title, summary FROM chapters ORDER BY id DESC LIMIT 5`.reverse();
    const events = this.sql<{ text: string }>`
      SELECT text FROM events WHERE id > ${this.lastChronicledId()} ORDER BY id DESC LIMIT 15`.reverse();

    return `You are the Dungeon Master of MythForge, a dark-fantasy text adventure set in the village of Emberfall. Several heroes may share this world.
Narrate to the ACTING HERO in second person ("you"); refer to other heroes by name. Be punchy: 2-3 sentences, about 25-50 words. Include one vivid detail and, when it fits, a line of NPC dialogue. Show only what changed or what the hero notices; no scenery recaps. Stay in character. Never decide any hero's actions for them.

THE WORLD FACTS BELOW ARE THE TRUTH. Never contradict them. NPCs remember everything in their "memory", act according to their attitude, and gossip: what one hero did can change how NPCs treat the others.

ACTING HERO: ${hero.name} | HP ${hero.hp}/${hero.max_hp} | Gold ${hero.gold} | Location: ${hero.location}
ALL HEROES:
${heroes.map((h) => `- ${h.name} @ ${h.location} | HP ${h.hp}/${h.maxHp} | Gold ${h.gold} | Items: ${h.inventory.map((i) => `${i.item} x${i.qty}`).join(", ") || "none"}`).join("\n")}
LOCATIONS: ${Object.entries(LOCATIONS).map(([k, v]) => `${k} — ${v}`).join(" | ")}
NPCS:
${npcs.map((n) => `- ${n.name} @ ${n.location} [${n.attitude}]: ${n.memory}`).join("\n")}
THE LEGEND SO FAR (earlier chapters):
${chapters.map((c) => `- ${c.title}: ${c.summary}`).join("\n") || "- (this story has just begun)"}
RECENT EVENTS (oldest first):
${events.map((e) => `- ${e.text}`).join("\n") || "- none"}

MAIN QUEST — "${MAIN_QUEST.title}" (shared by all heroes): ${MAIN_QUEST.premise}
${this.questPromptSection()}

FATE DIE this turn: d20 = ${roll}. Only if the acting hero attempts something risky, use it: 1-5 fails badly, 6-10 fails, 11-15 succeeds with a cost, 16-20 succeeds well. Mention the roll when you use it.

RULES FOR CHANGING THE WORLD: if anything in the story changes the world, you MUST record it as an action, or it did not happen. All actions apply to the ACTING HERO.
- "move": whenever the acting hero goes to a different place, put a move action FIRST, with one of the LOCATIONS (exact name).
- "add_item"/"remove_item": item (lowercase, EXACT inventory name when removing) + qty. Heroes can only use or give items they own. In trades, take ONLY what the hero explicitly offers; never add extra items or gold to the deal.
- "give_item": the acting hero hands an item they own to ANOTHER HERO: item, qty, to (that hero's exact name).
- "change_gold"/"change_hp": amount (+/-). Gold can't go below 0.
- "npc_update": npc name, and any of attitude (${ATTITUDES.join("/")}), memory (ONE short NEW fact naming the hero, e.g. "${hero.name} spat on his anvil."), location. Use this to introduce NEW npcs too.
- "advance_quest": ONLY when a hero has clearly and fully done the CURRENT OBJECTIVE this turn (not just talked about it). Add "text": one sentence on how they did it. Never advance on intent alone.
- "log_event": one short past-tense sentence naming the hero, for anything important (promises, insults, thefts, fights, debts, gifts, discoveries). Almost every turn has one.

EXAMPLE: ${hero.name} says "I go to the tavern and buy an ale" ->
{"narration": "...", "actions": [{"type":"move","location":"The Gilded Tankard"},{"type":"change_gold","amount":-1},{"type":"add_item","item":"ale","qty":1}]}

Reply ONLY with JSON: {"narration": "...", "actions": [ ... ]}`;
  }

  /**
   * @param context text of this turn (hero words + narration). Items can only
   *   be removed if they are mentioned in it, so the DM can't quietly take
   *   things the hero never offered.
   * @param heroId the acting hero (null for world ticks).
   * @param allowed restrict which action types are accepted (used by world ticks).
   */
  applyActions(actions: Action[], context: string, heroId: string | null, allowed?: Action["type"][]) {
    const changes: string[] = [];
    const hero = heroId ? this.getHero(heroId) : null;
    for (const a of actions.slice(0, 10)) {
      if (allowed && !allowed.includes(a.type)) continue;
      if (!hero && a.type !== "npc_update" && a.type !== "log_event") continue;
      try {
        switch (a.type) {
          case "move": {
            const loc = Object.keys(LOCATIONS).find((l) => l.toLowerCase() === String(a.location).toLowerCase());
            if (loc && loc !== this.getHero(heroId!)!.location) {
              this.sql`UPDATE heroes SET location = ${loc} WHERE id = ${heroId}`;
              changes.push(`📍 Moved to ${loc}`);
            }
            break;
          }
          case "add_item": {
            const item = cleanName(a.item);
            const qty = clampInt(a.qty ?? 1, 1, 99);
            if (!item) break;
            this.addItem(heroId!, item, qty);
            changes.push(`🎒 +${qty} ${item}`);
            break;
          }
          case "remove_item":
          case "give_item": {
            const item = cleanName(a.item);
            const qty = clampInt(a.qty ?? 1, 1, 99);
            const [row] = this.sql<{ qty: number }>`SELECT qty FROM items WHERE hero_id = ${heroId} AND item = ${item}`;
            if (!row) break;
            if (!mentions(context, item)) {
              console.warn(`Blocked removal of unmentioned item: ${item}`);
              break;
            }
            let target: HeroRow | undefined;
            if (a.type === "give_item") {
              [target] = this.sql<HeroRow>`SELECT * FROM heroes WHERE lower(name) = lower(${cleanName(a.to, false)})`;
              if (!target || target.id === heroId) break;
            } else if (/\b(give|gives|gave|hand|hands|handed|pass|passes|lend|toss|offer)\b/i.test(context)) {
              // The model often says "remove" for a gift; if another hero is named, move it to them instead.
              target = this.sql<HeroRow>`SELECT * FROM heroes WHERE id != ${heroId}`
                .find((h) => new RegExp(`\\b${escapeRe(h.name)}\\b`, "i").test(context));
            }
            const moved = Math.min(qty, row.qty);
            if (row.qty <= qty) this.sql`DELETE FROM items WHERE hero_id = ${heroId} AND item = ${item}`;
            else this.sql`UPDATE items SET qty = qty - ${qty} WHERE hero_id = ${heroId} AND item = ${item}`;
            if (target) {
              this.addItem(target.id, item, moved);
              this.logEvent(`${hero!.name} gave ${target.name} ${moved} ${item}.`);
              changes.push(`🤝 Gave ${target.name} ${moved} ${item}`);
            } else changes.push(`🎒 −${moved} ${item}`);
            break;
          }
          case "change_gold": {
            const amt = clampInt(a.amount, -1000, 1000);
            if (!amt) break;
            this.sql`UPDATE heroes SET gold = MAX(0, gold + ${amt}) WHERE id = ${heroId}`;
            changes.push(`🪙 ${amt > 0 ? "+" : ""}${amt} gold`);
            break;
          }
          case "change_hp": {
            const amt = clampInt(a.amount, -20, 20);
            if (!amt) break;
            this.sql`UPDATE heroes SET hp = MIN(max_hp, MAX(0, hp + ${amt})) WHERE id = ${heroId}`;
            changes.push(`❤️ ${amt > 0 ? "+" : ""}${amt} HP`);
            if (this.getHero(heroId!)!.hp <= 0) this.logEvent(`${hero!.name} fell in battle.`);
            break;
          }
          case "npc_update": {
            const name = cleanName(a.npc, false);
            if (!name) break;
            const [existing] = this.sql<NpcRow>`SELECT * FROM npcs WHERE lower(name) = lower(${name})`;
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
              ?? existing?.location ?? hero?.location ?? "Emberfall Square";
            if (existing) {
              this.sql`UPDATE npcs SET attitude = ${attitude}, memory = ${memory}, location = ${location}
                       WHERE name = ${existing.name}`;
              if (existing.attitude !== attitude) {
                changes.push(`🧑 ${existing.name}: ${existing.attitude} → ${attitude}`);
                // Don't rely on the model to log relationship changes — they're what the legend is made of.
                this.logEvent(`${existing.name} became ${attitude}${hero ? ` toward ${hero.name}` : ""}.${fact ? " " + fact : ""}`);
              } else changes.push(`🧠 ${existing.name} will remember that`);
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
            this.logEvent(`QUEST: ${a.text ? String(a.text).slice(0, 160) : `${hero!.name} completed: ${done}`}`);
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

  addItem(heroId: string, item: string, qty: number) {
    this.sql`INSERT INTO items (hero_id, item, qty) VALUES (${heroId}, ${item}, ${qty})
             ON CONFLICT(hero_id, item) DO UPDATE SET qty = qty + ${qty}`;
  }

  resetWorld() {
    for (const t of ["heroes", "items", "npcs", "events", "log", "chapters", "meta"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
    }
    this.broadcast(JSON.stringify({ type: "mf_reset" }));
    this.setState({ ...this.initialState });
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
    const names = this.allHeroes().map((h) => h.name);
    const events = this.sql<{ id: number; text: string }>`
      SELECT id, text FROM events WHERE id > ${this.lastChronicledId()} ORDER BY id ASC LIMIT 40`;
    const [count] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM chapters`;
    return { hero: names.join(" and ") || "the heroes", chapterNo: count.n + 1, events };
  }

  saveChapter(title: string, summary: string, lastEventId: number) {
    if (lastEventId <= this.lastChronicledId()) return false; // already saved (workflow retry)
    this.sql`INSERT INTO chapters (title, summary, last_event_id)
             VALUES (${title.slice(0, 80)}, ${summary.slice(0, 600)}, ${lastEventId})`;
    this.sql`DELETE FROM meta WHERE key = 'chronicle_started'`;
    this.pushLog({ role: "system", hero: null, content: `📖 ${title} — ${summary}` });
    this.snapshot(); // push new state to any connected clients
    return true;
  }

  // ---------- World ticks (Agent scheduler) ----------
  /** (Re)arm a single tick that fires once the whole world has been quiet for a while. */
  async scheduleWorldTick() {
    for (const sch of this.getSchedules()) {
      if (sch.callback === "worldTick") await this.cancelSchedule(sch.id);
    }
    await this.schedule(Number(this.env.TICK_SECONDS ?? 600), "worldTick");
  }

  /** The world moves without the heroes: grudges spread, favors are remembered. */
  async worldTick() {
    const heroes = this.allHeroes().filter((h) => h.hp > 0);
    if (heroes.length === 0) return;
    if (heroes.some((h) => h.online)) return; // someone is still playing; the clock restarts when they leave
    const [existing] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'away_news'`;
    if (existing) return; // one tick per absence keeps the world (and the AI budget) calm

    const names = heroes.map((h) => h.name).join(", ");
    const first = heroes[0].name;
    const npcs = this.sql<NpcRow>`SELECT * FROM npcs`;
    const events = this.sql<{ text: string }>`SELECT text FROM events ORDER BY id DESC LIMIT 10`.reverse();
    const result = (await this.env.AI.run(this.env.MODEL as keyof AiModels, {
      messages: [
        {
          role: "system",
          content: `You simulate the village of Emberfall while its heroes (${names}) are away (a night passes).
Based ONLY on the facts below, decide 1-2 believable consequences of the heroes' past actions: hostile NPCs spread rumors and turn others wary; grateful NPCs defend a hero; debts and promises come up; the mystery of the silent bell deepens.
If the heroes have done nothing notable, describe one small eerie happening linked to the main quest instead.
Main quest: ${MAIN_QUEST.premise} ${this.questPromptSection()}
NPCS:
${npcs.map((n) => `- ${n.name} @ ${n.location} [${n.attitude}]: ${n.memory}`).join("\n")}
RECENT EVENTS:
${events.map((e) => `- ${e.text}`).join("\n") || "- none"}

Be SPECIFIC: name who did what, where, and why.
Every attitude change in your narration MUST also appear as an npc_update action.
Reply ONLY with JSON: {"narration": "<what happened, 1-2 sentences, under 40 words, past tense>", "actions": [...]}
Allowed actions: "npc_update" (npc, attitude ${ATTITUDES.join("/")}, memory = ONE new fact) and "log_event" (text). Change at most 2 attitudes, by one step at most.`,
        },
        {
          role: "user",
          content: `What happened in Emberfall overnight? Example of a GOOD answer (do not copy it):
{"narration": "Over ale, Bram told everyone ${first} cheated him. Old Tessa spat at the mention of ${first}'s name.", "actions": [{"type":"npc_update","npc":"Old Tessa","attitude":"hostile","memory":"Heard from Bram that ${first} is a cheat."}]}
A BAD answer is vague, like "Rumors spread, villagers became wary."`,
        },
      ],
      max_tokens: 400,
      temperature: 0.9,
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    } as any)) as { response?: unknown };

    const parsed = parseModelOutput(result?.response);
    this.applyActions(parsed.actions, "", null, ["npc_update", "log_event"]);
    this.logEvent(`While the heroes were away: ${parsed.narration.slice(0, 180)}`);
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('away_news', ${parsed.narration})`;
    this.pushLog({ role: "system", hero: null, content: `🌙 While you were away… ${parsed.narration}` });
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
      return "QUEST COMPLETE: the bell rings again. The heroes are legends; let them roam freely and enjoy the consequences.";
    }
    const s = MAIN_QUEST.stages[stage];
    return `CURRENT OBJECTIVE (stage ${stage + 1}/${MAIN_QUEST.stages.length}): ${s.objective}
SECRET DM HINT: ${s.hint}
DONE WHEN: ${s.doneWhen} -> the moment this happens in your narration, include {"type":"advance_quest"}.
Heroes are free to wander, but if one seems lost or asks what to do, let an NPC or detail nudge them toward the current objective. Never solve it for them.`;
  }

  // ---------- Helpers ----------
  getHero(id: string) {
    const [h] = this.sql<HeroRow>`SELECT * FROM heroes WHERE id = ${id}`;
    return h ?? null;
  }

  allHeroes(): Hero[] {
    const online = this.onlineHeroIds();
    const items = this.sql<{ hero_id: string; item: string; qty: number }>`SELECT * FROM items ORDER BY item`;
    return this.sql<HeroRow>`SELECT * FROM heroes ORDER BY rowid`.map((h) => ({
      id: h.id,
      name: h.name,
      hp: h.hp,
      maxHp: h.max_hp,
      gold: h.gold,
      location: h.location,
      inventory: items.filter((i) => i.hero_id === h.id).map(({ item, qty }) => ({ item, qty })),
      online: online.has(h.id),
    }));
  }

  /** Store a story line and stream it to every connected hero. */
  pushLog(entry: LogEntry) {
    this.sql`INSERT INTO log (role, hero, content) VALUES (${entry.role}, ${entry.hero}, ${entry.content})`;
    this.sql`DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT 60)`;
    this.broadcast(JSON.stringify({ type: "mf_log", entry }));
  }

  logEvent(text: string) {
    const [dup] = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM (SELECT text FROM events ORDER BY id DESC LIMIT 5) WHERE lower(text) = lower(${text})`;
    if (dup.n > 0) return; // skip repeats of a recent event
    const [count] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM log WHERE role = 'user'`;
    this.sql`INSERT INTO events (turn, text) VALUES (${count.n}, ${text})`;
  }

  snapshot() {
    const heroes = this.allHeroes();
    const state: WorldState = {
      started: heroes.length > 0,
      heroes,
      npcs: this.sql<NpcRow>`SELECT * FROM npcs ORDER BY name` as WorldState["npcs"],
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
    this.setState(state); // Agent state sync -> every connected WebSocket client re-renders
    const log = this.sql<{ role: string; hero: string | null; content: string }>`SELECT role, hero, content FROM log ORDER BY id ASC`;
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

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
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
