// Web search and page reading for agents, through Tavily (api.tavily.com).
// Plain TypeScript with no Deno-only APIs, so tests can run it in Node with a fake fetch.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export class WebError extends Error {}

export const MAX_RESULTS = 5;
export const MAX_PAGE_CHARS = 12_000; // ~3k tokens: enough to answer from, cheap to read

async function call(fetchImpl: Fetch, key: string, endpoint: string, body: unknown) {
  let r: Response;
  try {
    r = await fetchImpl(`https://api.tavily.com/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new WebError(`Can't reach the search service (${(e as Error).message}).`);
  }
  const d: any = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403) throw new WebError("The Tavily key was rejected. Check it in Admin → Web search.");
  if (r.status === 429 || r.status === 432 || r.status === 433) throw new WebError("Tavily's limit or credits are used up for now.");
  if (!r.ok) throw new WebError(d?.detail?.error || d?.error || `Search service error ${r.status}`);
  return d;
}

/** Search the web: up to 5 results with title, url and a short relevant excerpt. */
export async function search(key: string, query: string, fetchImpl: Fetch = fetch) {
  const q = String(query || "").trim().slice(0, 400);
  if (!q) throw new WebError("Empty search.");
  const d = await call(fetchImpl, key, "search", { query: q, max_results: MAX_RESULTS, search_depth: "basic" });
  return (d?.results || []).slice(0, MAX_RESULTS).map((r: any) => ({
    title: String(r.title || "").slice(0, 200),
    url: String(r.url || ""),
    content: String(r.content || "").replace(/\s+/g, " ").slice(0, 700),
  }));
}

/** Read one web page as text (markdown), trimmed to a readable size. */
export async function read(key: string, url: string, fetchImpl: Fetch = fetch) {
  let u: URL;
  try { u = new URL(String(url || "").trim()); } catch { throw new WebError("That isn't a web address."); }
  if (!/^https?:$/.test(u.protocol)) throw new WebError("Only http and https pages can be read.");
  const d = await call(fetchImpl, key, "extract", { urls: [u.href], extract_depth: "basic", format: "markdown" });
  const page = (d?.results || [])[0];
  if (!page?.raw_content) throw new WebError(`Couldn't read that page${d?.failed_results?.[0]?.error ? `: ${d.failed_results[0].error}` : ""}.`);
  let text = String(page.raw_content).trim();
  const cut = text.length > MAX_PAGE_CHARS;
  if (cut) text = text.slice(0, MAX_PAGE_CHARS);
  return { url: String(page.url || u.href), content: text + (cut ? "\n\n[...page trimmed]" : "") };
}
