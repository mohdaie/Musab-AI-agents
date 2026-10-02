/* End-to-end test of the web app in a real browser, with DeepSeek faked.
   Serves musab/web under /Musab-AI-agents/ (like GitHub Pages) and clicks through:
   admin login, API keys, creating a team, chatting, usage, key fallback, persistence.

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

// ---------------------------------------------------------------- fake DeepSeek
const calls = [];
const GOOD = "sk-good0000000000000000", EMPTY = "sk-empty000000000000000", BAD = "sk-bad00000000000000000";
function deepseek(route) {
  const req = route.request();
  const key = (req.headers().authorization || "").replace("Bearer ", "");
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type",
    "content-type": "application/json" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "" });
  const json = (status, body) => route.fulfill({ status, headers: cors, body: JSON.stringify(body) });
  if (req.url().endsWith("/user/balance")) {
    if (key === BAD) return json(401, { error: { message: "Authentication Fails" } });
    return json(200, { is_available: key !== EMPTY, balance_infos: [{ currency: "USD", total_balance: key === EMPTY ? "0.00" : "9.50" }] });
  }
  if (key === EMPTY) return json(402, { error: { message: "Insufficient Balance" } });
  if (key !== GOOD) return json(401, { error: { message: "Authentication Fails" } });
  const body = JSON.parse(req.postData());
  const name = /You are (\w+),/.exec(body.messages[0].content)[1];
  calls.push({ name, body });
  const last = body.messages[body.messages.length - 1];
  const usage = { prompt_tokens: 1200, completion_tokens: 300, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 1000 };
  const msg = (m) => json(200, { choices: [{ message: m }], usage });
  // jess saves a memory first (tool call), then answers
  if (name === "jess" && last.role === "user" && /dinner/.test(last.content)) {
    return msg({ content: "", reasoning_content: "thinking", tool_calls: [{ id: "c1", type: "function",
      function: { name: "remember", arguments: JSON.stringify({ content: "User wants dinner ideas", shared: true }) } }] });
  }
  if (name === "jess") return msg({ content: "Ramen at Jalan Alor! @amir you coming?" });
  if (name === "amir") return msg({ content: last.content.includes("hop 1") ? "Only if there's pineapple pizza after 🍍" : "PASS" });
  return msg({ content: "PASS" });
}

// ---------------------------------------------------------------- run
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ ...pw.devices["Pixel 7"] });
await ctx.route("https://api.deepseek.com/**", deepseek);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// 401/402 from the fake API are expected (bad key, empty key); anything else is a bug.
page.on("console", (m) => m.type() === "error" && !/status of 40[12]/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
const shot = async (n) => SHOTS && page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const text = () => page.locator("body").innerText();

try {
  await page.goto(APP);
  await page.waitForSelector(".hero");
  check(await page.locator("#banner").isVisible(), "banner asks for an API key");
  await shot("01-home-empty");

  // admin login
  await page.click("text=Admin: API keys and usage");
  await page.fill("#adm-user", "admin"); await page.fill("#adm-pass", "nope"); await page.click("text=Sign in");
  check(await page.locator(".error").isVisible(), "wrong password is rejected");
  await page.fill("#adm-pass", "admin"); await page.click("text=Sign in");
  await page.waitForSelector("text=Change the default login");
  check(true, "admin / admin signs in and asks to change the default");

  // keys: bad, empty-balance, good
  await page.fill("#key-value", BAD); await page.click("text=Save key");
  await page.waitForSelector("text=DeepSeek says this key is invalid");
  check(true, "invalid key is refused");
  await page.fill("#key-label", "Empty"); await page.fill("#key-value", EMPTY); await page.click("text=Save key");
  await page.waitForSelector(".key-row");
  await page.fill("#key-label", "Main"); await page.fill("#key-value", GOOD); await page.click("text=Save key");
  await page.waitForFunction(() => document.querySelectorAll(".key-row").length === 2);
  check((await text()).includes("$9.50") && (await text()).includes("No balance"), "balances and status shown per key");
  await shot("02-admin-keys");

  // create a friends team
  await page.click("[aria-label=Back]");
  await page.click("text=Create a team");
  await page.click("button.choice >> nth=1");
  await page.fill("#team-name", "The Squad");
  await page.click("text=Next");
  await page.click("text=Fill with examples");
  await page.click("text=Create team");
  await page.waitForSelector(".chat");
  check(page.url().includes("#/team/the-squad"), "team saved and chat opened");

  // chat: active key is "Empty" (first added) -> 402 -> falls back to "Main"
  await page.fill("textarea", "Where should we go for dinner tonight?");
  await page.click("button.send");
  await page.waitForSelector("text=Only if there's pineapple pizza after", { timeout: 15000 });
  const t = await text();
  check(t.includes("Ramen at Jalan Alor"), "jess replied after using the remember tool");
  check(t.includes("→ @amir"), "agent-to-agent message is labelled");
  check(!t.includes("couldn't reply"), "no agent errors");
  const emptyHits = calls.length; // only GOOD-key calls are recorded in `calls`
  check(emptyHits > 0, "fell back from the empty key to the working key");
  check(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("musab.settings")); const k = JSON.parse(localStorage.getItem("musab.keys")); return k.find((x) => x.id === s.activeKey)?.label; }) === "Main",
    "the working key became the active key");
  const jessFollowUp = calls.find((c) => c.name === "jess" && c.body.messages.some((m) => m.role === "tool"));
  check(jessFollowUp?.body.messages.some((m) => m.reasoning_content === "thinking"), "reasoning_content is sent back with tool results");
  check(calls[0].body.messages[0].content.includes("group of friends"), "friends prompt used");
  await shot("03-chat");

  // persistence
  await page.reload();
  await page.waitForSelector("text=Ramen at Jalan Alor");
  check(true, "chat survives a reload");

  // usage in admin
  await page.goto(APP + "#/admin");
  await page.waitForSelector(".stats");
  const stats = await page.locator(".stat-value").allInnerTexts();
  check(Number(stats[0]) >= 4, `usage counts requests (${stats[0]})`);
  check((await text()).includes("Removed key") === false && (await text()).includes("By API key"), "usage table by key");
  check(await page.locator(".bar-fill[style*='height:']").count() === 14, "14-day chart drawn");
  check(!(await text()).includes("null"), "no stray 'null' text");
  await page.locator(".bar").last().hover();
  check(await page.locator(".chart-tip").isVisible(), "chart tooltip on hover");
  await shot("04-admin-usage");

  // change login, sign out, sign in again
  await page.fill("#new-user", "musab"); await page.fill("#new-pass", "s3cret-pass"); await page.fill("#new-pass2", "s3cret-pass");
  await page.click("text=Change login");
  await page.waitForSelector("h2:text-is('Admin login')");
  await page.click("text=Sign out");
  await page.goto(APP + "#/admin");
  await page.fill("#adm-user", "admin"); await page.fill("#adm-pass", "admin"); await page.click("text=Sign in");
  await page.waitForSelector("text=Wrong username or password.");
  check(true, "old default login no longer works");
  await page.fill("#adm-user", "musab"); await page.fill("#adm-pass", "s3cret-pass"); await page.click("text=Sign in");
  await page.waitForSelector("text=API keys");
  check(true, "new login works");

  // dark mode screenshot of admin
  if (SHOTS) {
    await page.emulateMedia({ colorScheme: "dark" });
    await shot("05-admin-dark");
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
