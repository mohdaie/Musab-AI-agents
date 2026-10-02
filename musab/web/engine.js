/* The agents, running in this browser. Same rules as the Python version (musab/agent.py):
   every agent decides for itself whether to react, has its own prompt, skills and memory,
   pulls others in with @name, and agent-to-agent chains stop at the hop limit. */
import { db } from "./db.js";
import { api, session } from "./server.js";

export const MODELS = {
  "deepseek-v4-pro": "DeepSeek V4 Pro (strongest)",
  "deepseek-flash": "DeepSeek V4.1 Flash (cheaper, faster)",
};

/* How much each agent talks. Every member has their own level (agent.talk), changeable any time;
   the Admin setting is only the default for new members. This is the main lever on token use:
   responders = a message to the whole group reaches this agent only if it ranks in the top N most
   relevant members (0 = always; @named agents always answer), hops = how far it passes a thread on,
   maxReplies = agent replies per thread before it goes quiet, history = past messages it reads,
   thinking = reasoning effort (billed as output tokens), maxTokens = reply cap. */
export const TALK = {
  brief: { label: "Light", desc: "Answers group messages only when most relevant, in 1–2 sentences. No thinking. Cheapest.",
    responders: 1, hops: 2, maxReplies: 5, history: 15, thinking: "off", maxTokens: 400,
    style: "Answer in 1-2 short sentences. Only speak if you're the most relevant member; if your point is already made, answer PASS." },
  balanced: { label: "Balanced", desc: "Answers when among the 2 most relevant, in a few sentences. Light thinking.",
    responders: 2, hops: 3, maxReplies: 10, history: 30, thinking: "low", maxTokens: 0,
    style: "Keep it short: 2-4 sentences or a short list. Don't repeat others; if you have nothing new, answer PASS." },
  detailed: { label: "Detailed", desc: "Always answers, in depth, with full thinking. Uses the most tokens.",
    responders: 0, hops: 6, maxReplies: 20, history: 60, thinking: null, maxTokens: 0,
    style: "Be thorough where it helps, but don't pad." },
};
export const TALK_LEVELS = Object.keys(TALK);
/** An agent's level, falling back to the default from Admin. */
export const talk = (agent) => TALK[agent?.talk] || TALK[session.settings().talk] || TALK.balanced;

const STOP = new Set("the and for you are was what how why who can with this that have has our your they them from about will just not but any all".split(" "));
/** Members ranked by how well their name/role/persona match the message, taking turns on ties; first `n`. */
export function pickResponders(agents, text, msgId, n = agents.length) {
  const words = [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)))];
  const len = agents.length;
  return agents
    .map((a, i) => {
      const about = `${a.name} ${a.role} ${a.persona}`.toLowerCase();
      return { a, score: words.filter((w) => about.includes(w)).length, turn: (i - msgId % len + len) % len };
    })
    .sort((x, y) => y.score - x.score || x.turn - y.turn)
    .slice(0, n)
    .map((x) => x.a);
}

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MENTION_RE = /@([a-z][a-z0-9_-]{0,31})/gi;
const RESERVED = new Set(["user", "all", "system"]);
const MAX_AGENTS = 12;
const MAX_TOOL_STEPS = 8;

const CRITICAL_REVIEW = `- When another agent proposes a cause or fix, check it against your own domain before agreeing.
- If you disagree, say why in one or two lines and what evidence would settle it.
- Do not repeat what another agent already said; add only new information or PASS.`;

