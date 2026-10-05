/* End-to-end test of the web app in a real browser. The Musab server (Supabase function) and DeepSeek
   are both faked in memory with the same API and rules as supabase/functions/musab/index.ts.
   Serves musab/web under /Musab-AI-agents/ (like GitHub Pages) and clicks through: forced password
   change, API keys, settings, creating teams, chatting, models per team type, usage, members.

   Run:  npm i -g playwright && node tests/web/e2e.mjs
   Screenshots: set SHOTS=/some/dir */
import { execSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch {
  pw = require(join(execSync("npm root -g").toString().trim(), "playwright"));
}
const ROOT = resolve(new URL("../../musab/web", import.meta.url).pathname);
const BASE = "/Musab-AI-agents/";
const SHOTS = process.env.SHOTS || "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith(BASE)) { res.writeHead(404); return res.end(); }
  let f = join(ROOT, url.pathname.slice(BASE.length) || "index.html");
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) f = join(ROOT, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" });
  createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const APP = `http://localhost:${server.address().port}${BASE}`;

// ---------------------------------------------------------------- fake DeepSeek (what the server relays to)
const calls = [];
const GOOD = "sk-good0000000000000000", EMPTY = "sk-empty000000000000000", BAD = "sk-bad00000000000000000";
function deepseek(key, body) {
  if (key === EMPTY) return [402, { error: { message: "Insufficient Balance" } }];
  if (key !== GOOD) return [401, { error: { message: "Authentication Fails" } }];
  const name = /You are (\w+),/.exec(body.messages[0].content)[1];
  calls.push({ name, body });
  const last = body.messages[body.messages.length - 1];
  const usage = { prompt_tokens: 1200, completion_tokens: 300, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 1000 };
  const msg = (m) => [200, { choices: [{ message: m }], usage }];
  // jess saves a memory first (tool call), then answers
  if (name === "jess" && last.role === "user" && /dinner/.test(last.content)) {
    return msg({ content: "", reasoning_content: "thinking", tool_calls: [{ id: "c1", type: "function",
      function: { name: "remember", arguments: JSON.stringify({ content: "User wants dinner ideas", shared: true }) } }] });
  }
  if (name === "jess") return msg({ content: "Ramen at Jalan Alor! @amir you coming?" });
  if (name === "amir") return msg({ content: last.content.includes("hop 1") ? "Only if there's pineapple pizza after 🍍" : "PASS" });
  if (name === "zu" && /postmortem/.test(last.content) && last.role === "user") {
    return msg({ content: "", tool_calls: [{ id: "s1", type: "function", function: { name: "use_skill", arguments: JSON.stringify({ name: "incident-postmortem" }) } }] });
  }
  if (name === "zu" && last.role === "tool" && /# Skill: incident-postmortem/.test(last.content)) return msg({ content: "Postmortem: timeline, root cause, actions." });
  if (name === "zu" && /compile/.test(last.content)) return msg({ content: "Checklist: 1. System event log" });
  // mike browses: search, then read the first result, then answer citing it
  if (name === "mike" && /latest/.test(last.content) && last.role === "user") {
    return msg({ content: "", tool_calls: [{ id: "w1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "kerberos hardening 2026" }) } }] });
  }
  if (name === "mike" && last.role === "tool" && /learn\.example\.com\/kb1/.test(last.content) && !/Page:/.test(last.content)) {
    return msg({ content: "", tool_calls: [{ id: "w2", type: "function", function: { name: "read_page", arguments: JSON.stringify({ url: "https://learn.example.com/kb1" }) } }] });
  }
  if (name === "mike" && last.role === "tool" && /Page: https:\/\/learn\.example\.com\/kb1/.test(last.content)) return msg({ content: "Per learn.example.com: enforce AES." });
  // charles tries to search forever: the 4th call hits the per-reply limit
  if (name === "charles" && /search a lot/.test(body.messages[1].content)) {
    const n = body.messages.filter((m) => m.role === "tool").length;
    if (n < 4) return msg({ content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: `q${n}` }) } }] });
    return msg({ content: "Done searching." });
  }
  // sofi (Threads on): searches Threads, drafts a too-long post, fixes it after the error, then answers
  if (name === "sofi" && last.role === "user" && /threads post/.test(last.content)) {
    return msg({ content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "threads_search", arguments: JSON.stringify({ query: "budget tips", recent: true }) } }] });
  }
  if (name === "sofi" && last.role === "tool" && /@budgetguru/.test(last.content)) {
    return msg({ content: "", tool_calls: [{ id: "t2", type: "function", function: { name: "threads_draft", arguments: JSON.stringify({ posts: ["x".repeat(600)] }) } }] });
  }
  if (name === "sofi" && last.role === "tool" && /Draft not shown: Post 1 is 600 characters/.test(last.content)) {
    return msg({ content: "", tool_calls: [{ id: "t3", type: "function", function: { name: "threads_draft",
      arguments: JSON.stringify({ posts: ["1/ Save first, spend later 💸", "2/ Track every ringgit for 30 days."] }) } }] });
  }
  if (name === "sofi" && last.role === "tool" && /Post to Threads button/.test(last.content)) return msg({ content: "Draft is ready for you." });
  if (name === "zu") return msg({ content: "Check the System event log first." });
  if (name === "charles") return msg({ content: "PASS — nothing to add from the database side." });
  return msg({ content: "PASS" });
}
const balanceOf = (key) => (key === BAD ? null : { available: key !== EMPTY, infos: [{ currency: "USD", total_balance: key === EMPTY ? "0.00" : "9.50" }], checked_at: Date.now() });

