/* Unit tests for supabase/functions/musab/threads.ts (Threads API) with a fake Graph API.
   Run: node --experimental-strip-types tests/server/threads.test.mjs */
import assert from "node:assert/strict";
const T = await import("../../supabase/functions/musab/threads.ts");

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };

// A fake graph.threads.net: tokens, keyword search, containers and publishing (with one "not ready" on demand).
let sent = [], notReady = 0, failOnPost = 0, published = 0;
function fake(url, init = {}) {
  const u = new URL(url);
  const p = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(u.searchParams);
  sent.push({ method: init.method || "GET", path: u.pathname, p });
  const json = (status, d) => Promise.resolve(new Response(JSON.stringify(d), { status }));
  const err = (code, message, status = 400) => json(status, { error: { message, type: "OAuthException", code } });
  if (u.pathname === "/oauth/access_token") return p.code === "good" ? json(200, { access_token: "SHORT", user_id: 42 }) : json(400, { error_message: "Matching code was not found or was already used" });
  if (u.pathname === "/access_token") return p.access_token === "SHORT" ? json(200, { access_token: "LONG", expires_in: 5184000 }) : err(190, "Invalid OAuth access token");
  if (u.pathname === "/refresh_access_token") return json(200, { access_token: "LONG2", expires_in: 5184000 });
  if (p.access_token === "dead") return err(190, "Error validating access token: Session has expired");
  if (u.pathname === "/v1.0/me") return json(200, { id: "42", username: "musab" });
  if (u.pathname === "/v1.0/keyword_search") return json(200, { data: [
    { id: "1", text: "Budget  tips\nfor 2026", media_type: "TEXT", permalink: "https://www.threads.com/@a/post/1", timestamp: "2026-09-30T10:00:00+0000", username: "a" }] });
  if (u.pathname === "/v1.0/42/threads") return json(200, { id: `c${sent.length}` });
  if (u.pathname === "/v1.0/42/threads_publish") {
    if (notReady > 0) { notReady--; return err(24, "The media is not ready to be published. Please wait a moment."); }
    if (failOnPost && published + 1 === failOnPost) return err(100, "Duplicate post");
    published++;
    return json(200, { id: `m${published}` });
  }
  if (/^\/v1\.0\/m\d+$/.test(u.pathname)) return json(200, { permalink: `https://www.threads.com/@musab/post/${u.pathname.slice(6)}` });
  return json(404, { error: { message: "unknown" } });
}
const reset = () => { sent = []; notReady = 0; failOnPost = 0; published = 0; };
const noWait = () => Promise.resolve();

await test("length: plain text counts characters, emojis count their bytes", () => {
  assert.equal(T.threadsLength("hello"), 5);
  assert.equal(T.threadsLength("é"), 1);
  assert.equal(T.threadsLength("🔥"), 4);
  assert.equal(T.threadsLength("hi 👍🏽"), 3 + new TextEncoder().encode("👍🏽").length);
});
await test("authUrl: app id, redirect, scopes, state", () => {
  const u = new URL(T.authUrl("123456", "https://x.supabase.co/functions/v1/musab/threads/callback", "abc.def"));
  assert.equal(u.origin + u.pathname, "https://threads.com/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "123456");
  assert.equal(u.searchParams.get("scope"), "threads_basic,threads_content_publish,threads_keyword_search");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("state"), "abc.def");
});
await test("exchangeCode: code -> short -> long token -> account", async () => {
  reset();
  const t = await T.exchangeCode(fake, { appId: "123456", secret: "s3cret", redirectUri: "https://r/cb", code: "good" });
  assert.equal(t.token, "LONG"); assert.equal(t.userId, "42"); assert.equal(t.username, "musab");
  assert.ok(t.expiresAt > Date.now() + 59 * 864e5);
  assert.deepEqual(sent[0], { method: "POST", path: "/oauth/access_token",
    p: { client_id: "123456", client_secret: "s3cret", grant_type: "authorization_code", redirect_uri: "https://r/cb", code: "good" } });
  assert.equal(sent[1].p.grant_type, "th_exchange_token");
  await assert.rejects(T.exchangeCode(fake, { appId: "1", secret: "s", redirectUri: "r", code: "used" }), /Matching code/);
});
await test("refresh: new 60-day token", async () => {
  const r = await T.refresh(fake, "LONG");
  assert.equal(r.token, "LONG2");
});
await test("search: keyword/tag, top/recent, fields, cleaned results", async () => {
  reset();
  const r = await T.search(fake, "LONG", "  #budget tips ", { recent: true });
  assert.equal(sent[0].p.q, "budget tips");
  assert.equal(sent[0].p.search_type, "RECENT");
  assert.equal(sent[0].p.search_mode, "KEYWORD");
  assert.equal(sent[0].p.limit, "15");
  assert.match(sent[0].p.fields, /permalink/);
  assert.deepEqual(r[0], { username: "a", text: "Budget tips for 2026", permalink: "https://www.threads.com/@a/post/1", timestamp: "2026-09-30T10:00:00+0000", mediaType: "TEXT" });
  await T.search(fake, "LONG", "budget", { tag: true });
  assert.equal(sent[1].p.search_mode, "TAG"); assert.equal(sent[1].p.search_type, "TOP");
  await assert.rejects(T.search(fake, "LONG", "  "), /Empty search/);
});
await test("checkPosts: empty, too many, too long", () => {
  assert.throws(() => T.checkPosts([]), /Nothing to post/);
  assert.throws(() => T.checkPosts(["a", " "]), /Post 2 is empty/);
  assert.throws(() => T.checkPosts(Array(11).fill("x")), /up to 10/);
  assert.throws(() => T.checkPosts(["x".repeat(499) + "🔥"]), /Post 1 is 503 characters/);
  assert.deepEqual(T.checkPosts(["  hi  "]), ["hi"]);
});
await test("publish: single post, then permalink", async () => {
  reset();
  const r = await T.publish(fake, "LONG", "42", ["Hello Threads"], { wait: noWait });
  assert.deepEqual(r, { ids: ["m1"], permalink: "https://www.threads.com/@musab/post/m1", error: "" });
  assert.deepEqual(sent[0].p, { media_type: "TEXT", text: "Hello Threads", access_token: "LONG" });
  assert.equal(sent[1].path, "/v1.0/42/threads_publish");
});
await test("publish: a thread chains each post under the previous one, retrying when not ready", async () => {
  reset(); notReady = 2;
  const r = await T.publish(fake, "LONG", "42", ["1/ hook", "2/ tip", "3/ ask"], { wait: noWait });
  assert.deepEqual(r.ids, ["m1", "m2", "m3"]);
  const creates = sent.filter((s) => s.path === "/v1.0/42/threads");
  assert.equal(creates[0].p.reply_to_id, undefined);
  assert.equal(creates[1].p.reply_to_id, "m1");
  assert.equal(creates[2].p.reply_to_id, "m2");
});
await test("publish: stops at a failure and says how many went out", async () => {
  reset(); failOnPost = 2;
  const r = await T.publish(fake, "LONG", "42", ["a", "b", "c"], { wait: noWait });
  assert.deepEqual(r.ids, ["m1"]);
  assert.match(r.error, /Posted 1 of 3; then: Duplicate post/);
});
await test("expired token is reported as expired", async () => {
  reset();
  await assert.rejects(T.publish(fake, "dead", "42", ["x"], { wait: noWait }), (e) => e.expired === true && /Reconnect in Admin/.test(e.message));
  await assert.rejects(T.search(fake, "dead", "x"), (e) => e.expired === true);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
