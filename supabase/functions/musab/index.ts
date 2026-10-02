// Musab Agents server: admin login, DeepSeek API keys, settings, usage, and the DeepSeek relay.
// Keys never leave the server; the web app sends chat requests here with its session token.
// Tables (RLS on, no policies) are only reachable with the service role this function runs with.
import { createClient } from "npm:@supabase/supabase-js@2";
import { discover, fetchSkill, GitHubError, parseSkillMd } from "./github.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const DEEPSEEK = "https://api.deepseek.com";
const SESSION_DAYS = 60;
const MAX_FAILS = 8, LOCK_MIN = 15;

// USD per 1M tokens as [off-peak, peak]. Source: api-docs.deepseek.com/quick_start/pricing (Oct 2026).
const PRICES: Record<string, { hit: number[]; miss: number[]; out: number[] }> = {
  "deepseek-flash": { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
  "deepseek-v4-pro": { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
};
const isPeak = (d: Date) => {
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
};
function cost(model: string, u: { prompt: number; completion: number; cache_hit: number; cache_miss: number }, d: Date) {
  const p = PRICES[model]; if (!p) return 0;
  const i = isPeak(d) ? 1 : 0;
  const miss = u.cache_miss || Math.max(0, u.prompt - u.cache_hit);
  return (u.cache_hit * p.hit[i] + miss * p.miss[i] + u.completion * p.out[i]) / 1e6;
}

// ------------------------------------------------------------------ http helpers
const ORIGINS = [/^https:\/\/mohdaie\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return ORIGINS.some((r) => r.test(o))
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
    : { Vary: "Origin" };
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (req: Request, status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ------------------------------------------------------------------ sessions (HMAC-signed, revoked on password change)
const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data))));
}
async function config() {
  const { data, error } = await sb.from("app_config").select("*").eq("id", 1).single();
  if (error) throw new HttpError(500, "config missing");
  return data;
}
async function issue(cfg: any) {
  const body = b64url(enc.encode(JSON.stringify({ v: cfg.token_version, exp: Date.now() + SESSION_DAYS * 864e5 })));
  return `${body}.${await hmac(cfg.session_secret, body)}`;
}
async function requireSession(req: Request) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [body, sig] = t.split(".");
  const cfg = await config();
  if (!body || !sig || sig !== await hmac(cfg.session_secret, body)) throw new HttpError(401, "Sign in again");
  let p: any;
  try { p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))); } catch { throw new HttpError(401, "Sign in again"); }
  if (p.v !== cfg.token_version || p.exp < Date.now()) throw new HttpError(401, "Sign in again");
  return cfg;
}

// ------------------------------------------------------------------ deepseek
async function balance(key: string) {
  const r = await fetch(`${DEEPSEEK}/user/balance`, { headers: { Authorization: `Bearer ${key}` } });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(r.status === 401 ? 400 : 502, r.status === 401 ? "DeepSeek says this key is invalid." : d?.error?.message || `DeepSeek ${r.status}`);
  return { available: !!d?.is_available, infos: d?.balance_infos || [], checked_at: Date.now() };
}
const publicKey = (k: any) => ({ id: k.id, label: k.label, masked: `${k.key.slice(0, 3)}…${k.key.slice(-4)}`, status: k.status, balance: k.balance, created_at: k.created_at });
async function keyOrder(settings: any) {
  const { data } = await sb.from("api_keys").select("*").order("created_at");
  const keys = data || [];
  const active = keys.find((k) => k.id === settings.activeKey) || keys[0];
  if (!active) return [];
  if (settings.fallback === false) return [active];
  const bad = (k: any) => (k.status === "invalid" || k.status === "no-balance" ? 1 : 0);
  return [active, ...keys.filter((k) => k.id !== active.id)].sort((a, b) => bad(a) - bad(b));
}

