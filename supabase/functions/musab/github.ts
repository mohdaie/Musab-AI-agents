// Discover and fetch Agent Skills (folders with a SKILL.md) from a GitHub repo.
// Plain TypeScript with no Deno-only APIs, so tests can run it in Node with a fake fetch.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface RepoRef { owner: string; repo: string; ref?: string; path?: string }
export interface Found { path: string; name: string; description: string; hasScripts: boolean; size: number }

const SCRIPT_EXT = /\.(py|sh|bash|js|mjs|ts|ps1|rb|go|exe|bat|cmd)$/i;
export const MAX_SKILLS = 150;
export const MAX_BODY = 60_000;

export class GitHubError extends Error {}

/** github.com/owner/repo[/tree|blob/<ref>/<path>], owner/repo, with or without https://. */
export function parseRepoUrl(input: string): RepoRef {
  const s = String(input || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/i)
    || s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new GitHubError("Paste a GitHub repo link, like https://github.com/owner/repo");
  let path = m[4] ? decodeURIComponent(m[4]) : "";
  if (/(^|\/)skill\.md$/i.test(path)) path = path.replace(/\/?skill\.md$/i, "");
  return { owner: m[1], repo: m[2], ref: m[3] || undefined, path: path || undefined };
}

/** SKILL.md: YAML-ish frontmatter (name, description) followed by markdown instructions. */
export function parseSkillMd(text: string, fallbackName = "skill") {
  let front = "", body = String(text || "").replace(/^﻿/, "");
  const m = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (m) { front = m[1]; body = body.slice(m[0].length); }
  const field = (key: string) => {
    const lines = front.split(/\r?\n/);
    const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (i < 0) return "";
    let v = lines[i].replace(new RegExp(`^${key}\\s*:\\s*`), "");
    if (/^[>|][-+]?\s*$/.test(v)) { // folded / literal block: take the indented lines that follow
      const more: string[] = [];
      for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || !lines[j].trim()); j++) more.push(lines[j].trim());
      v = more.join(v.startsWith("|") ? "\n" : " ").trim();
    }
    return v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  };
  const clean = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const name = clean(field("name")) || clean(fallbackName) || "skill";
  const description = field("description").replace(/\s+/g, " ").slice(0, 1024);
  let out = body.trim();
  if (out.length > MAX_BODY) out = out.slice(0, MAX_BODY) + "\n\n[...skill truncated: too long]";
  return { name, description, body: out };
}

function gh(token?: string) {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "musab-agents" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function getJson(fetchImpl: Fetch, url: string, token?: string) {
  const r = await fetchImpl(url, { headers: gh(token) });
  if (r.status === 404) throw new GitHubError("Repo not found. Check the link; private repos need a GitHub token in Admin → Skills.");
  if (r.status === 403 || r.status === 429) {
    throw new GitHubError(token ? "GitHub refused the request (rate limit or token permissions). Try again later."
      : "GitHub's limit for anonymous requests was reached. Add a GitHub token in Admin → Skills, or try again in an hour.");
  }
  if (r.status === 401) throw new GitHubError("The GitHub token was rejected. Update it in Admin → Skills.");
  if (!r.ok) throw new GitHubError(`GitHub error ${r.status}`);
  return r.json();
}

async function raw(fetchImpl: Fetch, o: string, r: string, ref: string, path: string, token?: string) {
  // The contents API works for private repos too (with a token); raw media type returns the file itself.
  const url = `https://api.github.com/repos/${o}/${r}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  const res = await fetchImpl(url, { headers: { ...gh(token), Accept: "application/vnd.github.raw+json" } });
  if (!res.ok) throw new GitHubError(`Couldn't read ${path} (GitHub ${res.status})`);
  return res.text();
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Find every SKILL.md in the repo (or under the given folder) with its name and description. */
export async function discover(input: string, opts: { fetch?: Fetch; token?: string } = {}) {
  const f = opts.fetch || fetch;
  const ref0 = parseRepoUrl(input);
  const base = `https://api.github.com/repos/${ref0.owner}/${ref0.repo}`;
  const ref = ref0.ref || (await getJson(f, base, opts.token)).default_branch || "main";
  const tree = await getJson(f, `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, opts.token);
  const blobs: { path: string; size?: number }[] = (tree.tree || []).filter((t: any) => t.type === "blob");
  const prefix = ref0.path ? ref0.path.replace(/\/$/, "") + "/" : "";
  const inScope = (p: string) => !prefix || p === prefix.slice(0, -1) || p.startsWith(prefix);
  const skillFiles = blobs.filter((b) => /(^|\/)skill\.md$/i.test(b.path) && inScope(b.path));
  if (!skillFiles.length) throw new GitHubError("No skills found. A skill is a folder with a SKILL.md file.");
  const picked = skillFiles.slice(0, MAX_SKILLS);
  const skills: Found[] = await pool(picked, 8, async (b) => {
    const dir = b.path.replace(/\/?skill\.md$/i, "");
    const text = await raw(f, ref0.owner, ref0.repo, ref, b.path, opts.token);
    const p = parseSkillMd(text, dir.split("/").pop() || ref0.repo);
    const hasScripts = blobs.some((x) => (dir ? x.path.startsWith(dir + "/") : true) && SCRIPT_EXT.test(x.path));
    return { path: b.path, name: p.name, description: p.description, hasScripts, size: text.length };
  });
  return { repo: `${ref0.owner}/${ref0.repo}`, ref, total: skillFiles.length, truncated: skillFiles.length > MAX_SKILLS || !!tree.truncated, skills };
}

/** Fetch and parse one SKILL.md. */
export async function fetchSkill(repo: string, ref: string, path: string, opts: { fetch?: Fetch; token?: string } = {}) {
  const [o, r] = repo.split("/");
  const text = await raw(opts.fetch || fetch, o, r, ref, path, opts.token);
  const dir = path.replace(/\/?skill\.md$/i, "");
  return parseSkillMd(text, dir.split("/").pop() || r);
}
