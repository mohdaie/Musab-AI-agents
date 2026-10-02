/* Unit tests for supabase/functions/musab/web.ts (Tavily) with a fake service.
   Run: node --experimental-strip-types tests/server/web.test.mjs */
import assert from "node:assert/strict";
const { search, read, WebError, MAX_PAGE_CHARS } = await import("../../supabase/functions/musab/web.ts");

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const sent = [];
function fake(url, init) {
  const body = JSON.parse(init.body);
  sent.push({ url, auth: init.headers.Authorization, body });
  const json = (status, d) => Promise.resolve(new Response(JSON.stringify(d), { status }));
  if (init.headers.Authorization !== "Bearer tvly-good") return json(401, { detail: { error: "Unauthorized" } });
  if (url.endsWith("/search")) return json(200, { results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://ex.com/${i}`, content: "x ".repeat(1000), score: 0.9 })) });
  if (url.endsWith("/extract")) {
    if (body.urls[0].includes("broken")) return json(200, { results: [], failed_results: [{ url: body.urls[0], error: "blocked" }] });
    return json(200, { results: [{ url: body.urls[0], raw_content: "# Page\n" + "a".repeat(20000) }], failed_results: [] });
  }
  return json(404, {});
}

await test("search: request shape and trimmed results", async () => {
  const r = await search("tvly-good", "  event id 2019  ", fake);
  assert.equal(sent.at(-1).url, "https://api.tavily.com/search");
  assert.deepEqual(sent.at(-1).body, { query: "event id 2019", max_results: 5, search_depth: "basic" });
  assert.equal(r.length, 5);
  assert.ok(r[0].content.length <= 700 && r[0].url === "https://ex.com/0");
});
await test("read: markdown page, trimmed", async () => {
  const p = await read("tvly-good", "https://learn.microsoft.com/x", fake);
  assert.deepEqual(sent.at(-1).body, { urls: ["https://learn.microsoft.com/x"], extract_depth: "basic", format: "markdown" });
  assert.ok(p.content.startsWith("# Page") && p.content.endsWith("[...page trimmed]") && p.content.length < MAX_PAGE_CHARS + 50);
});
await test("errors: bad key, bad address, failed page, empty query", async () => {
  await assert.rejects(search("tvly-bad", "x", fake), /Tavily key was rejected/);
  await assert.rejects(read("tvly-good", "file:///etc/passwd", fake), /Only http and https/);
  await assert.rejects(read("tvly-good", "not a url", fake), /isn't a web address/);
  await assert.rejects(read("tvly-good", "https://broken.example", fake), /blocked/);
  await assert.rejects(search("tvly-good", "   ", fake), WebError);
});
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