async function chat(req: Request, cfg: any) {
  const b = await req.json();
  const model = String(b.model || "");
  if (!PRICES[model]) throw new HttpError(400, "unknown model");
  if (!Array.isArray(b.messages) || JSON.stringify(b.messages).length > 1_500_000) throw new HttpError(400, "bad messages");
  const body: any = { model, messages: b.messages };
  if (Array.isArray(b.tools)) body.tools = b.tools;
  if (!b.thinking || b.thinking === "off") body.thinking = { type: "disabled" };
  else { body.thinking = { type: "enabled" }; body.reasoning_effort = ["low", "high", "max"].includes(b.thinking) ? b.thinking : "high"; }
  if (Number(b.max_tokens) > 0) body.max_tokens = Math.min(Number(b.max_tokens), 32000);
  const meta = { team: String(b.meta?.team || "").slice(0, 80), agent: String(b.meta?.agent || "").slice(0, 40) };

  const keys = await keyOrder(cfg.settings);
  if (!keys.length) throw new HttpError(409, "No DeepSeek API key yet. Add one in Admin.");
  let last = "DeepSeek request failed";
  for (const k of keys) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = new Date();
      let r: Response, d: any = null;
      try {
        r = await fetch(`${DEEPSEEK}/chat/completions`, { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${k.key}` }, body: JSON.stringify(body) });
        d = await r.json().catch(() => null);
      } catch (e) {
        last = `Can't reach DeepSeek (${(e as Error).message})`;
        await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt));
        continue;
      }
      const u = d?.usage || {};
      const row = { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0, cache_hit: u.prompt_cache_hit_tokens || 0,
        cache_miss: u.prompt_cache_miss_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0 };
      await sb.from("usage").insert({ ts: t0.toISOString(), key_id: k.id, model, ...meta, ok: r.ok, status: r.status, ...row,
        cost: r.ok ? cost(model, row, t0) : 0, ms: Date.now() - t0.getTime(), error: r.ok ? "" : String(d?.error?.message || "").slice(0, 200) });
      if (r.ok) {
        if (k.status !== "ok") await sb.from("api_keys").update({ status: "ok" }).eq("id", k.id);
        if (k.id !== cfg.settings.activeKey) await saveSettings(cfg, { activeKey: k.id });
        const m = d?.choices?.[0]?.message || {};
        const out: any = { role: "assistant", content: m.content || "" };
        if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
        if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
        return out;
      }
      last = `DeepSeek ${r.status}: ${d?.error?.message || "request failed"}`;
      if (r.status === 401 || r.status === 402) {
        await sb.from("api_keys").update({ status: r.status === 401 ? "invalid" : "no-balance" }).eq("id", k.id);
        break;
      }
      if (![429, 500, 502, 503, 504].includes(r.status)) throw new HttpError(502, last);
      await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt));
    }
  }
  throw new HttpError(502, last);
}

async function saveSettings(cfg: any, patch: any) {
  const s = { ...cfg.settings, ...patch };
  await sb.from("app_config").update({ settings: s, updated_at: new Date().toISOString() }).eq("id", 1);
  cfg.settings = s;
  return s;
}
function cleanSettings(p: any) {
  const out: any = {};
  if (["brief", "balanced", "detailed"].includes(p.talk)) out.talk = p.talk;
  if (typeof p.fallback === "boolean") out.fallback = p.fallback;
  if (p.models && typeof p.models === "object") {
    out.models = {};
    for (const k of ["work", "friends"]) if (PRICES[p.models[k]]) out.models[k] = p.models[k];
  }
  return out;
}

// ------------------------------------------------------------------ skills
const publicSkill = (k: any) => ({ id: k.id, name: k.name, description: k.description, body: k.body,
  source: k.source_repo ? { repo: k.source_repo, ref: k.source_ref, path: k.source_path } : null,
  hasScripts: k.has_scripts, updatedAt: k.updated_at });
function cleanSkill(b: any) {
  const p = parseSkillMd(`---\nname: ${String(b.name || "").replace(/\n/g, " ")}\n---\n`, "skill");
  return { name: p.name, description: String(b.description || "").replace(/\s+/g, " ").trim().slice(0, 1024),
    body: String(b.body || "").trim().slice(0, 60_000) };
}
async function insertSkill(row: any) {
  // Names are unique: "brainstorm", then "brainstorm-2", ...
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? row.name : `${row.name}-${n}`;
    const { data, error } = await sb.from("skills").insert({ ...row, name }).select().single();
    if (!error) return data;
    if (error.code !== "23505" || /source_repo/.test(error.message)) throw new HttpError(400, error.message);
  }
  throw new HttpError(400, "Too many skills with that name.");
}

