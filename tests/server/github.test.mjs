/* Unit tests for supabase/functions/musab/github.ts with a fake GitHub.
   Run: node --experimental-strip-types tests/server/github.test.mjs */
import assert from "node:assert/strict";
const { parseRepoUrl, parseSkillMd, discover, fetchSkill, GitHubError } = await import("../../supabase/functions/musab/github.ts");

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

// ---------------------------------------------------------------- fake GitHub
const FILES = {
  "skills/brainstorm/SKILL.md": "---\nname: brainstorm\ndescription: Diverge then converge on ideas.\n---\n\n# Brainstorm\n1. Go wide\n2. Pick 3",
  "skills/postmortem/SKILL.md": "---\nname: Incident Postmortem\ndescription: >\n  Write a blameless report\n  with timeline and actions.\n---\nUse this template...",
  "skills/postmortem/scripts/make.py": "print(1)",
  "skills/nofront/SKILL.md": "Just instructions, no header.",
  "docs/readme.md": "x",
};
const calls = [];
function fakeFetch(url, init = {}) {
  calls.push({ url, headers: init.headers || {} });
  const u = new URL(url);
  const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (u.pathname === "/repos/acme/skills") return json(200, { default_branch: "main" });
  if (u.pathname === "/repos/acme/private") return json(404, { message: "Not Found" });
  if (u.pathname === "/repos/acme/limited") return json(403, { message: "rate limit" });
  if (u.pathname === "/repos/acme/skills/git/trees/main")
    return json(200, { tree: Object.keys(FILES).map((path) => ({ path, type: "blob", size: FILES[path].length })) });
  const m = u.pathname.match(/^\/repos\/acme\/skills\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    return Promise.resolve(new Response(FILES[path] ?? "", { status: FILES[path] ? 200 : 404 }));
  }
  return json(404, {});
}

await test("parse repo links", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/anthropics/skills"), { owner: "anthropics", repo: "skills", ref: undefined, path: undefined });
  assert.deepEqual(parseRepoUrl("github.com/a/b.git"), { owner: "a", repo: "b", ref: undefined, path: undefined });
  assert.deepEqual(parseRepoUrl("a/b"), { owner: "a", repo: "b", ref: undefined, path: undefined });
  assert.deepEqual(parseRepoUrl("https://github.com/a/b/tree/dev/skills/devops"), { owner: "a", repo: "b", ref: "dev", path: "skills/devops" });
  assert.deepEqual(parseRepoUrl("https://github.com/a/b/blob/main/x/y/SKILL.md"), { owner: "a", repo: "b", ref: "main", path: "x/y" });
  assert.throws(() => parseRepoUrl("https://gitlab.com/a/b"), GitHubError);
});

await test("parse SKILL.md frontmatter (plain, folded, missing)", () => {
  assert.deepEqual(parseSkillMd(FILES["skills/brainstorm/SKILL.md"]), { name: "brainstorm", description: "Diverge then converge on ideas.", body: "# Brainstorm\n1. Go wide\n2. Pick 3" });
  const p = parseSkillMd(FILES["skills/postmortem/SKILL.md"]);
  assert.equal(p.name, "incident-postmortem");
  assert.equal(p.description, "Write a blameless report with timeline and actions.");
  assert.deepEqual(parseSkillMd("Just text", "my folder"), { name: "my-folder", description: "", body: "Just text" });
  assert.equal(parseSkillMd('---\nname: "q"\ndescription: \'Quoted: yes\'\n---\nB').description, "Quoted: yes");
});

await test("discover a whole repo", async () => {
  const r = await discover("https://github.com/acme/skills", { fetch: fakeFetch });
  assert.equal(r.repo, "acme/skills"); assert.equal(r.ref, "main"); assert.equal(r.total, 3);
  const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]));
  assert.ok(byName.brainstorm && !byName.brainstorm.hasScripts);
  assert.ok(byName["incident-postmortem"].hasScripts, "script in the skill folder is flagged");
  assert.equal(byName.nofront.description, "");
});

await test("discover only a folder, on a branch", async () => {
  const r = await discover("https://github.com/acme/skills/tree/main/skills/postmortem", { fetch: fakeFetch });
  assert.deepEqual(r.skills.map((s) => s.path), ["skills/postmortem/SKILL.md"]);
});

await test("token is sent when given", async () => {
  calls.length = 0;
  await discover("acme/skills", { fetch: fakeFetch, token: "ghp_x" });
  assert.ok(calls.every((c) => c.headers.Authorization === "Bearer ghp_x"));
});

await test("friendly errors: missing repo, rate limit, no skills", async () => {
  await assert.rejects(discover("acme/private", { fetch: fakeFetch }), /Repo not found/);
  await assert.rejects(discover("acme/limited", { fetch: fakeFetch }), /GitHub token/);
  await assert.rejects(discover("https://github.com/acme/skills/tree/main/docs", { fetch: fakeFetch }), /No skills found/);
});

await test("fetch one skill", async () => {
  const s = await fetchSkill("acme/skills", "main", "skills/brainstorm/SKILL.md", { fetch: fakeFetch });
  assert.equal(s.name, "brainstorm"); assert.match(s.body, /Go wide/);
});

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
