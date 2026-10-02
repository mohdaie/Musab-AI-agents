/* The agents, running in this browser. Same rules as the Python version (musab/agent.py):
   every agent decides for itself whether to react, has its own prompt, skills and memory,
   pulls others in with @name, and agent-to-agent chains stop at the hop limit. */
import { config, db } from "./db.js";

export const API_BASE = "https://api.deepseek.com";
export const MODELS = {
  "deepseek-v4-pro": "DeepSeek V4 Pro (strongest)",
  "deepseek-flash": "DeepSeek V4.1 Flash (cheaper, faster)",
};
// USD per 1M tokens as [off-peak, peak]. Source: api-docs.deepseek.com/quick_start/pricing (Oct 2026).
export const PRICES = {
  "deepseek-flash": { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
  "deepseek-v4-pro": { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
};
// Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
export function isPeak(ms) {
  const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
export function estimateCost(model, u, ms) {
  const p = PRICES[model];
  if (!p) return 0;
  const i = isPeak(ms) ? 1 : 0;
  const hit = u.cacheHit || 0, miss = u.cacheMiss || Math.max(0, (u.prompt || 0) - hit);
  return (hit * p.hit[i] + miss * p.miss[i] + (u.completion || 0) * p.out[i]) / 1e6;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s, n) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, n).replace(/^-+|-+$/g, "");

/** '@zu @charles why is X slow' -> [['zu','charles'], 'why is X slow'] */
export function parseTo(text, fallback = ["all"]) {
  const to = [];
  let m;
  while ((m = /^\s*@([\w-]+)\s*/.exec(text))) { to.push(m[1].toLowerCase()); text = text.slice(m[0].length); }
  return [to.length ? to : fallback, text.trim()];
}

// ------------------------------------------------------------------ DeepSeek
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function recordUsage(row) { try { await db.addUsage(row); } catch {} }

/** One chat completion. Tries the active key, then the others when a key is invalid or out of balance. */
export async function chat({ model, messages, tools, thinking, meta = {}, fetchImpl = fetch }) {
  const keys = config.keyOrder();
  if (!keys.length) throw new ApiError(0, "No DeepSeek API key yet. Add one in Admin.");
  const body = { model, messages };
  if (tools) body.tools = tools;
  if (!thinking || thinking === "off") body.thinking = { type: "disabled" };
  else { body.thinking = { type: "enabled" }; body.reasoning_effort = thinking; }
  let lastErr = null;
  for (const k of keys) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = Date.now();
      let res, data = null;
      try {
        res = await fetchImpl(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${k.key}` },
          body: JSON.stringify(body),
        });
        data = await res.json().catch(() => null);
      } catch (e) {
        lastErr = new ApiError(0, `Can't reach DeepSeek (${e.message}). Check your connection.`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const u = data?.usage || {};
      const usage = {
        prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0,
        cacheHit: u.prompt_cache_hit_tokens || 0, cacheMiss: u.prompt_cache_miss_tokens || 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens || 0,
      };
      recordUsage({ ts: t0, keyId: k.id, model, team: meta.team || "", agent: meta.agent || "", ok: res.ok,
        status: res.status, ...usage, cost: res.ok ? estimateCost(model, usage, t0) : 0,
        ms: Date.now() - t0, error: res.ok ? "" : String(data?.error?.message || "").slice(0, 200) });
      if (res.ok) {
        if (k.status !== "ok") config.updateKey(k.id, { status: "ok" });
        if (k.id !== config.activeKeyId()) config.saveSettings({ activeKey: k.id }); // fell back: make the working key active
        const msg = data?.choices?.[0]?.message || {};
        const out = { role: "assistant", content: msg.content || "" };
        // DeepSeek wants reasoning_content sent back on later requests that carry tools.
        if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
        if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
        return out;
      }
      const detail = data?.error?.message || res.statusText || "request failed";
      lastErr = new ApiError(res.status, `DeepSeek ${res.status}: ${detail}`);
      if (res.status === 401 || res.status === 402) {  // bad key / no balance: next key
        config.updateKey(k.id, { status: res.status === 401 ? "invalid" : "no-balance" });
        break;
      }
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastErr;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** GET /user/balance for one key. */
export async function checkBalance(key, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/user/balance`, { headers: { Authorization: `Bearer ${key}` } });
  } catch (e) {
    throw new ApiError(0, `Can't reach DeepSeek (${e.message}).`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message || `HTTP ${res.status}`);
  return { available: !!data?.is_available, infos: data?.balance_infos || [], checked_at: Date.now() };
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
  return { name: n, role, persona, skills: style === "work" ? ["critical-review"] : [], thinking: style === "work" ? "high" : "low" };
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
- Don't repeat what someone else already said. If you have nothing to add, answer exactly PASS (nothing is posted).

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
- If you have nothing useful to add, answer exactly PASS (nothing is posted).
- Be concise.

## Your skills
${skills}

## Your persistent memory (use remember/recall/forget tools to manage it)
${memory}
`;
}

async function userPrompt(team, msg) {
  const history = (await db.thread(team.id, msg.thread_id, 31)).filter((m) => m.id < msg.id).slice(-30);
  const line = (m) => `[#${m.id}] ${m.sender} -> ${m.recipients.join(", ")}: ${m.content}`;
  return `Conversation so far (oldest first):\n${history.map(line).join("\n") || "(new thread)"}` +
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
    if (!config.keys().length) {
      await db.post(team.id, "system", ["user"], "No DeepSeek API key yet. Open Admin and add one, then send your message again.", msg);
    } else {
      this.deliver(team, msg);
    }
    this.changed(team.id);
    return msg;
  }

  deliver(team, msg) {
    const { maxHops } = config.settings();
    const roster = new Set(team.agents.map((a) => a.name));
    for (const agent of team.agents) {
      if (!shouldReact(agent, msg, roster, maxHops)) continue;
      const key = `${team.id}/${agent.name}`;
      const tail = (this.queues.get(key) || Promise.resolve()).then(() => this.handle(team.id, agent.name, msg));
      this.queues.set(key, tail.catch(() => {}));
    }
  }

  async handle(teamId, agentName, msg) {
    const team = await db.team(teamId);
    const agent = team?.agents.find((a) => a.name === agentName);
    if (!agent) return null; // team deleted or member removed meanwhile
    const { model, maxReplies } = config.settings();
    const roster = new Set(team.agents.map((a) => a.name));
    if (await db.countThreadReplies(team.id, msg.thread_id, roster) >= maxReplies) return null;

    if (!this.busy.has(team.id)) this.busy.set(team.id, new Set());
    this.busy.get(team.id).add(agent.name);
    this.changed(team.id);
    try {
      const messages = [
        { role: "system", content: await systemPrompt(team, agent, msg) },
        { role: "user", content: await userPrompt(team, msg) },
      ];
      let reply = "";
      let step = 0;
      for (; step < MAX_TOOL_STEPS; step++) {
        const out = await this.chat({ model, messages, tools: TOOLS, thinking: agent.thinking,
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
      if (!reply || /^pass\.?$/i.test(reply)) return null;
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