// ------------------------------------------------------------------ routes
async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/musab/, "") || "/";
  const m = req.method;

  if (m === "POST" && path === "/login") {
    const { username = "", password = "" } = await req.json().catch(() => ({}));
    const cfg = await config();
    if (cfg.locked_until && new Date(cfg.locked_until) > new Date())
      throw new HttpError(429, "Too many wrong passwords. Try again in a few minutes.");
    const { data: ok } = await sb.rpc("check_password", { p: String(password) });
    if (String(username).trim().toLowerCase() !== cfg.username || !ok) {
      const fails = cfg.failed_logins + 1;
      await sb.from("app_config").update(fails >= MAX_FAILS
        ? { failed_logins: 0, locked_until: new Date(Date.now() + LOCK_MIN * 60e3).toISOString() }
        : { failed_logins: fails }).eq("id", 1);
      throw new HttpError(401, "Wrong username or password.");
    }
    if (cfg.failed_logins) await sb.from("app_config").update({ failed_logins: 0 }).eq("id", 1);
    return json(req, 200, { token: await issue(cfg), mustChange: cfg.must_change, username: cfg.username });
  }

  const cfg = await requireSession(req);
  // Until the default admin/admin is changed, the only thing a session can do is change it.
  if (cfg.must_change && !(path === "/login/change" || (m === "GET" && (path === "/me" || path === "/admin"))))
    throw new HttpError(403, "Change the default password first.");

  if (m === "POST" && path === "/chat") return json(req, 200, await chat(req, cfg));
  if (m === "GET" && path === "/me") return json(req, 200, { username: cfg.username, mustChange: cfg.must_change, settings: cfg.settings });

  if (m === "POST" && path === "/login/change") {
    const { username = "", password = "" } = await req.json();
    if (!/^[a-zA-Z0-9._@-]{3,40}$/.test(username)) throw new HttpError(400, "Username: 3 to 40 letters, numbers, . _ @ or -");
    if (String(password).length < 8) throw new HttpError(400, "Use at least 8 characters for the password.");
    if (password === "admin") throw new HttpError(400, "Pick a password other than the default.");
    await sb.rpc("set_login", { u: username, p: password });
    const fresh = await config(); // token_version bumped: other devices sign in again
    return json(req, 200, { token: await issue(fresh), username: fresh.username });
  }

  if (m === "GET" && path === "/admin") {
    const { data } = await sb.from("api_keys").select("*").order("created_at");
    return json(req, 200, { username: cfg.username, mustChange: cfg.must_change, settings: cfg.settings,
      keys: (data || []).map(publicKey), githubToken: !!cfg.github_token });
  }
  if (m === "POST" && path === "/github-token") {
    const { token = "" } = await req.json();
    const t = String(token).trim();
    if (t && !/^[\w-]{20,255}$/.test(t)) throw new HttpError(400, "That doesn't look like a GitHub token.");
    await sb.from("app_config").update({ github_token: t || null }).eq("id", 1);
    return json(req, 200, { githubToken: !!t });
  }

  // ---------------------------------------------------------------- skills
  if (path === "/skills" && m === "GET") {
    const { data } = await sb.from("skills").select("*").order("name");
    return json(req, 200, (data || []).map(publicSkill));
  }
  if (path === "/skills" && m === "POST") { // write your own
    const b = await req.json();
    const s = cleanSkill(b);
    if (!s.body) throw new HttpError(400, "Write the skill's instructions.");
    return json(req, 200, publicSkill(await insertSkill(s)));
  }
  if (path === "/skills/discover" && m === "POST") {
    const { url = "" } = await req.json();
    try { return json(req, 200, await discover(String(url), { token: cfg.github_token || undefined })); }
    catch (e) { if (e instanceof GitHubError) throw new HttpError(400, e.message); throw e; }
  }
  if (path === "/skills/import" && m === "POST") {
    const { repo = "", ref = "main", paths = [], scripts = [] } = await req.json();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Array.isArray(paths) || !paths.length) throw new HttpError(400, "Nothing to import.");
    const out: any[] = [], errors: string[] = [];
    for (const pth of paths.slice(0, 150)) {
      try {
        const s = await fetchSkill(repo, String(ref), String(pth), { token: cfg.github_token || undefined });
        const { data: existing } = await sb.from("skills").select("id").eq("source_repo", repo).eq("source_path", pth).maybeSingle();
        const row = { ...s, source_repo: repo, source_ref: String(ref), source_path: String(pth), has_scripts: Array.isArray(scripts) && scripts.includes(pth), updated_at: new Date().toISOString() };
        if (existing) {
          const { data } = await sb.from("skills").update({ description: row.description, body: row.body, source_ref: row.source_ref, updated_at: row.updated_at }).eq("id", existing.id).select().single();
          out.push(publicSkill(data));
        } else out.push(publicSkill(await insertSkill(row)));
      } catch (e) { errors.push(`${pth}: ${(e as Error).message}`); }
    }
    return json(req, 200, { imported: out, errors });
  }
  if (path === "/skills/update" && m === "POST") { // pull the latest version of every imported skill
    const { data } = await sb.from("skills").select("*").not("source_repo", "is", null);
    let updated = 0; const errors: string[] = [];
    for (const k of data || []) {
      try {
        const s = await fetchSkill(k.source_repo, k.source_ref || "main", k.source_path, { token: cfg.github_token || undefined });
        if (s.body !== k.body || s.description !== k.description) {
          await sb.from("skills").update({ body: s.body, description: s.description, updated_at: new Date().toISOString() }).eq("id", k.id);
          updated++;
        }
      } catch (e) { errors.push(`${k.name}: ${(e as Error).message}`); }
    }
    return json(req, 200, { checked: (data || []).length, updated, errors });
  }
  const sm = path.match(/^\/skills\/([0-9a-f-]{36})$/);
  if (sm) {
    if (m === "DELETE") { await sb.from("skills").delete().eq("id", sm[1]); return json(req, 200, { deleted: sm[1] }); }
    if (m === "POST") {
      const s = cleanSkill(await req.json());
      const { data, error } = await sb.from("skills").update({ ...s, updated_at: new Date().toISOString() }).eq("id", sm[1]).select().single();
      if (error) throw new HttpError(400, error.code === "23505" ? "Another skill already has that name." : error.message);
      return json(req, 200, publicSkill(data));
    }
  }
  if (m === "POST" && path === "/settings") {
    return json(req, 200, await saveSettings(cfg, cleanSettings(await req.json())));
  }
  if (m === "POST" && path === "/keys") {
    const { label = "", key = "" } = await req.json();
    const k = String(key).trim();
    if (!/^sk-[\w-]{8,}$/.test(k)) throw new HttpError(400, "That doesn't look like a DeepSeek key (it starts with sk-).");
    const b = await balance(k);
    const { count } = await sb.from("api_keys").select("id", { count: "exact", head: true });
    const { data, error } = await sb.from("api_keys").insert({ label: String(label).trim().slice(0, 40) || `Key ${(count || 0) + 1}`,
      key: k, balance: b, status: b.available ? "ok" : "no-balance" }).select().single();
    if (error) throw new HttpError(400, error.code === "23505" ? "This key is already saved." : error.message);
    if (!count) await saveSettings(cfg, { activeKey: data.id });
    return json(req, 200, publicKey(data));
  }
  const km = path.match(/^\/keys\/([0-9a-f-]{36})(\/check|\/activate)?$/);
  if (km) {
    const { data: k } = await sb.from("api_keys").select("*").eq("id", km[1]).single();
    if (!k) throw new HttpError(404, "Key not found");
    if (m === "DELETE" && !km[2]) {
      await sb.from("api_keys").delete().eq("id", k.id);
      if (cfg.settings.activeKey === k.id) await saveSettings(cfg, { activeKey: null });
      return json(req, 200, { deleted: k.id });
    }
    if (m === "POST" && km[2] === "/activate") { await saveSettings(cfg, { activeKey: k.id }); return json(req, 200, { active: k.id }); }
    if (m === "POST" && km[2] === "/check") {
      try {
        const b = await balance(k.key);
        await sb.from("api_keys").update({ balance: b, status: b.available ? "ok" : "no-balance" }).eq("id", k.id);
        return json(req, 200, { ...publicKey(k), balance: b, status: b.available ? "ok" : "no-balance" });
      } catch (e) {
        if (e instanceof HttpError && e.status === 400) await sb.from("api_keys").update({ status: "invalid" }).eq("id", k.id);
        throw e;
      }
    }
  }
  if (path === "/usage") {
    if (m === "DELETE") { await sb.from("usage").delete().gte("id", 0); return json(req, 200, { cleared: true }); }
    const since = new Date(Number(url.searchParams.get("since") || 0)).toISOString();
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) { // page through, newest data volumes stay small for one person
      const { data } = await sb.from("usage").select("ts,key_id,model,team,agent,ok,status,prompt,completion,cost")
        .gte("ts", since).order("id").range(from, from + 999);
      rows.push(...(data || []));
      if (!data || data.length < 1000 || rows.length >= 50000) break;
    }
    return json(req, 200, rows.map((r) => ({ ts: Date.parse(r.ts), keyId: r.key_id, model: r.model, team: r.team, agent: r.agent,
      ok: r.ok, status: r.status, prompt: r.prompt, completion: r.completion, cost: Number(r.cost) })));
  }
  throw new HttpError(404, "not found");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  try {
    return await route(req);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return json(req, status, { error: status === 500 ? "server error" : (e as Error).message });
  }
});
