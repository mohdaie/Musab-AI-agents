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
  if (name === "zu") return msg({ content: "Check the System event log first." });
  return msg({ content: "PASS" });
}
const balanceOf = (key) => (key === BAD ? null : { available: key !== EMPTY, infos: [{ currency: "USD", total_balance: key === EMPTY ? "0.00" : "9.50" }], checked_at: Date.now() });

// ---------------------------------------------------------------- fake Musab server
const S = { username: "admin", password: "admin", mustChange: true, version: 1, keys: [], usage: [],
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
  if (path === "/me") return [200, { username: S.username, mustChange: S.mustChange, settings: S.settings }];
  if (path === "/admin") return [200, { username: S.username, mustChange: S.mustChange, settings: S.settings, keys: S.keys.map(pub) }];
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
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ ...pw.devices["Pixel 7"] });
await ctx.route("https://*.supabase.co/functions/v1/musab/**", fakeServer);
await ctx.route("https://api.deepseek.com/**", (r) => r.abort()); // the app must never call DeepSeek directly
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// 4xx answers from the fake server are expected in some steps (wrong password, bad key); anything else is a bug.
page.on("console", (m) => m.type() === "error" && !/status of 40[0-3]/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
const shot = async (n) => SHOTS && page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
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

  // @ mention picker
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

  // home list
  await page.goto(APP);
  await page.waitForSelector(".chat-row");
  check(await page.locator(".chat-row").count() === 2 && (await page.locator(".chat-row").first().innerText()).includes("IT Ops"), "chat list, newest first");
  await shot("06-home");

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

  // Brief, chosen in Admin: only the most relevant agent answers, no thinking, short replies
  await page.click(".talk-option:has-text('Brief')");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("musab.serverSettings")).talk === "brief");

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
  check(calls.length === 1 && calls[0].name === "amir", `Brief: only the most relevant agent answers (${calls.map((c) => c.name)})`);
  check(calls[0]?.body.thinking.type === "disabled" && calls[0]?.body.max_tokens === 400 && calls[0]?.body.messages[0].content.includes("1-2 short sentences"),
    "Brief: no thinking, capped and short");

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