const TOOLS = [
  { type: "function", function: {
    name: "send_message",
    description: "Send a message to one or more agents (or 'user', or 'all'). Use it to ask another member something or hand work off.",
    parameters: { type: "object", properties: {
      to: { type: "array", items: { type: "string" }, description: "Recipient names, e.g. ['charles'] or ['all']" },
      content: { type: "string" } }, required: ["to", "content"] } } },
  { type: "function", function: {
    name: "remember",
    description: "Save a durable fact to your long-term memory. Set shared=true to save it to team memory every member can read.",
    parameters: { type: "object", properties: {
      content: { type: "string" }, shared: { type: "boolean", default: false } }, required: ["content"] } } },
  { type: "function", function: {
    name: "recall",
    description: "Search your long-term memory and team memory by keywords.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: {
    name: "forget",
    description: "Delete a memory by id (your own or team memory).",
    parameters: { type: "object", properties: { memory_id: { type: "integer" } }, required: ["memory_id"] } } },
  { type: "function", function: {
    name: "list_agents",
    description: "List the members of the team and their roles.",
    parameters: { type: "object", properties: {} } } },
];
const SHARED = "_shared";

const slug = (s, n) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, n).replace(/^-+|-+$/g, "");

/** '@zu @charles why is X slow' -> [['zu','charles'], 'why is X slow'] */
export function parseTo(text, fallback = ["all"]) {
  const to = [];
  let m;
  while ((m = /^\s*@([\w-]+)\s*/.exec(text))) { to.push(m[1].toLowerCase()); text = text.slice(m[0].length); }
  return [to.length ? to : fallback, text.trim()];
}

// ------------------------------------------------------------------ DeepSeek (through the server)
/** One chat completion, relayed by the server with its stored keys (fallback and usage are handled there). */
export async function chat({ model, messages, tools, thinking, maxTokens = 0, meta = {} }) {
  if (!session.signedIn()) throw new Error("This device isn't signed in. Open Admin and sign in so the agents can reply.");
  return api("/chat", { method: "POST", body: { model, messages, tools, thinking: thinking || "off", max_tokens: maxTokens || 0, meta } });
}

// ------------------------------------------------------------------ teams
export async function createTeam({ name, style, agents }) {
  name = String(name || "").trim().slice(0, 60);
  style = style === "friends" ? "friends" : style === "work" ? "work" : null;
  if (!name) throw new Error("Give the team a name");
  if (!style) throw new Error("Pick a kind of team");
  if (!Array.isArray(agents) || agents.length < 1 || agents.length > MAX_AGENTS) throw new Error(`A team needs 1 to ${MAX_AGENTS} agents`);
  const seen = new Set();
  const list = agents.map((a, i) => makeAgent(a, i, style, seen));
  const existing = new Set((await db.teams()).map((t) => t.id));
  const base = slug(name, 32) || "team";
  let id = base, k = 2;
  while (existing.has(id)) id = `${base}-${k++}`;
  const team = { id, name, style, agents: list, created_at: Date.now() / 1000 };
  await db.saveTeam(team);
  return team;
}

/** Validate one member. `seen` holds the names already taken in the team. */
function makeAgent(a, i, style, seen) {
  const role = String(a.role || "").trim().slice(0, 120);
  const persona = String(a.about || "").trim().slice(0, 2000);
  let n = slug(a.name || "", 32).replace(/-/g, "_") || `agent${i + 1}`;
  if (!/^[a-z]/.test(n)) n = `a${n}`.slice(0, 32);
  if (!role) throw new Error(`Agent #${i + 1} needs a designation`);
  if (!NAME_RE.test(n) || RESERVED.has(n)) throw new Error(`'${n}' can't be used as a name`);
  if (seen.has(n)) throw new Error(`Someone in the team is already called '${n}'`);
  seen.add(n);
  const level = TALK[a.talk] ? a.talk : (TALK[session.settings().talk] ? session.settings().talk : "balanced");
  return { name: n, role, persona, talk: level, skills: style === "work" ? ["critical-review"] : [], thinking: style === "work" ? "high" : "low" };
}

/** Change how much one member talks (Light / Balanced / Detailed). */
export async function setAgentTalk(teamId, name, level) {
  if (!TALK[level]) throw new Error("Unknown level");
  const team = await db.team(teamId);
  const agent = team?.agents.find((a) => a.name === name);
  if (!agent) throw new Error(`No one called @${name} in this team`);
  agent.talk = level;
  await db.saveTeam(team);
  return team;
}