// ---------------------------------------------------------------- fake Musab server
// fake GitHub repo seen by the fake server's /skills/discover
const REPO = { repo: "acme/skills", ref: "main", skills: [
  { path: "skills/postmortem/SKILL.md", name: "incident-postmortem", description: "Write a blameless post-incident report.", hasScripts: false,
    body: "1. Summary of impact\n2. Timeline\n3. Root cause\n4. Actions" },
  { path: "skills/pdf/SKILL.md", name: "pdf", description: "Work with PDF files.", hasScripts: true, body: "Run scripts/fill.py ..." },
] };
const S = { username: "admin", password: "admin", mustChange: true, version: 1, keys: [], usage: [], skills: [], githubToken: false, web: false, webCalls: [],
  threads: { appId: "", configured: false, connected: false, username: "" }, threadsCalls: [],
  settings: { talk: "balanced", models: { work: "deepseek-v4-pro", friends: "deepseek-flash" }, fallback: true, activeKey: null } };
const pub = (k) => ({ id: k.id, label: k.label, masked: `${k.key.slice(0, 3)}…${k.key.slice(-4)}`, status: k.status, balance: k.balance });
let nextId = 1;
function serverApi(method, path, auth, body) {
  if (method === "POST" && path === "/login") {
    if (body.username !== S.username || body.password !== S.password) return [401, { error: "Wrong username or password." }];
    return [200, { token: `t${S.version}`, mustChange: S.mustChange, username: S.username }];
  }
  if (auth !== `t${S.version}`) return [401, { error: "Sign in again" }];
  if (S.mustChange && !(path === "/login/change" || (method === "GET" && (path === "/me" || path === "/admin"))))
    return [403, { error: "Change the default password first." }];
  if (path === "/me") return [200, { username: S.username, mustChange: S.mustChange, settings: { ...S.settings, webSearch: S.web, threads: S.threads.connected, threadsUser: S.threads.username } }];
  if (path === "/admin") return [200, { username: S.username, mustChange: S.mustChange, settings: S.settings, keys: S.keys.map(pub), webSearch: S.web,
    threads: { ...S.threads, expiresAt: S.threads.connected ? Date.now() + 59 * 864e5 : 0, redirectUri: "https://x.supabase.co/functions/v1/musab/threads/callback" } }];
  if (path === "/login/change") {
    if (body.password.length < 8) return [400, { error: "Use at least 8 characters for the password." }];
    Object.assign(S, { username: body.username, password: body.password, mustChange: false, version: S.version + 1 });
    return [200, { token: `t${S.version}`, username: S.username }];
  }
  if (path === "/settings") { Object.assign(S.settings, body); return [200, S.settings]; }
  if (method === "POST" && path === "/keys") {
    const b = balanceOf(body.key);
    if (!b) return [400, { error: "DeepSeek says this key is invalid." }];
    const k = { id: `00000000-0000-0000-0000-00000000000${nextId++}`, label: body.label || `Key ${S.keys.length + 1}`, key: body.key, balance: b, status: b.available ? "ok" : "no-balance" };
    S.keys.push(k);
    if (S.keys.length === 1) S.settings.activeKey = k.id;
    return [200, pub(k)];
  }
  if (path === "/usage") return [200, S.usage];
  if (path === "/web-key") {
    if (body.key && !body.key.startsWith("tvly-")) return [400, { error: "That doesn't look like a Tavily key (it starts with tvly-)." }];
    S.web = !!body.key; return [200, { webSearch: S.web }];
  }
  if (path === "/web/search") { S.webCalls.push(["search", body.query, body.meta.agent]);
    return [200, { results: [{ title: "Kerberos hardening", url: "https://learn.example.com/kb1", content: "Enforce AES for Kerberos." }] }]; }
  if (path === "/web/read") { S.webCalls.push(["read", body.url, body.meta.agent]); return [200, { url: body.url, content: "# KB1\nEnforce AES." }]; }
  if (path === "/threads/app") {
    if (!/^\d{6,25}$/.test(body.appId)) return [400, { error: "The Threads app ID is a number (App settings → Basic → Threads app ID)." }];
    Object.assign(S.threads, { appId: body.appId, configured: true }); return [200, S.threads];
  }
  // The real server returns Meta's sign-in page; after the person allows it, Meta -> /threads/callback -> back here.
  if (path === "/threads/start") { Object.assign(S.threads, { connected: true, username: "musab.creates" }); return [200, { url: `${body.ret}#/admin/threads-ok` }]; }
  if (path === "/threads/search") { S.threadsCalls.push(["search", body.query, body.recent, body.meta.agent]);
    return [200, { ownOnly: false, results: [{ username: "budgetguru", text: "Pay yourself first: move 20% to savings on payday.",
      permalink: "https://www.threads.com/@budgetguru/post/1", timestamp: "2026-09-30T10:00:00+0000", mediaType: "TEXT" }] }]; }
  if (path === "/threads/publish") { S.threadsCalls.push(["publish", body.posts, body.meta.agent]);
    return [200, { ids: body.posts.map((_, i) => `m${i + 1}`), permalink: "https://www.threads.com/@musab.creates/post/abc", error: "" }]; }
  if (path === "/github-token") { S.githubToken = !!body.token; return [200, { githubToken: S.githubToken }]; }
  if (path === "/skills" && method === "GET") return [200, S.skills];
  if (path === "/skills" && method === "POST") {
    const k = { id: `10000000-0000-0000-0000-0000000000${String(nextId++).padStart(2, "0")}`, name: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: body.description, body: body.body, source: null, hasScripts: false };
    S.skills.push(k); return [200, k];
  }
  if (path === "/skills/discover") {
    if (!/github\.com\/acme\/skills/.test(body.url)) return [400, { error: "Repo not found." }];
    return [200, { repo: REPO.repo, ref: REPO.ref, total: REPO.skills.length, truncated: false,
      skills: REPO.skills.map(({ body: _b, ...k }) => k) }];
  }
  if (path === "/skills/import") {
    const imported = body.paths.map((pth) => {
      const f = REPO.skills.find((k) => k.path === pth);
      const k = { id: `10000000-0000-0000-0000-0000000000${String(nextId++).padStart(2, "0")}`, name: f.name, description: f.description, body: f.body,
        source: { repo: body.repo, ref: body.ref, path: pth }, hasScripts: body.scripts.includes(pth) };
      S.skills.push(k); return k;
    });
    return [200, { imported, errors: [] }];
  }
  const sk = path.match(/^\/skills\/([0-9a-f-]{36})$/);
  if (sk && method === "DELETE") { S.skills = S.skills.filter((k) => k.id !== sk[1]); return [200, { deleted: sk[1] }]; }
  if (path === "/chat") {
    const active = S.keys.find((k) => k.id === S.settings.activeKey) || S.keys[0];
    const bad = (k) => (k.status === "invalid" || k.status === "no-balance" ? 1 : 0);
    const order = [active, ...S.keys.filter((k) => k !== active)].sort((a, b) => bad(a) - bad(b));
    for (const k of order) {
      const req = { model: body.model, messages: body.messages, tools: body.tools,
        thinking: body.thinking === "off" ? { type: "disabled" } : { type: "enabled" } };
      if (body.max_tokens) req.max_tokens = body.max_tokens;
      const [st, d] = deepseek(k.key, req);
      S.usage.push({ ts: Date.now(), keyId: k.id, model: body.model, team: body.meta.team, agent: body.meta.agent, ok: st === 200, status: st,
        prompt: d.usage?.prompt_tokens || 0, completion: d.usage?.completion_tokens || 0, cost: st === 200 ? 0.0012 : 0 });
      if (st === 200) { S.settings.activeKey = k.id; k.status = "ok"; return [200, { role: "assistant", ...d.choices[0].message }]; }
      if (st === 402 || st === 401) { k.status = st === 401 ? "invalid" : "no-balance"; continue; }
    }
    return [502, { error: "DeepSeek request failed" }];
  }
  return [404, { error: "not found" }];
}
async function fakeServer(route) {
  const req = route.request();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "content-type": "application/json" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors, body: "" });
  const path = new URL(req.url()).pathname.replace(/^.*\/musab/, "");
  const auth = (req.headers().authorization || "").replace("Bearer ", "");
  const [status, data] = serverApi(req.method(), path, auth, req.postData() ? JSON.parse(req.postData()) : {});
  return route.fulfill({ status, headers: cors, body: JSON.stringify(data) });
}

