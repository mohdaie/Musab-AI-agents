// Threads (Meta) API: connect an account, search public posts, publish text posts and threads.
// Plain TypeScript with no Deno-only APIs, so tests can run it in Node with a fake fetch.
// Docs: developers.facebook.com/documentation/threads (Oct 2026).

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export class ThreadsError extends Error {
  expired: boolean;
  constructor(msg: string, expired = false) { super(msg); this.expired = expired; }
}

export const GRAPH = "https://graph.threads.net";
export const SCOPES = ["threads_basic", "threads_content_publish", "threads_keyword_search"];
export const MAX_CHARS = 500; // per post; emojis count as their UTF-8 bytes
export const MAX_POSTS = 10;  // a thread of up to 10 posts (the first, then replies chained under it)

/** Length as Threads counts it: one per character, but an emoji counts its UTF-8 bytes. */
export function threadsLength(s: string) {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let n = 0;
  for (const { segment } of seg.segment(s)) {
    n += /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ? new TextEncoder().encode(segment).length : 1;
  }
  return n;
}

/** The page where the person signs in to Threads and allows this app. */
export function authUrl(appId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope: SCOPES.join(","), response_type: "code", state });
  return `https://threads.com/oauth/authorize?${q}`;
}

async function call(fetchImpl: Fetch, method: "GET" | "POST", path: string, params: Record<string, string>) {
  const q = new URLSearchParams(params);
  let r: Response;
  try {
    r = method === "GET"
      ? await fetchImpl(`${GRAPH}${path}?${q}`)
      : await fetchImpl(`${GRAPH}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: q.toString() });
  } catch (e) {
    throw new ThreadsError(`Can't reach Threads (${(e as Error).message}).`);
  }
  const d: any = await r.json().catch(() => null);
  if (r.ok && !d?.error) return d;
  const e = d?.error || {};
  const msg = String(e.message || d?.error_message || `Threads error ${r.status}`);
  if (e.code === 190 || /access token|session has expired/i.test(msg))
    throw new ThreadsError("The Threads sign-in has expired or was removed. Reconnect in Admin → Threads.", true);
  if ([4, 17, 32, 613].includes(e.code)) throw new ThreadsError("Threads' limit is reached for now. Try again later.");
  throw new ThreadsError(msg);
}

/** Sign-in code -> long-lived token (60 days) and the account it belongs to. */
export async function exchangeCode(fetchImpl: Fetch, o: { appId: string; secret: string; redirectUri: string; code: string }) {
  const short = await call(fetchImpl, "POST", "/oauth/access_token", {
    client_id: o.appId, client_secret: o.secret, grant_type: "authorization_code", redirect_uri: o.redirectUri, code: o.code });
  const long = await call(fetchImpl, "GET", "/access_token", {
    grant_type: "th_exchange_token", client_secret: o.secret, access_token: short.access_token });
  const me = await call(fetchImpl, "GET", "/v1.0/me", { fields: "id,username", access_token: long.access_token });
  return { token: String(long.access_token), expiresAt: Date.now() + Number(long.expires_in || 5184000) * 1000,
    userId: String(me.id), username: String(me.username || "") };
}

/** A long-lived token at least a day old gets another 60 days. */
export async function refresh(fetchImpl: Fetch, token: string) {
  const d = await call(fetchImpl, "GET", "/refresh_access_token", { grant_type: "th_refresh_token", access_token: token });
  return { token: String(d.access_token), expiresAt: Date.now() + Number(d.expires_in || 5184000) * 1000 };
}

/** Search public posts by keyword or topic tag. Until Meta approves threads_keyword_search, only the account's own posts. */
export async function search(fetchImpl: Fetch, token: string, query: string, o: { recent?: boolean; tag?: boolean; limit?: number } = {}) {
  const q = String(query || "").trim().replace(/^#/, "").slice(0, 200);
  if (!q) throw new ThreadsError("Empty search.");
  const d = await call(fetchImpl, "GET", "/v1.0/keyword_search", {
    q, search_type: o.recent ? "RECENT" : "TOP", search_mode: o.tag ? "TAG" : "KEYWORD",
    limit: String(Math.min(Math.max(Number(o.limit) || 15, 1), 25)),
    fields: "id,text,media_type,permalink,timestamp,username", access_token: token });
  return (d?.data || []).map((p: any) => ({
    username: String(p.username || ""), text: String(p.text || "").replace(/\s+/g, " ").slice(0, 600),
    permalink: String(p.permalink || ""), timestamp: String(p.timestamp || ""), mediaType: String(p.media_type || ""),
  }));
}

/** Check a draft before posting: 1 to 10 posts, each 1 to 500 (Threads-counted) characters. */
export function checkPosts(posts: unknown): string[] {
  if (!Array.isArray(posts) || !posts.length) throw new ThreadsError("Nothing to post.");
  if (posts.length > MAX_POSTS) throw new ThreadsError(`A thread can have up to ${MAX_POSTS} posts here.`);
  return posts.map((p, i) => {
    const t = String(p ?? "").trim();
    if (!t) throw new ThreadsError(`Post ${i + 1} is empty.`);
    const n = threadsLength(t);
    if (n > MAX_CHARS) throw new ThreadsError(`Post ${i + 1} is ${n} characters; Threads allows ${MAX_CHARS}.`);
    return t;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Publish text posts: the first as a post, each next one as a reply under the previous (a thread).
    Stops at the first failure and says how many went out. */
export async function publish(fetchImpl: Fetch, token: string, userId: string, posts: string[], o: { wait?: (ms: number) => Promise<unknown> } = {}) {
  const wait = o.wait || sleep;
  const list = checkPosts(posts);
  const ids: string[] = [];
  let permalink = "";
  for (const [i, text] of list.entries()) {
    try {
      const params: Record<string, string> = { media_type: "TEXT", text, access_token: token };
      if (ids.length) params.reply_to_id = ids[ids.length - 1];
      const c = await call(fetchImpl, "POST", `/v1.0/${userId}/threads`, params);
      // Text is usually ready at once; media can take a while, so retry publishing briefly.
      let id = "";
      for (let attempt = 0; ; attempt++) {
        try { id = String((await call(fetchImpl, "POST", `/v1.0/${userId}/threads_publish`, { creation_id: c.id, access_token: token })).id); break; }
        catch (e) { if ((e as ThreadsError).expired || attempt >= 4) throw e; await wait(2000 * (attempt + 1)); }
      }
      ids.push(id);
      if (i === 0) {
        try { permalink = String((await call(fetchImpl, "GET", `/v1.0/${id}`, { fields: "permalink", access_token: token })).permalink || ""); } catch { /* posted anyway */ }
      }
    } catch (e) {
      if (!ids.length) throw e;
      return { ids, permalink, error: `Posted ${ids.length} of ${list.length}; then: ${(e as Error).message}` };
    }
  }
  return { ids, permalink, error: "" };
}