export async function addMember(teamId, a) {
  const team = await db.team(teamId);
  if (!team) throw new Error("Team not found");
  if (team.agents.length >= MAX_AGENTS) throw new Error(`A team can have up to ${MAX_AGENTS} members`);
  const agent = makeAgent(a, team.agents.length, team.style, new Set(team.agents.map((x) => x.name)));
  team.agents.push(agent);
  await db.saveTeam(team);
  await db.post(team.id, "system", ["user"], `@${agent.name} (${agent.role}) joined the ${team.style === "friends" ? "group" : "team"}.`);
  return team;
}

/** Remove a member and their private memory. Their old messages stay in the chat. */
export async function removeMember(teamId, name) {
  const team = await db.team(teamId);
  if (!team) throw new Error("Team not found");
  if (team.agents.length <= 1) throw new Error("A team needs at least one member. Delete the team instead.");
  const agent = team.agents.find((a) => a.name === name);
  if (!agent) throw new Error(`No one called @${name} in this team`);
  team.agents = team.agents.filter((a) => a.name !== name);
  await db.saveTeam(team);
  await db.deleteMemories(team.id, name);
  await db.post(team.id, "system", ["user"], `@${name} left the ${team.style === "friends" ? "group" : "team"}.`);
  return team;
}

// ------------------------------------------------------------------ the agents
function shouldReact(agent, msg, roster, maxHops) {
  if (msg.sender === agent.name) return false;
  if (!msg.recipients.includes(agent.name) && !msg.recipients.includes("all")) return false;
  const fromAgent = roster.has(msg.sender);
  if (msg.recipients.includes(agent.name)) return !fromAgent || msg.hop < maxHops;
  return !fromAgent; // broadcasts from other agents are FYI only
}