// ---------------------------------------------------------------- run
// The folder picker can't be clicked through in a test: "picking" returns a folder in the origin-private file system.
const fakeFolderPicker = () => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
};
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ ...pw.devices["Pixel 7"], acceptDownloads: true });
await ctx.addInitScript(fakeFolderPicker);
await ctx.route("https://*.supabase.co/functions/v1/musab/**", fakeServer);
await ctx.route("https://api.deepseek.com/**", (r) => r.abort()); // the app must never call DeepSeek directly
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// 4xx answers from the fake server are expected in some steps (wrong password, bad key); anything else is a bug.
page.on("console", (m) => m.type() === "error" && !/status of 40[0-3]/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
const shot = async (n) => SHOTS && page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
// Phone-sized screenshot with `sel` scrolled to the top (only when SHOTS is set).
const ui = async (n, sel) => {
  if (!SHOTS) return;
  if (sel) await page.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${n}.png` });
};
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const text = () => page.locator("body").innerText();
const waitCalls = async (pred) => { for (let i = 0; i < 100 && !pred(); i++) await page.waitForTimeout(100); };

try {
  await page.goto(APP);
  await page.waitForSelector(".hero");
  check((await page.locator("#banner").innerText()).includes("Sign in to Admin"), "banner asks to sign in");
  await shot("01-home-empty");

  // admin: wrong password, then the default login must be changed before anything else
  await page.click("[aria-label=Admin]");
  await page.fill("#adm-user", "admin"); await page.fill("#adm-pass", "nope"); await page.click("button:has-text('Sign in')");
  await page.waitForSelector("text=Wrong username or password.");
  check(true, "wrong password is rejected");
  await page.fill("#adm-pass", "admin"); await page.click("button:has-text('Sign in')");
  await page.waitForSelector("text=Set your own login");
  check(await page.locator("#key-value").count() === 0, "default login: only the change-login form is shown");
  await shot("02-admin-default");
  await page.fill("#new-user", "musab"); await page.fill("#new-pass", "s3cret-pass"); await page.fill("#new-pass2", "s3cret-pass");
  await page.click("text=Save and continue");
  await page.waitForSelector("text=API keys");
  check(S.username === "musab" && !S.mustChange, "login changed on the server");

  // keys: bad, empty-balance, good
  await page.fill("#key-value", BAD); await page.click("text=Save key");
  await page.waitForSelector("text=DeepSeek says this key is invalid");
  check(true, "invalid key is refused");
  await page.fill("#key-label", "Empty"); await page.fill("#key-value", EMPTY); await page.click("text=Save key");
  await page.waitForSelector(".key-row");
  await page.fill("#key-label", "Main"); await page.fill("#key-value", GOOD); await page.click("text=Save key");
  await page.waitForFunction(() => document.querySelectorAll(".key-row").length === 2);
  check((await text()).includes("$9.50") && (await text()).includes("No balance"), "balances and status shown per key");
  check(!(await text()).includes(GOOD), "full key never shown");
  check(await page.locator("input[name=talk][value=balanced]").isChecked(), "talk level defaults to Balanced");
  check(await page.inputValue("#set-model-work") === "deepseek-v4-pro" && await page.inputValue("#set-model-friends") === "deepseek-flash",
    "defaults: Pro for engineer teams, Flash for friend groups");
  await page.click(".talk-option:has-text('Detailed')");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("musab.serverSettings")).talk === "detailed");
  check(S.settings.talk === "detailed", "talk level saved on the server");
  await shot("03-admin-keys");

  // create a friends team and chat
  await page.click("[aria-label=Back]");
  await page.click("text=Create a team");
  await page.click("button.choice >> nth=1");
  await page.fill("#team-name", "The Squad");
  await page.click("text=Next");
  await page.click("text=Fill with examples");
  check(await page.locator(".agent-card .level [aria-checked=true]").first().innerText() === "Detailed", "new agents start at the Admin default level");
  await page.click(".agent-card >> nth=2 >> .level button:has-text('Balanced')");
  await page.click("text=Create team");
  await page.waitForSelector(".chat");
  check(page.url().includes("#/team/the-squad"), "team saved and chat opened");
  await page.fill("textarea", "Where should we go for dinner tonight?");
  await page.click("button.send");
  await page.waitForSelector("text=Only if there's pineapple pizza after", { timeout: 15000 });
  const t = await text();
  check(t.includes("Ramen at Jalan Alor"), "jess replied after using the remember tool");
  check(t.includes("→ @amir"), "agent-to-agent message is labelled");
  check(!t.includes("couldn't reply"), "no agent errors");
  check(calls.length > 0 && calls.every((c) => c.body.model === "deepseek-flash"), "friend group uses Flash");
  check(S.keys.find((k) => k.id === S.settings.activeKey)?.label === "Main", "server fell back from the empty key to the working key");
  const jessFollowUp = calls.find((c) => c.name === "jess" && c.body.messages.some((m) => m.role === "tool"));
  check(jessFollowUp?.body.messages.some((m) => m.reasoning_content === "thinking"), "reasoning_content is sent back with tool results");
  check(calls[0].body.messages[0].content.includes("group of friends"), "friends prompt used");
  check(await page.locator(".msg.mine .ticks").count() > 0 && await page.locator(".day").count() === 1, "WhatsApp-style ticks and day label");
  await shot("04-chat");

  // @ mention picker (after the agents finish, so the screen isn't changing under the tap)
  await page.waitForFunction(() => !document.querySelector(".appbar .subtitle.typing"), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.fill("textarea", "");
  await page.type("textarea", "@ja");
  check(await page.locator(".mention-pop").isHidden(), "no picker when nobody matches");
  await page.fill("textarea", "");
  await page.type("textarea", "@je");
  await page.waitForSelector(".mention-item:has-text('jess')");
  await shot("05-mention");
  await page.click(".mention-item:has-text('jess')");
  check(await page.inputValue("textarea") === "@jess ", "picking a member inserts @name");
  await page.fill("textarea", "");

  // persistence
  await page.reload();
  await page.waitForSelector("text=Ramen at Jalan Alor");
  check(true, "chat survives a reload");

  // an engineer team uses Pro
  await page.goto(APP + "#/new");
  await page.fill("#team-name", "IT Ops");
  await page.click("text=Next");
  await page.click("text=Fill with examples");
  await page.click("text=Create team");
  await page.waitForSelector(".chat");
  calls.length = 0;
  await page.fill("textarea", "@zu the file server is slow");
  await page.click("button.send");
  await page.waitForSelector("text=Check the System event log first.");
  check(calls.length === 1 && calls[0].body.model === "deepseek-v4-pro", "engineer team uses Pro");
  // A new message is a new thread, but agents still see the recent chat
  calls.length = 0;
  await page.fill("textarea", "@zu @charles compile what was said into a checklist");
  await page.click("button.send");
  await page.waitForSelector("text=Checklist: 1. System event log");
  await waitCalls(() => calls.some((c) => c.name === "charles"));
  await page.waitForTimeout(800);
  const zuPrompt = calls.find((c) => c.name === "zu")?.body.messages[1].content || "";
  check(zuPrompt.includes("the file server is slow") && zuPrompt.includes("Check the System event log first."), "agents see the earlier chat, not just the new thread");
  check(!(await text()).includes("PASS"), "a reply starting with PASS is hidden");

  // ---- skills: discover a GitHub repo in Admin, add them, write one, give one to an agent
  await page.goto(APP + "#/admin");
  await page.waitForSelector("#skill-repo");
  await page.fill("#skill-repo", "https://github.com/nope/nothing");
  await page.click("button:has-text('Discover')");
  await page.waitForSelector("#skills .error:has-text('Repo not found')");
  check(true, "unknown repo shows an error");
  await page.fill("#skill-repo", "https://github.com/acme/skills");
  await page.click("button:has-text('Discover')");
  await page.waitForSelector("text=Found 2 skills");
  check(await page.locator(".discover-results .tag-warn:has-text('uses scripts')").count() === 1, "skills with scripts are flagged");
  await shot("09-skills-discover");
  await page.click("button:has-text('Add 2 skills')");
  await page.waitForSelector(".skill-row:has-text('incident-postmortem')");
  check(await page.locator(".skill-row").count() === 2 && (await page.locator(".skill-row").first().innerText()).includes("GitHub · acme/skills"), "discovered skills added with their source");
  await page.click("summary:has-text('Write your own skill')");
  await page.fill("#new-skill-name", "Brainstorming");
  await page.fill("#new-skill-desc", "Go wide, then pick 3.");
  await page.fill("#new-skill-body", "1. 10 wild ideas\n2. Pick the best 3");
  await page.click("button:has-text('Add skill')");
  await page.waitForSelector(".skill-row:has-text('brainstorming')");
  check(await page.locator(".skill-row").count() === 3, "own skill written");
  await shot("10-skills-list");

  await page.goto(APP + "#/team/it-ops");
  await page.waitForSelector(".chat");
  await page.click("[aria-label='Team info']");
  await page.click("[aria-label='Edit skills of zu']");
  await page.click(".skill-option:has-text('incident-postmortem') input");
  await page.click(".skill-pick button:has-text('Save')");
  await page.waitForSelector(".member-row:has-text('@zu') .skill-chip:has-text('incident-postmortem')");
  check(true, "skill given to an agent in the team sheet");
  await shot("11-agent-skills");
  await page.click(".sheet-body .close-sheet");
  calls.length = 0;
  await page.fill("textarea", "@zu @charles write the postmortem for the outage");
  await page.click("button.send");
  await page.waitForSelector("text=Postmortem: timeline, root cause, actions.");
  await waitCalls(() => calls.some((c) => c.name === "charles"));
  const zuFirst = calls.find((c) => c.name === "zu");
  check(zuFirst.body.messages[0].content.includes("- incident-postmortem: Write a blameless post-incident report.") &&
    zuFirst.body.tools.some((t) => t.function.name === "use_skill"), "agent sees its skills and gets the use_skill tool");
  const zuAfter = calls.filter((c) => c.name === "zu").pop();
  check(zuAfter.body.messages.some((m) => m.role === "tool" && m.content.includes("3. Root cause")), "use_skill returns the full instructions");
  check((await text()).includes("zu is using the skill “incident-postmortem”"), "chat shows when a skill is used");
  check(!calls.find((c) => c.name === "charles").body.tools.some((t) => t.function.name === "use_skill"), "agents without skills don't get the tool");

  // ---- web search: key in Admin, switch on per agent, agent searches + reads, limit per reply
  await page.click("[aria-label='Team info']");
  check(await page.locator(".member-row:has-text('@mike') .web-toggle input").isDisabled(), "web switch is off until web search is set up");
  check(await page.locator(".member-row:has-text('@mike') .threads-toggle input").isDisabled(), "Threads switch is off until Threads is connected");
  await page.goto(APP + "#/admin");
  await page.waitForSelector("#tavily-key");
  await page.fill("#tavily-key", "wrong-key");
  await page.click("#web button:has-text('Save')");
  await page.waitForSelector("#web .error:has-text('Tavily key')");
  await page.fill("#tavily-key", "tvly-test-key-123456");
  await page.click("#web button:has-text('Save')");
  await page.waitForSelector("#web .pill:has-text('On')");
  check(true, "Tavily key saved, web search on");
  await ui("7-web-admin", "#web");
  await page.click(".talk-option:has-text('Balanced')"); // saving a setting must keep web search on
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("musab.serverSettings")).talk === "balanced");
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("musab.serverSettings")).webSearch) === true, "saving settings keeps web search on");
  await page.goto(APP + "#/team/it-ops");
  await page.waitForSelector(".chat");
  await page.click("[aria-label='Team info']");
  for (const n of ["mike", "charles"]) {
    await page.click(`.member-row:has-text('@${n}') .web-toggle input`);
    await page.waitForFunction((n) => [...document.querySelectorAll(".member-row")].find((r) => r.textContent.includes("@" + n))?.querySelector(".web-toggle input").checked, n);
  }
  await ui("8-web-toggle", ".member-row:has-text('@mike')");
  await page.click(".sheet-body .close-sheet");
  calls.length = 0;
  await page.fill("textarea", "@mike what is the latest guidance?");
  await page.click("button.send");
  await page.waitForSelector("text=Per learn.example.com: enforce AES.");
  const mikeFirst = calls.find((c) => c.name === "mike");
  check(mikeFirst.body.tools.some((t) => t.function.name === "web_search") && mikeFirst.body.messages[0].content.includes("## Web access"), "browsing agent gets the web tools");
  check(S.webCalls.some(([k, v, a]) => k === "search" && v === "kerberos hardening 2026" && a === "mike") &&
    S.webCalls.some(([k, v]) => k === "read" && v === "https://learn.example.com/kb1"), "search and page read go through the server");
  const t2 = await text();
  check(t2.includes("mike searched the web: “kerberos hardening 2026”") && t2.includes("mike is reading learn.example.com"), "chat shows searches and pages read");
  await page.waitForTimeout(400);
  await ui("9-web-chat");
  calls.length = 0; S.webCalls.length = 0;
  await page.fill("textarea", "@charles search a lot please");
  await page.click("button.send");
  await page.waitForSelector("text=Done searching.");
  check(S.webCalls.length === 3, `at most 3 web calls per reply (${S.webCalls.length})`);
  const zuNow = calls.find((c) => c.name === "zu");
  check(!zuNow || !zuNow.body.tools.some((t) => t.function.name === "web_search"), "agents without web access don't get the tools");

  // ---- Threads: connect in Admin, switch on for a member, agent searches + drafts, edit the draft, post it
  await page.goto(APP + "#/admin");
  await page.waitForSelector("#threads .pill:has-text('Off')");
  check(await page.locator("#threads button:has-text('Connect Threads account')").isDisabled(), "Threads: connect waits for the app details");
  check((await page.locator("#threads .copy-row code").innerText()).endsWith("/musab/threads/callback"), "Threads: redirect URL shown to copy");
  await page.fill("#threads-app-id", "12ab");
  await page.fill("#threads-secret", "abcdef0123456789abcdef0123456789");
  await page.click("#threads button:has-text('Save')");
  await page.waitForSelector("#threads .error:has-text('Threads app ID is a number')");
  await page.fill("#threads-app-id", "1234567890123456");
  await page.click("#threads button:has-text('Save')");
  await page.waitForSelector("#threads .pill:has-text('Not connected')");
  await ui("12-threads-setup", "#threads");
  await page.click("#threads button:has-text('Connect Threads account')");
  await page.waitForSelector("#threads .pill.ok:text-is('Connected')");
  check((await text()).includes("Threads connected as @musab.creates") && page.url().endsWith("#/admin"), "Threads: back from sign-in, connected");
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("musab.serverSettings")).threads) === true, "Threads: agents can use it on this device");
  await ui("13-threads-connected", "#threads");

  await page.goto(APP + "#/team/it-ops");
  await page.waitForSelector(".chat");
  await page.click("[aria-label='Team info']");
  await page.waitForSelector("dialog[open] .member-row:has-text('@mike')");
  check(await page.locator(".member-row:has-text('@mike') .threads-toggle input").isEnabled(), "Threads switch is available once connected");
  await page.click("text=Add a member");
  await page.fill("#add-name", "sofi"); await page.fill("#add-role", "Threads writer"); await page.fill("#add-about", "Writes casual Threads posts.");
  await page.click(".add-member button[type=submit]");
  await page.waitForSelector("dialog[open] .member-row:has-text('@sofi')");
  await page.click(".member-row:has-text('@sofi') .threads-toggle input");
  await page.waitForFunction(() => [...document.querySelectorAll(".member-row")].find((r) => r.textContent.includes("@sofi"))?.querySelector(".threads-toggle input").checked);
  await page.click(".sheet-body .close-sheet");
  calls.length = 0;
  await page.fill("textarea", "@sofi write a threads post about budget tips");
  await page.click("button.send");
  await page.waitForSelector(".draft .draft-post >> nth=1");
  await page.waitForSelector("text=Draft is ready for you.");
  const sofiFirst = calls.find((c) => c.name === "sofi");
  check(sofiFirst.body.tools.some((t) => t.function.name === "threads_draft") && sofiFirst.body.messages[0].content.includes("## Threads"), "Threads agent gets the tools and instructions");
  check(S.threadsCalls.some(([k, q, recent, a]) => k === "search" && q === "budget tips" && recent === true && a === "sofi"), "Threads search goes through the server");
  check((await text()).includes("sofi searched Threads: “budget tips”"), "chat shows the Threads search");
  check(calls.filter((c) => c.name === "sofi").some((c) => c.body.messages.some((m) => m.role === "tool" && /Draft not shown: Post 1 is 600 characters/.test(m.content))),
    "a too-long draft is sent back to the agent to fix");
  check(await page.locator(".draft").count() === 1 && (await page.locator(".draft").innerText()).includes("2/2"), "only the valid draft shows, as a 2-post thread");
  check(!S.threadsCalls.some(([k]) => k === "publish"), "nothing is posted until the user taps Post");
  await ui("14-threads-draft", ".draft");
  await page.click(".draft button:has-text('Edit')");
  await page.fill("dialog[open] textarea >> nth=0", "1/ Pay yourself first 💸");
  await page.click("dialog[open] button:has-text('Save')");
  await page.waitForSelector(".draft-post:has-text('Pay yourself first')");
  check(true, "draft edited before posting");
  await page.click(".draft button:has-text('Post to Threads')");
  await page.waitForSelector(".draft-done:has-text('Posted to Threads')");
  const pub = S.threadsCalls.find(([k]) => k === "publish");
  check(JSON.stringify(pub?.[1]) === JSON.stringify(["1/ Pay yourself first 💸", "2/ Track every ringgit for 30 days."]) && pub[2] === "sofi", "the edited thread is posted");
  check(await page.locator(".draft-done a").getAttribute("href") === "https://www.threads.com/@musab.creates/post/abc", "link to the post");
  await page.reload();
  await page.waitForSelector(".draft-done:has-text('Posted to Threads')");
  check(await page.locator(".draft button:has-text('Post to Threads')").count() === 0, "posted state is saved");
  await ui("15-threads-posted", ".draft");
  const zuThreads = calls.find((c) => c.name === "zu");
  check(!zuThreads || !zuThreads.body.tools.some((t) => t.function.name === "threads_draft"), "agents without Threads don't get the tools");

  // home list
  await page.goto(APP);
  await page.waitForSelector(".chat-row");
  check(await page.locator(".chat-row").count() === 2 && (await page.locator(".chat-row").first().innerText()).includes("IT Ops"), "chat list, newest first");
  await page.click(".filters button:has-text('Friends')");
  check(await page.locator(".chat-row").count() === 1 && (await page.locator(".chat-row").innerText()).includes("The Squad"), "Friends filter");
  await page.click(".filters button:has-text('All')");
  await shot("06-home");

  // ---- backup: the "folder" the user picks is a folder in the origin-private file system (like Android Chrome)
  check(await page.locator(".backup-notice:has-text('only saved in this browser')").count() === 1, "home warns when there's no backup");
  await page.click("[aria-label=Backup]");
  await page.click("button:has-text('Choose folder')");
  await page.waitForSelector(".pill:has-text('Auto-saving')");
  const folderFiles = () => page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked");
    const out = {};
    for await (const [name, f] of d.entries()) out[name] = await (await f.getFile()).text();
    return out;
  });
  let files = await folderFiles();
  let saved = JSON.parse(files["musab-backup.json"] || "{}");
  check(saved.teams?.length === 2 && saved.messages.some((m) => m.content.includes("Ramen at Jalan Alor")) && saved.memories.length > 0,
    "choosing a folder saves teams, chats and memory there");
  check(Object.keys(files).some((n) => /^musab-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n)), "a dated daily copy is kept too");
  await ui("16-backup", ".content");
  await page.goto(APP + "#/team/the-squad");
  await page.fill("textarea", "@amir backup check");
  await page.click("button.send");
  await page.waitForTimeout(3500);
  saved = JSON.parse((await folderFiles())["musab-backup.json"]);
  check(saved.messages.some((m) => m.content === "backup check"), "a new message is saved to the folder automatically");
  await page.goto(APP);
  await page.waitForSelector(".chat-row");
  check(await page.locator(".backup-notice").count() === 0, "no backup warning once a folder is set");
  await page.click("[aria-label=Backup]");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Save file')")]);
  const backupFile = await dl.path();
  check(/^musab-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), `backup file download (${dl.suggestedFilename()})`);
  const backupText = (await import("node:fs")).readFileSync(backupFile, "utf8");

  // The browser wiped this device: a new phone with the same folder chosen again gets everything back.
  {
    const c2 = await browser.newContext({ ...pw.devices["Pixel 7"] });
    await c2.addInitScript(fakeFolderPicker);
    await c2.route("https://*.supabase.co/functions/v1/musab/**", fakeServer);
    const p2 = await c2.newPage();
    p2.on("pageerror", (e) => errors.push(String(e)));
    await p2.goto(APP);
    await p2.waitForSelector(".hero");
    await p2.evaluate(async (text) => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
      const w = await (await d.getFileHandle("musab-backup.json", { create: true })).createWritable();
      await w.write(text); await w.close();
    }, backupText);
    await p2.click("button:has-text('Restore from a backup')");
    await p2.click("button:has-text('Choose folder')");
    await p2.waitForSelector(".chat-row");
    check(await p2.locator(".chat-row").count() === 2, "empty device: choosing the folder restores every team");
    await p2.click(".chat-row:has-text('The Squad')");
    await p2.waitForSelector("text=Ramen at Jalan Alor");
    check(true, "restored chat history shows");
    await c2.close();
  }

  // iPhone / Firefox: no folder picker. An older version of the app (database v1) already has a team on this device.
  {
    const c3 = await browser.newContext({ ...pw.devices["Pixel 7"] });
    await c3.addInitScript(() => { window.showDirectoryPicker = undefined; });
    await c3.route("https://*.supabase.co/functions/v1/musab/**", fakeServer);
    await c3.route(`${APP}blank`, (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
    const p3 = await c3.newPage();
    p3.on("pageerror", (e) => errors.push(String(e)));
    p3.on("dialog", (d) => d.accept());
    await p3.goto(`${APP}blank`);
    await p3.evaluate(() => new Promise((resolve, reject) => {
      const r = indexedDB.open("musab", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("teams", { keyPath: "id" });
        const m = d.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        m.createIndex("team_id", ["team", "id"]); m.createIndex("thread", ["team", "thread_id", "id"]);
        d.createObjectStore("memories", { keyPath: "id", autoIncrement: true }).createIndex("team", "team");
        d.createObjectStore("usage", { keyPath: "id", autoIncrement: true }).createIndex("ts", "ts");
        r.transaction.objectStore("teams").put({ id: "old-team", name: "Old Team", style: "work", created_at: 1, agents: [{ name: "zu", role: "Admin" }] });
      };
      r.onsuccess = () => { r.result.close(); resolve(); };
      r.onerror = () => reject(r.error);
    }));
    await p3.goto(APP);
    await p3.waitForSelector(".chat-row:has-text('Old Team')");
    check(true, "teams from the older database version are kept after the update");
    await p3.click("[aria-label=Backup]");
    await p3.waitForSelector(".card:has-text('Backup file')");
    check((await p3.locator("body").innerText()).includes("can't save to a folder"), "no folder picker: the page says to save a backup file");
    await p3.setInputFiles("input[type=file]", backupFile);
    await p3.waitForSelector(".chat-row:has-text('The Squad')");
    check(await p3.locator(".chat-row").count() === 2, "restore from file replaces this device's teams");
    await p3.click("[aria-label=Backup]");
    await p3.setInputFiles("input[type=file]", { name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
    await p3.waitForSelector("#toast:has-text(\"isn't a Musab backup\")");
    check(true, "a file that isn't a backup is refused");
    await c3.close();
  }

  // usage in admin
  await page.goto(APP + "#/admin");
  await page.waitForSelector(".stats");
  const stats = await page.locator(".stat-value").allInnerTexts();
  check(Number(stats[0]) >= 4, `usage counts requests (${stats[0]})`);
  check((await text()).includes("By API key") && (await text()).includes("By model"), "usage tables by key and model");
  check(await page.locator(".bar-fill[style*='height:']").count() === 14, "14-day chart drawn");
  check(!(await text()).includes("null"), "no stray 'null' text");
  await page.locator(".bar").last().hover();
  check(await page.locator(".chart-tip").isVisible(), "chart tooltip on hover");

  // sign out, old login fails, new one works
  await page.click("[aria-label='Sign out']");
  await page.goto(APP + "#/admin");
  await page.fill("#adm-user", "admin"); await page.fill("#adm-pass", "admin"); await page.click("button:has-text('Sign in')");
  await page.waitForSelector("text=Wrong username or password.");
  check(true, "old default login no longer works");
  await page.fill("#adm-user", "musab"); await page.fill("#adm-pass", "s3cret-pass"); await page.click("button:has-text('Sign in')");
  await page.waitForSelector("text=API keys");
  check(true, "new login works");


  // manage the team: add a member, remove one, clear the chat, delete the team
  await page.goto(APP + "#/team/the-squad");
  await page.waitForSelector("text=Ramen at Jalan Alor");
  await page.click("[aria-label='Team info']");
  await page.click("text=Add a friend");
  await page.fill("#add-name", "Nina"); await page.fill("#add-role", "The artist"); await page.fill("#add-about", "Draws everything.");
  await page.click(".add-member button[type=submit]");
  await page.waitForSelector(".appbar .subtitle:has-text('nina')");
  check((await text()).includes("@nina (The artist) joined the group."), "member added, shown in header and chat");
  await page.waitForSelector("dialog[open] .sub:has-text('4 members')");
  check(true, "sheet reopens with 4 members");
  await shot("07-team-sheet");
  await page.click("[aria-label='Remove danny']");
  await page.waitForSelector("text=@danny left the group.");
  check(!(await page.locator(".appbar .subtitle").innerText()).includes("danny"), "member removed from the chat");
  await page.waitForSelector("dialog[open] .sub:has-text('3 members')");
  check(await page.locator(".member-row:has-text('@danny')").count() === 0 &&
    await page.locator(".member-row:has-text('@amir') .level [aria-checked=true]").innerText() === "Detailed", "members keep their own level");
  // Set every member to Light from the team sheet: only the most relevant answers, no thinking, short
  for (const n of ["amir", "jess", "nina"]) {
    await page.click(`.member-row:has-text('@${n}') .level button:has-text('Light')`);
    await page.waitForSelector(`.member-row:has-text('@${n}') .level [aria-checked=true]:has-text('Light')`);
  }
  await shot("07b-levels");
  await page.click(".sheet-body .close-sheet");
  calls.length = 0;
  await page.fill("textarea", "@nina hi!");
  await page.click("button.send");
  await waitCalls(() => calls.some((c) => c.name === "nina"));
  check(calls.some((c) => c.name === "nina") && calls[0].body.messages[0].content.includes("@jess"), "new member answers and knows the group");
  calls.length = 0;
  await page.fill("textarea", "Anyone up for football tonight?");
  await page.click("button.send");
  await waitCalls(() => calls.length);
  await page.waitForTimeout(1500);
  check(calls.length === 1 && calls[0].name === "amir", `Light: only the most relevant agent answers (${calls.map((c) => c.name)})`);
  check(calls[0]?.body.thinking.type === "disabled" && calls[0]?.body.max_tokens === 400 && calls[0]?.body.messages[0].content.includes("1-2 short sentences"),
    "Light: no thinking, capped and short");
  // Per agent: jess back to Detailed answers a group message even when she isn't the most relevant
  await page.click("[aria-label='Team info']");
  await page.click(".member-row:has-text('@jess') .level button:has-text('Detailed')");
  await page.waitForSelector(".member-row:has-text('@jess') .level [aria-checked=true]:has-text('Detailed')");
  await page.click(".sheet-body .close-sheet");
  calls.length = 0;
  await page.fill("textarea", "Anyone up for football tonight?");
  await page.click("button.send");
  await waitCalls(() => calls.length >= 2);
  await page.waitForTimeout(1500);
  check(new Set(calls.map((c) => c.name)).has("jess") && new Set(calls.map((c) => c.name)).has("amir") && !calls.some((c) => c.name === "nina"),
    `levels are per agent: Detailed jess and most-relevant amir answer, Light nina doesn't (${calls.map((c) => c.name)})`);
  check(calls.find((c) => c.name === "jess")?.body.thinking.type === "enabled" && !calls.find((c) => c.name === "jess")?.body.max_tokens, "Detailed agent thinks and isn't capped");

  await page.click("[aria-label='Team info']");
  await page.click(".sheet-body button:has-text('Clear chat')");
  await page.waitForSelector("text=Say hi to the group");
  check(!(await text()).includes("Ramen at Jalan Alor"), "chat cleared, team kept");
  await page.click("[aria-label='Team info']");
  await page.click(".sheet-body button:has-text('Delete team')");
  await page.waitForSelector(".chat-row");
  check(await page.locator(".chat-row").count() === 1, "team deleted");

  if (SHOTS) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(APP + "#/team/it-ops");
    await page.waitForSelector("text=Check the System event log first.");
    await shot("08-chat-dark");
  }
  check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors) : ""}`);
  check(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), "service worker registered");
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  await shot("error");
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