async function recall(team, owners, query, limit) {
  const mine = (await db.memories(team)).filter((m) => owners.includes(m.owner));
  const terms = [...new Set((String(query || "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1))];
  if (!terms.length) return mine.sort((a, b) => b.id - a.id).slice(0, limit);
  return mine
    .map((m) => ({ m, s: terms.filter((t) => m.content.toLowerCase().includes(t)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.m.id - a.m.id)
    .slice(0, limit)
    .map((x) => x.m);
}

async function systemPrompt(team, agent, msg) {
  const others = team.agents.filter((a) => a.name !== agent.name).map((a) => `- @${a.name}: ${a.role}`).join("\n");
  const owners = [agent.name, SHARED];
  const seen = new Set(), mems = [];
  for (const m of [...await recall(team.id, owners, msg.content, 6), ...await recall(team.id, owners, "", 6)]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    mems.push(`- [${m.id}|${m.owner === SHARED ? "team" : "own"}] ${m.content}`);
  }
  const memory = mems.join("\n") || "(nothing saved yet)";
  if (team.style === "friends") {
    return `You are ${agent.name}, ${agent.role}.
${agent.persona}

## The group chat (${team.name})
You are one of a group of friends chatting with each other. Everyone has their own personality:
${others || "(nobody else is here yet)"}
The human friend is "user".

## How to chat
- Talk like a real friend in a group chat: casual, warm, short messages. Stay in character.
- Your answer is posted to whoever messaged you. Write @name to bring a friend into the conversation; they will answer you.
- React to what the others said, tease them a little, agree or disagree with your own opinion.
- You can see the recent group chat; use it when someone asks what was said.
- Don't repeat what someone else already said. If you have nothing to add, answer exactly PASS (nothing is posted).

## Length
${talk(agent).style}

## Things you remember (use remember/recall/forget tools to manage it)
${memory}
`;
  }
  const skills = agent.skills.map((s) => `### Skill: ${s}\n${s === "critical-review" ? CRITICAL_REVIEW : "(no notes)"}`).join("\n\n") || "(no extra skills)";
  return `You are ${agent.name}, ${agent.role}.
${agent.persona}

## Your team (${team.name}): independent agents, no boss, no router
${others || "(you are alone right now)"}
The human is "user".

## How messaging works
- Your final answer is posted to whoever messaged you.
- Write @name in your answer to pull that agent into the conversation; they will receive it and reply to you directly.
- Or call send_message to message someone separately.
- Stay inside your own expertise. If something belongs to another agent's skillset, hand it to them with @name instead of guessing.
- Challenge other agents when you think they are wrong; give evidence.
- You can see the recent group chat. When asked to summarise or compile what was said, use it.
- If you have nothing useful to add, answer exactly PASS (nothing is posted).
- Be concise.

## Your skills
${skills}

## Length
${talk(agent).style}

## Your persistent memory (use remember/recall/forget tools to manage it)
${memory}
`;
}

// Agents read the recent group chat, like a person scrolling up, not just the current thread:
// every new message from the user starts a thread, but "compile what the team said" needs the chat.
async function userPrompt(team, agent, msg) {
  const n = talk(agent).history;
  const history = (await db.recent(team.id, n + 20))
    .filter((m) => m.id < msg.id && m.sender !== "system").slice(-n);
  const line = (m) => `[#${m.id}] ${m.sender} -> ${m.recipients.join(", ")}: ${m.content}`;
  return `Recent group chat (oldest first, last ${n} messages):\n${history.map(line).join("\n") || "(no earlier messages)"}` +
    `\n\nNew message for you:\n[#${msg.id}] ${msg.sender} -> ${msg.recipients.join(", ")} (hop ${msg.hop}): ${msg.content}`;
}

export class Engine extends EventTarget {
  constructor({ chatImpl = chat } = {}) {
    super();
    this.chat = chatImpl;
    this.queues = new Map(); // "team/agent" -> promise tail (each agent works through its own queue)
    this.busy = new Map();   // team -> Set(agent names)
  }

  busyIn(team) { return [...(this.busy.get(team) || [])].sort(); }
  changed(team) { this.dispatchEvent(new CustomEvent("change", { detail: { team } })); }

  /** The user posts a message. Leading @names address specific members. */
  async post(teamId, content) {
    const team = await db.team(teamId);
    if (!team) throw new Error("Team not found");
    const [to, text] = parseTo(String(content).slice(0, 8000));
    if (!text) throw new Error("Message is empty");
    const names = new Set(team.agents.map((a) => a.name));
    const unknown = to.find((t) => t !== "all" && !names.has(t));
    if (unknown) throw new Error(`No one called @${unknown} in this team`);
    const msg = await db.post(team.id, "user", to, text);
    if (!session.signedIn() || session.mustChange()) {
      await db.post(team.id, "system", ["user"], session.signedIn()
        ? "Change the default admin password in Admin first, then send your message again."
        : "This device isn't signed in. Open Admin and sign in, then send your message again.", msg);
    } else {
      this.deliver(team, msg);
    }
    this.changed(team.id);
    return msg;
  }

  deliver(team, msg) {
    const roster = new Set(team.agents.map((a) => a.name));
    // A message from the user to everyone: each member answers only if it ranks high enough
    // for its own level (Light: most relevant only, Balanced: top 2, Detailed: always).
    const toAll = msg.sender === "user" && msg.recipients.includes("all");
    const rank = toAll ? pickResponders(team.agents, msg.content, msg.id, team.agents.length).map((a) => a.name) : [];
    for (const agent of team.agents) {
      const t = talk(agent);
      if (!shouldReact(agent, msg, roster, t.hops)) continue;
      if (toAll && t.responders && rank.indexOf(agent.name) >= t.responders) continue;
      const key = `${team.id}/${agent.name}`;
      const tail = (this.queues.get(key) || Promise.resolve()).then(() => this.handle(team.id, agent.name, msg));
      this.queues.set(key, tail.catch(() => {}));
    }
  }

  async handle(teamId, agentName, msg) {
    const team = await db.team(teamId);
    const agent = team?.agents.find((a) => a.name === agentName);
    if (!agent) return null; // team deleted or member removed meanwhile
    const model = session.settings().models[team.style] || "deepseek-v4-pro";
    const { maxReplies, thinking, maxTokens } = talk(agent);
    const roster = new Set(team.agents.map((a) => a.name));
    if (await db.countThreadReplies(team.id, msg.thread_id, roster) >= maxReplies) return null;

    if (!this.busy.has(team.id)) this.busy.set(team.id, new Set());
    this.busy.get(team.id).add(agent.name);
    this.changed(team.id);
    try {
      const messages = [
        { role: "system", content: await systemPrompt(team, agent, msg) },
        { role: "user", content: await userPrompt(team, agent, msg) },
      ];
      let reply = "";
      let step = 0;
      for (; step < MAX_TOOL_STEPS; step++) {
        const out = await this.chat({ model, messages, tools: TOOLS, thinking: thinking ?? agent.thinking, maxTokens,
          meta: { team: team.id, agent: agent.name } });
        messages.push(out);
        if (!out.tool_calls?.length) { reply = (out.content || "").trim(); break; }
        for (const c of out.tool_calls) {
          let result;
          try { result = await this.runTool(team, agent, c.function.name, JSON.parse(c.function.arguments || "{}"), msg, roster); }
          catch (e) { result = `tool error: ${e.message}`; }
          messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
        }
      }
      if (step === MAX_TOOL_STEPS) {
        const last = messages[messages.length - 1];
        reply = last.role === "assistant" ? (last.content || "").trim() : "";
      }
      if (!reply || /^\W*pass\b/i.test(reply)) return null; // "PASS", "PASS — nothing to add", ...
      const mentions = [...reply.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()).filter((n) => roster.has(n) && n !== agent.name);
      const out = await db.post(team.id, agent.name, [msg.sender, ...mentions], reply, msg);
      this.deliver(team, out);
      return out;
    } catch (e) {
      await db.post(team.id, "system", ["user"], `${agent.name} couldn't reply: ${e.message}`, msg);
      return null;
    } finally {
      this.busy.get(team.id)?.delete(agent.name);
      this.changed(team.id);
    }
  }

  async runTool(team, agent, name, args, msg, roster) {
    if (name === "send_message") {
      let to = args.to || [];
      if (typeof to === "string") to = to.split(/[,\s]+/).filter(Boolean);
      to = to.map((t) => String(t).toLowerCase().replace(/^@/, ""));
      const bad = to.filter((t) => !roster.has(t) && t !== "user" && t !== "all");
      if (bad.length) return `Unknown recipient(s): ${bad.join(", ")}. Known: ${[...roster].join(", ")}, user, all`;
      const m = await db.post(team.id, agent.name, to, String(args.content || ""), msg);
      this.deliver(team, m);
      this.changed(team.id);
      return `sent as message #${m.id}`;
    }
    if (name === "remember") {
      const owner = args.shared ? SHARED : agent.name;
      const m = await db.remember(team.id, owner, String(args.content || ""));
      return `saved memory #${m.id} (${owner === SHARED ? "team" : "own"})`;
    }
    if (name === "recall") {
      const hits = await recall(team.id, [agent.name, SHARED], args.query, 10);
      return hits.map((m) => `[${m.id}|${m.owner === SHARED ? "team" : "own"}] ${m.content}`).join("\n") || "no matches";
    }
    if (name === "forget") {
      return (await db.forget(team.id, [agent.name, SHARED], args.memory_id)) ? "deleted" : "no such memory";
    }
    if (name === "list_agents") {
      return team.agents.map((a) => `${a.name}: ${a.role}`).join("\n");
    }
    return `unknown tool ${name}`;
  }
}
