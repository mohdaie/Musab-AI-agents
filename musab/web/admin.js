/* Admin: sign in, DeepSeek API keys, usage and cost per key, settings.
   All of it is stored on the server (server.js), so it is the same on every device and survives updates. */
import { MODELS, TALK } from "./engine.js";
import { api, session, skills as skillCache } from "./server.js";
import { $app, $sheet, appbar, h, icon, toast } from "./ui.js";

const PERIODS = { today: "Today", d7: "7 days", d30: "30 days", all: "All time" };
let period = "d7";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmtN = (n) => compact.format(n || 0);
const fmtCost = (c) => (c > 0 && c < 0.01 ? `$${c.toFixed(4)}` : `$${(c || 0).toFixed(2)}`);
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const since = (p) => { const t = startOfDay(Date.now()); return { today: t, d7: t - 6 * 864e5, d30: t - 29 * 864e5, all: 0 }[p]; };

function sum(rows) {
  const t = { requests: 0, failed: 0, input: 0, output: 0, cost: 0 };
  for (const r of rows) {
    t.requests++;
    if (!r.ok) t.failed++;
    t.input += r.prompt || 0;
    t.output += r.completion || 0;
    t.cost += r.cost || 0;
  }
  return t;
}
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] || ""; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
const pill = (text, kind = "") => h("span", { class: `pill ${kind}` }, text);
const screen = (bar, ...kids) => h("div", { class: "screen" }, bar, h("div", { class: "content admin" }, ...kids.filter(Boolean)));

// ------------------------------------------------------------------ entry
export async function adminView({ go, current, setCleanup }) {
  if (!session.signedIn()) return loginView(go, current, setCleanup);
  return dashboard(go, current, setCleanup);
}

// ------------------------------------------------------------------ sign in
function loginView(go, current, setCleanup) {
  const user = h("input", { class: "input", id: "adm-user", autocomplete: "username", autocapitalize: "off", spellcheck: "false", required: true });
  const pass = h("input", { class: "input", id: "adm-pass", type: "password", autocomplete: "current-password", required: true });
  const err = h("p", { class: "error", hidden: true });
  const submit = h("button", { class: "btn primary block", type: "submit" }, "Sign in");
  $app.replaceChildren(screen(
    appbar({ title: "Admin", back: () => go("#/") }),
    h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; err.hidden = true;
      try {
        const r = await api("/login", { method: "POST", body: { username: user.value.trim(), password: pass.value } });
        session.set(r.token, r.mustChange);
        if (current()) dashboard(go, current, setCleanup);
        return;
      } catch (ex) { err.textContent = ex.message; err.hidden = false; pass.select(); }
      submit.disabled = false;
    } },
      h("p", { class: "muted" }, "Sign in to manage API keys and usage. You stay signed in on this device."),
      h("div", { class: "field" }, h("label", { for: "adm-user" }, "Username"), user),
      h("div", { class: "field" }, h("label", { for: "adm-pass" }, "Password"), pass),
      err, submit,
      h("p", { class: "note" }, "First time? Sign in with ", h("strong", {}, "admin"), " / ", h("strong", {}, "admin"),
        " and set your own password. You only do this once: it's saved on the server, not on this phone."))));
  if (matchMedia("(hover: hover)").matches) user.focus();
}

// ------------------------------------------------------------------ dashboard
async function dashboard(go, current, setCleanup) {
  $app.replaceChildren(screen(appbar({ title: "Admin", back: () => go("#/") }), h("div", { class: "spinner" })));
  let state;
  try { state = await api("/admin"); } catch (e) {
    if (!current()) return;
    if (e.status === 401) return loginView(go, current, setCleanup);
    $app.replaceChildren(screen(appbar({ title: "Admin", back: () => go("#/") }),
      h("p", { class: "error" }, e.message), h("button", { class: "btn", onclick: () => dashboard(go, current, setCleanup) }, "Try again")));
    return;
  }
  if (!current()) return;
  session.set(session.token(), state.mustChange);
  session.cacheSettings({ ...state.settings, webSearch: !!state.webSearch, threads: !!state.threads?.connected, threadsUser: state.threads?.username || "" });
  // Back from the Threads sign-in page: #/admin/threads-ok or #/admin/threads-error:<message>
  const back = location.hash.match(/^#\/admin\/threads-(ok|error:(.*))$/);
  if (back) {
    history.replaceState(null, "", "#/admin");
    toast(back[1] === "ok" ? `Threads connected${state.threads?.username ? ` as @${state.threads.username}` : ""}` : `Threads: ${decodeURIComponent(back[2] || "couldn't connect")}`);
  }
  const reload = () => { if (current()) dashboard(go, current, setCleanup); };
  const signOut = h("button", { class: "icon-btn", "aria-label": "Sign out", title: "Sign out", html: icon("logout"),
    onclick: () => { session.signOut(); go("#/"); toast("Signed out on this device"); } });
  const bar = appbar({ title: "Admin", subtitle: `Signed in as ${state.username}`, back: () => go("#/"), actions: [signOut] });

  if (state.mustChange) {
    $app.replaceChildren(screen(bar, loginCard(true, state.username, reload)));
    return;
  }
  const keysCard = h("section", { class: "card" });
  const usageCard = h("section", { class: "card" });
  const skillsCard = h("section", { class: "card", id: "skills" });
  const webCard = webSearchCard(state, reload);
  const threadsCard = threadsAdminCard(state.threads || {}, reload);
  $app.replaceChildren(screen(bar,
    localKeysCard(reload),
    keysCard, skillsCard, webCard, threadsCard, usageCard, settingsCard(state.settings),
    loginCard(false, state.username, reload),
    h("p", { class: "note" }, "Keys are stored on your server (Supabase) and only the server talks to DeepSeek, so keys never reach a phone. " +
      "Settings and usage are the same on every device you sign in on.")));
  renderKeys(keysCard, state, reload);
  renderSkills(skillsCard, state);
  await renderUsage(usageCard, state);
}

// Keys saved on this phone by the earlier version of the app: offer to move them to the server.
function localKeysCard(reload) {
  let local = [];
  try { local = JSON.parse(localStorage.getItem("musab.keys") || "[]") || []; } catch {}
  if (!local.length) return null;
  const btn = h("button", { class: "btn primary", onclick: async () => {
    btn.disabled = true;
    let moved = 0;
    for (const k of local) {
      try { await api("/keys", { method: "POST", body: { label: k.label, key: k.key } }); moved++; }
      catch (e) { if (/already saved/.test(e.message)) moved++; else toast(`${k.label}: ${e.message}`); }
    }
    if (moved === local.length) { try { localStorage.removeItem("musab.keys"); localStorage.removeItem("musab.admin"); } catch {} }
    toast(`Moved ${moved} key${moved === 1 ? "" : "s"} to the server`);
    reload();
  } }, `Move ${local.length} key${local.length === 1 ? "" : "s"} to the server`);
  return h("section", { class: "card warn-card" },
    h("div", { class: "card-head" }, h("h2", {}, "Keys on this phone")),
    h("p", { class: "muted" }, "This phone still has keys saved by the earlier version. Move them to the server so every device can use them; they're then removed from this phone."),
    btn);
}

// ------------------------------------------------------------------ keys
const STATUS = { ok: ["Working", "ok"], invalid: ["Invalid key", "bad"], "no-balance": ["No balance", "warn"], unchecked: ["Not checked", ""] };
function balanceText(b) {
  if (!b?.infos?.length) return null;
  return b.infos.map((i) => `${i.currency === "USD" ? "$" : i.currency === "CNY" ? "¥" : `${i.currency} `}${Number(i.total_balance).toFixed(2)}`).join(" · ");
}

function renderKeys(card, state, reload) {
  const active = state.settings.activeKey || state.keys[0]?.id;
  const list = state.keys.map((k) => {
    const [label, kind] = STATUS[k.status] || STATUS.unchecked;
    const bal = balanceText(k.balance);
    const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { toast(`${k.label}: ${e.message}`); } reload(); };
    const check = h("button", { class: "btn small", html: `${icon("refresh")} Check` });
    check.onclick = busy(check, async () => { await api(`/keys/${k.id}/check`, { method: "POST" }); toast(`${k.label}: balance updated`); });
    const use = h("button", { class: "btn small" }, "Use this key");
    use.onclick = busy(use, () => api(`/keys/${k.id}/activate`, { method: "POST" }));
    const del = h("button", { class: "btn small danger" }, "Remove");
    del.onclick = async () => {
      if (!confirm(`Remove “${k.label}” from the server? Its usage history stays.`)) return;
      await busy(del, () => api(`/keys/${k.id}`, { method: "DELETE" }))();
    };
    return h("div", { class: "key-row" },
      h("div", { class: "key-main" },
        h("div", { class: "key-title" }, h("strong", {}, k.label), k.id === active ? pill("Active", "accent") : null, pill(label, kind)),
        h("div", { class: "muted small mono" }, k.masked),
        h("div", { class: "key-balance" }, bal
          ? [h("span", { class: "muted small" }, "Balance "), h("strong", {}, bal),
            h("span", { class: "muted small" }, ` · checked ${new Date(k.balance.checked_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`)]
          : h("span", { class: "muted small" }, "Balance not checked yet")),
        h("div", { class: "key-usage small", "data-key": k.id })),
      h("div", { class: "key-actions" }, k.id === active ? null : use, check, del));
  });

  const label = h("input", { class: "input", id: "key-label", maxlength: 40, placeholder: state.keys.length ? `Key ${state.keys.length + 1}` : "Personal", autocomplete: "off" });
  const key = h("input", { class: "input mono", id: "key-value", type: "password", placeholder: "sk-…", autocomplete: "off", spellcheck: "false", required: true });
  const show = h("button", { type: "button", class: "btn", "aria-label": "Show key", html: icon("eye"), onclick: () => { key.type = key.type === "password" ? "text" : "password"; } });
  const err = h("p", { class: "error", hidden: true });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save key");
  const form = h("form", { class: "add-key", onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true; save.disabled = true; save.textContent = "Checking…";
    try {
      const k = await api("/keys", { method: "POST", body: { label: label.value.trim(), key: key.value.trim() } });
      toast(k.status === "no-balance" ? "Key saved, but it has no balance. Top up at platform.deepseek.com." : "Key saved");
      reload();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; save.textContent = "Save key"; }
  } },
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "key-label" }, "Name"), label),
      h("div", { class: "field" }, h("label", { for: "key-value" }, "DeepSeek API key"), h("div", { class: "input-group" }, key, show))),
    err, save,
    h("p", { class: "muted small" }, "Get a key at ", h("a", { href: "https://platform.deepseek.com/api_keys", target: "_blank", rel: "noopener" }, "platform.deepseek.com"),
      ". With more than one key, agents use the active one and move to the next if a key is invalid or runs out of balance."));

  card.replaceChildren(
    h("div", { class: "card-head" }, h("h2", { html: `${icon("key")} API keys` }), pill(`${state.keys.length} saved`)),
    state.keys.length ? h("div", { class: "key-list" }, list) : h("p", { class: "muted" }, "No keys yet. Add your DeepSeek API key so the agents can reply."),
    form);
}

function fillKeyUsage(card, rows) {
  const byKey = groupBy(rows.filter((r) => r.ts >= since("d30")), "keyId");
  const today = since("today");
  for (const el of card.querySelectorAll(".key-usage")) {
    const all = byKey.get(el.dataset.key) || [];
    const t = sum(all.filter((r) => r.ts >= today)), m = sum(all);
    el.replaceChildren(
      h("span", {}, h("span", { class: "muted" }, "Today "), `${t.requests} req · ${fmtN(t.input + t.output)} tokens · ${fmtCost(t.cost)}`),
      h("span", {}, h("span", { class: "muted" }, "30 days "), `${m.requests} req · ${fmtN(m.input + m.output)} tokens · ${fmtCost(m.cost)}`));
  }
}

// ------------------------------------------------------------------ web search
function webSearchCard(state, reload) {
  const key = h("input", { class: "input mono", id: "tavily-key", type: "password", autocomplete: "off", spellcheck: "false",
    placeholder: state.webSearch ? "Saved. Paste a new key to replace" : "tvly-…" });
  const err = h("p", { class: "error", hidden: true });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");
  return h("section", { class: "card", id: "web" },
    h("div", { class: "card-head" }, h("h2", {}, "Web search"), h("span", { class: `pill ${state.webSearch ? "ok" : ""}` }, state.webSearch ? "On" : "Off")),
    h("p", { class: "muted small" }, "Lets agents you choose search the web and read pages for current or exact facts. Read-only: they can't post or change anything. Uses ",
      h("a", { href: "https://app.tavily.com", target: "_blank", rel: "noopener" }, "Tavily"), ": free for 1,000 searches a month, no card needed."),
    h("form", { onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true; save.disabled = true; save.textContent = "Checking…";
      try {
        const r = await api("/web-key", { method: "POST", body: { key: key.value.trim() } });
        toast(r.webSearch ? "Web search is on. Turn it on per agent in the team sheet." : "Web search key removed");
        reload();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; save.textContent = "Save"; }
    } },
      h("div", { class: "field" }, h("label", { for: "tavily-key" }, "Tavily API key"), h("div", { class: "input-group" }, key, save)),
      err,
      state.webSearch ? h("button", { type: "button", class: "link-btn small danger-text", onclick: async () => {
        if (!confirm("Remove the Tavily key? Agents stop browsing the web.")) return;
        try { await api("/web-key", { method: "POST", body: { key: "" } }); toast("Web search turned off"); reload(); } catch (e) { toast(e.message); }
      } }, "Remove key") : null),
    h("p", { class: "muted small" }, "Then in a chat: tap the group name and switch on ", h("strong", {}, "Can browse the web"),
      " for the agents who need it. Each agent can do at most 3 searches or page reads per reply. Every search shows in the chat, and Usage counts them."));
}

// ------------------------------------------------------------------ threads
function threadsAdminCard(t, reload) {
  const card = h("section", { class: "card", id: "threads" });
  const pillText = t.connected ? "Connected" : t.configured ? "Not connected" : "Off";
  const head = h("div", { class: "card-head" }, h("h2", {}, "Threads"), h("span", { class: `pill ${t.connected ? "ok" : ""}` }, pillText));
  const intro = h("p", { class: "muted small" }, "Lets agents you choose search Threads and draft posts. Agents never post by themselves: a draft shows in the chat with a ",
    h("strong", {}, "Post to Threads"), " button, and nothing goes out until you tap it. Free; uses your own Meta app.");
  const copy = (text) => h("button", { type: "button", class: "btn small", onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed. Select the text instead."); }
  } }, "Copy");

  if (t.connected) {
    const days = t.expiresAt ? Math.max(0, Math.round((t.expiresAt - Date.now()) / 864e5)) : 0;
    card.append(head, intro,
      h("div", { class: "threads-account" }, h("strong", {}, `@${t.username || "your account"}`),
        h("small", { class: "muted" }, days ? `Sign-in valid for ${days} more day${days === 1 ? "" : "s"}; it renews itself while agents use it.` : "")),
      h("p", { class: "muted small" }, "Public search needs Meta to approve the ", h("code", {}, "threads_keyword_search"),
        " permission for your app (App Review). Until then, Threads search only finds your own posts. Posting works now."),
      h("div", { class: "footer-actions" },
        h("button", { type: "button", class: "btn small danger", onclick: async () => {
          if (!confirm("Disconnect Threads? Agents can't search Threads, and drafts can't be posted until you connect again.")) return;
          try { await api("/threads/disconnect", { method: "POST", body: {} }); toast("Threads disconnected"); reload(); } catch (e) { toast(e.message); }
        } }, "Disconnect")),
      h("p", { class: "muted small" }, "Then in a chat: tap the group name and switch on ", h("strong", {}, "Can use Threads"), " for the agents who need it."));
    return card;
  }

  const connect = h("button", { type: "button", class: "btn primary block", disabled: !t.configured, onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api("/threads/start", { method: "POST", body: { ret: location.href.split("#")[0] } });
      location.href = r.url;
    } catch (ex) { toast(ex.message); e.currentTarget.disabled = false; }
  } }, "Connect Threads account");

  const appId = h("input", { class: "input mono", id: "threads-app-id", inputmode: "numeric", autocomplete: "off", value: t.appId || "", placeholder: "e.g. 1234567890123456" });
  const secret = h("input", { class: "input mono", id: "threads-secret", type: "password", autocomplete: "off", spellcheck: "false",
    placeholder: t.configured ? "Saved. Paste again to change" : "Threads app secret" });
  const err = h("p", { class: "error", hidden: true });
  const save = h("button", { class: "btn", type: "submit" }, "Save");
  const steps = h("details", { class: "setup-steps", open: !t.configured },
    h("summary", {}, "How to set it up (about 10 minutes, once)"),
    h("ol", {},
      h("li", {}, "Go to ", h("a", { href: "https://developers.facebook.com/apps", target: "_blank", rel: "noopener" }, "developers.facebook.com/apps"),
        " → ", h("strong", {}, "Create app"), " → choose the use case ", h("strong", {}, "Access the Threads API"), "."),
      h("li", {}, "In ", h("strong", {}, "Use cases → Customize"), ", add the permissions ", h("code", {}, "threads_content_publish"), " and ",
        h("code", {}, "threads_keyword_search"), "."),
      h("li", {}, "In ", h("strong", {}, "Settings"), ", paste this into ", h("strong", {}, "Redirect callback URLs"), " (and the uninstall and delete callback boxes), then Save:",
        h("div", { class: "copy-row" }, h("code", { class: "mono" }, t.redirectUri || ""), copy(t.redirectUri || ""))),
      h("li", {}, "In ", h("strong", {}, "App roles → Roles"), ", add your Threads username as a ", h("strong", {}, "Threads Tester"),
        ". Then in the Threads app: Settings → Account → Website permissions → Invites → Accept."),
      h("li", {}, "Copy the ", h("strong", {}, "Threads app ID"), " and ", h("strong", {}, "Threads app secret"), " from the same Settings page into the boxes below, Save, then tap ",
        h("strong", {}, "Connect Threads account"), ".")));
  card.append(head, intro, steps,
    h("form", { onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true; save.disabled = true;
      try {
        await api("/threads/app", { method: "POST", body: { appId: appId.value.trim(), appSecret: secret.value.trim() } });
        toast("Saved. Now connect your Threads account."); reload();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; }
    } },
      h("div", { class: "field" }, h("label", { for: "threads-app-id" }, "Threads app ID"), appId),
      h("div", { class: "field" }, h("label", { for: "threads-secret" }, "Threads app secret"), secret),
      err,
      h("div", { class: "footer-actions" },
        t.configured ? h("button", { type: "button", class: "link-btn small danger-text", onclick: async () => {
          if (!confirm("Remove the Threads app details?")) return;
          try { await api("/threads/app", { method: "POST", body: {} }); toast("Threads removed"); reload(); } catch (ex) { toast(ex.message); }
        } }, "Remove") : null,
        save)),
    connect);
  return card;
}

// ------------------------------------------------------------------ skills
async function renderSkills(card, state) {
  const head = h("div", { class: "card-head" }, h("h2", {}, "Skills"));
  card.replaceChildren(head, h("div", { class: "spinner" }));
  let list;
  try { list = await api("/skills"); skillCache.cache(list); }
  catch (e) { card.replaceChildren(head, h("p", { class: "error" }, e.message)); return; }
  const redraw = () => renderSkills(card, state);
  head.append(h("span", { class: "pill" }, `${list.length} skill${list.length === 1 ? "" : "s"}`));

  // ---- add from GitHub: paste a repo, discover every SKILL.md, tick which to add
  const url = h("input", { class: "input", id: "skill-repo", placeholder: "https://github.com/owner/repo", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const err = h("p", { class: "error", hidden: true });
  const results = h("div", { hidden: true });
  const findBtn = h("button", { class: "btn primary", type: "submit" }, "Discover");
  const discover = h("form", { class: "discover", onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true; results.hidden = true; findBtn.disabled = true; findBtn.textContent = "Searching…";
    try { showFound(await api("/skills/discover", { method: "POST", body: { url: url.value.trim() } })); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
    findBtn.disabled = false; findBtn.textContent = "Discover";
  } },
    h("h3", {}, "Add from GitHub"),
    h("p", { class: "muted small" }, "Paste a repo (or a folder in one). Every folder with a SKILL.md is a skill."),
    h("div", { class: "input-group" }, url, findBtn), err, results);

  const have = new Set(list.filter((k) => k.source).map((k) => `${k.source.repo}/${k.source.path}`));
  function showFound(r) {
    const picks = new Set(r.skills.filter((k) => !have.has(`${r.repo}/${k.path}`)).map((k) => k.path));
    const count = h("span", {});
    const addBtn = h("button", { class: "btn primary", type: "button" });
    const sync = () => { count.textContent = `${picks.size} selected`; addBtn.textContent = `Add ${picks.size} skill${picks.size === 1 ? "" : "s"}`; addBtn.disabled = !picks.size; };
    const boxes = [];
    const all = h("input", { type: "checkbox", checked: picks.size === r.skills.length, onchange: (e) => {
      boxes.forEach(([cb, path]) => { cb.checked = e.target.checked; e.target.checked ? picks.add(path) : picks.delete(path); }); sync();
    } });
    const rows = r.skills.map((k) => {
      const added = have.has(`${r.repo}/${k.path}`);
      const cb = h("input", { type: "checkbox", checked: picks.has(k.path), onchange: (e) => { e.target.checked ? picks.add(k.path) : picks.delete(k.path); sync(); } });
      boxes.push([cb, k.path]);
      return h("label", { class: "skill-option" }, cb,
        h("span", {}, h("strong", {}, k.name, added ? h("span", { class: "tag-warn" }, "already added, will update") : null,
          k.hasScripts ? h("span", { class: "tag-warn", title: "This skill has scripts. Agents can't run them; they follow the written instructions only." }, "uses scripts") : null),
          h("small", {}, k.description || "(no description)"), h("small", { class: "src" }, k.path)));
    });
    addBtn.onclick = async () => {
      addBtn.disabled = true; addBtn.textContent = "Adding…";
      const chosen = r.skills.filter((k) => picks.has(k.path));
      try {
        const res = await api("/skills/import", { method: "POST", body: { repo: r.repo, ref: r.ref, paths: chosen.map((k) => k.path), scripts: chosen.filter((k) => k.hasScripts).map((k) => k.path) } });
        toast(`Added ${res.imported.length} skill${res.imported.length === 1 ? "" : "s"}${res.errors.length ? `, ${res.errors.length} failed` : ""}`);
        if (res.errors.length) console.warn(res.errors);
        redraw();
      } catch (ex) { toast(ex.message); sync(); }
    };
    sync();
    results.replaceChildren(
      h("p", { class: "small" }, h("strong", {}, `Found ${r.total} skill${r.total === 1 ? "" : "s"}`), ` in ${r.repo} (${r.ref})`,
        r.truncated ? h("span", { class: "muted" }, ` · showing the first ${r.skills.length}`) : null),
      h("label", { class: "skill-option" }, all, h("span", {}, h("strong", {}, "Select all"), count)),
      h("div", { class: "discover-results" }, rows),
      addBtn);
    results.hidden = false;
  }

  // ---- the skills you have
  const rows = list.map((k) => h("div", { class: "skill-row" },
    h("div", { class: "main" },
      h("strong", {}, k.name, k.hasScripts ? h("span", { class: "tag-warn" }, "uses scripts") : null),
      h("small", {}, k.description || "(no description)"),
      h("span", { class: "src" }, k.source ? `GitHub · ${k.source.repo} · ${k.source.path}` : "Written by you")),
    h("button", { class: "btn small", onclick: () => editSkill(k, redraw) }, "Edit"),
    h("button", { class: "btn small danger", "aria-label": `Delete ${k.name}`, onclick: async () => {
      if (!confirm(`Delete the skill “${k.name}”? Agents that have it stop using it.`)) return;
      try { await api(`/skills/${k.id}`, { method: "DELETE" }); toast("Skill deleted"); redraw(); } catch (e) { toast(e.message); }
    } }, "Delete")));
  const updateBtn = list.some((k) => k.source) ? h("button", { class: "btn small", html: `${icon("refresh")} Check GitHub for updates`, onclick: async () => {
    updateBtn.disabled = true;
    try { const r = await api("/skills/update", { method: "POST" }); toast(`${r.updated} of ${r.checked} skills updated${r.errors.length ? `, ${r.errors.length} failed` : ""}`); redraw(); }
    catch (e) { toast(e.message); updateBtn.disabled = false; }
  } }) : null;

  // ---- write your own
  const nName = h("input", { class: "input", id: "new-skill-name", maxlength: 64, placeholder: "e.g. brainstorming", autocomplete: "off" });
  const nDesc = h("input", { class: "input", id: "new-skill-desc", maxlength: 300, placeholder: "When to use it, in one line" });
  const nBody = h("textarea", { class: "textarea skill-body", id: "new-skill-body", placeholder: "The instructions. Steps, checklists, rules, templates…" });
  const write = h("details", { class: "write" }, h("summary", {}, "Write your own skill"),
    h("form", { onsubmit: async (e) => {
      e.preventDefault();
      try { await api("/skills", { method: "POST", body: { name: nName.value, description: nDesc.value, body: nBody.value } }); toast("Skill added"); redraw(); }
      catch (ex) { toast(ex.message); }
    } },
      h("div", { class: "field" }, h("label", { for: "new-skill-name" }, "Name"), nName),
      h("div", { class: "field" }, h("label", { for: "new-skill-desc" }, "Description"), nDesc),
      h("div", { class: "field" }, h("label", { for: "new-skill-body" }, "Instructions"), nBody),
      h("button", { class: "btn primary", type: "submit" }, "Add skill")));

  // ---- GitHub token (optional)
  const tok = h("input", { class: "input mono", id: "gh-token", type: "password", autocomplete: "off", placeholder: state.githubToken ? "Saved. Paste a new one to replace" : "github_pat_…" });
  const token = h("details", { class: "write" }, h("summary", {}, `GitHub token (optional)${state.githubToken ? " · saved" : ""}`),
    h("p", { class: "muted small" }, "Only needed for private repos, or if GitHub limits anonymous requests. A read-only token is enough. Stored on your server only."),
    h("form", { class: "input-group", onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await api("/github-token", { method: "POST", body: { token: tok.value } }); state.githubToken = r.githubToken; toast(r.githubToken ? "GitHub token saved" : "GitHub token removed"); redraw(); }
      catch (ex) { toast(ex.message); }
    } }, tok, h("button", { class: "btn", type: "submit" }, "Save")));

  card.replaceChildren(head,
    h("p", { class: "muted small" }, "Give agents skills in a chat: tap the group name, then Skills under a member. Agents see each skill's name and description, and open the full instructions only when they need them."),
    list.length ? h("div", { class: "skill-list" }, rows) : h("p", { class: "muted" }, "No skills yet."),
    updateBtn, discover, write, token);
}

function editSkill(k, done) {
  const name = h("input", { class: "input", id: "edit-skill-name", maxlength: 64, value: k.name });
  const desc = h("input", { class: "input", id: "edit-skill-desc", maxlength: 1024, value: k.description || "" });
  const body = h("textarea", { class: "textarea skill-body", id: "edit-skill-body" }, k.body || "");
  $sheet.replaceChildren(h("form", { class: "sheet-body", onsubmit: async (e) => {
    e.preventDefault();
    try { await api(`/skills/${k.id}`, { method: "POST", body: { name: name.value, description: desc.value, body: body.value } }); $sheet.close(); toast("Skill saved"); done(); }
    catch (ex) { toast(ex.message); }
  } },
    h("h2", {}, "Edit skill"),
    k.source ? h("p", { class: "sub" }, `From ${k.source.repo}. "Check GitHub for updates" would replace your edits with the latest version.`) : null,
    h("div", { class: "field" }, h("label", { for: "edit-skill-name" }, "Name"), name),
    h("div", { class: "field" }, h("label", { for: "edit-skill-desc" }, "Description"), desc),
    h("div", { class: "field" }, h("label", { for: "edit-skill-body" }, "Instructions"), body),
    h("div", { class: "footer-actions" },
      h("button", { class: "btn", type: "button", onclick: () => $sheet.close() }, "Cancel"),
      h("button", { class: "btn primary", type: "submit" }, "Save"))));
  $sheet.showModal();
}

// ------------------------------------------------------------------ usage
async function renderUsage(card, state) {
  card.replaceChildren(h("div", { class: "card-head" }, h("h2", {}, "Usage")), h("div", { class: "spinner" }));
  let all;
  try { all = await api(`/usage?since=${Math.min(since(period), since("d30"), startOfDay(Date.now()) - 13 * 864e5)}`); }
  catch (e) { card.replaceChildren(h("div", { class: "card-head" }, h("h2", {}, "Usage")), h("p", { class: "error" }, e.message)); return; }
  const keysCard = card.parentElement?.querySelector(".key-list")?.closest(".card");
  if (keysCard) fillKeyUsage(keysCard, all);
  const rows = all.filter((r) => r.ts >= since(period));
  const t = sum(rows);
  const keys = Object.fromEntries(state.keys.map((k) => [k.id, k.label]));
  const tabs = h("div", { class: "segmented", role: "tablist" }, Object.entries(PERIODS).map(([k, v]) =>
    h("button", { role: "tab", "aria-selected": String(k === period), onclick: () => { period = k; renderUsage(card, state); } }, v)));
  const tile = (label, value, sub) => h("div", { class: "stat" }, h("div", { class: "stat-label" }, label),
    h("div", { class: "stat-value" }, value), sub ? h("div", { class: "stat-sub" }, sub) : null);
  const table = (title, groups, nameOf, withFailed) => {
    const entries = [...groups.entries()].map(([k, r]) => [k, sum(r)]).sort((a, b) => b[1].cost - a[1].cost || b[1].requests - a[1].requests);
    if (!entries.length) return null;
    return h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("caption", {}, title),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, title.replace("By ", "")), h("th", { scope: "col" }, "Requests"),
        h("th", { scope: "col" }, "Tokens in / out"), h("th", { scope: "col" }, "Est. cost"))),
      h("tbody", {}, entries.map(([k, s]) => h("tr", {},
        h("th", { scope: "row" }, nameOf(k), withFailed && s.failed ? h("span", { class: "failed" }, `${s.failed} failed`) : null),
        h("td", {}, String(s.requests)), h("td", {}, `${fmtN(s.input)} / ${fmtN(s.output)}`), h("td", {}, fmtCost(s.cost)))))));
  };
  card.replaceChildren(...[
    h("div", { class: "card-head" }, h("h2", {}, "Usage"), tabs),
    h("div", { class: "stats" },
      tile("Requests", String(t.requests), t.failed ? `${t.failed} failed` : "all succeeded"),
      tile("Tokens in", fmtN(t.input)), tile("Tokens out", fmtN(t.output)), tile("Est. cost", fmtCost(t.cost), "USD")),
    dailyChart(all),
    rows.length ? null : h("p", { class: "muted" }, "No requests in this period yet."),
    table("By API key", groupBy(rows, "keyId"), (k) => keys[k] || "Removed key", true),
    table("By model", groupBy(rows, "model"), (k) => ({ "web-search": "Web searches", "web-read": "Pages read", "threads-search": "Threads searches", "threads-post": "Threads posts" }[k] || (MODELS[k] || k).replace(/ \(.*\)$/, "")), false),
    table("By agent", groupBy(rows, "agent"), (k) => (k ? `@${k}` : "Other"), false),
    h("p", { class: "muted small" }, "The server counts usage from every device. Cost is estimated from DeepSeek's published prices, including peak and off-peak rates; your real balance is shown on each key."),
    h("button", { class: "link-btn small", onclick: async () => {
      if (!confirm("Clear the usage history on the server? Keys and chats stay.")) return;
      try { await api("/usage", { method: "DELETE" }); renderUsage(card, state); } catch (e) { toast(e.message); }
    } }, "Clear usage history"),
  ].filter(Boolean));
}

function dailyChart(rows) {
  const days = 14;
  const first = startOfDay(Date.now()) - (days - 1) * 864e5;
  const byDay = groupBy(rows.filter((r) => r.ts >= first).map((r) => ({ ...r, day: dayKey(r.ts) })), "day");
  const data = Array.from({ length: days }, (_, i) => {
    const ms = first + i * 864e5 + 12 * 3600e3; // midday avoids DST edges
    const s = sum(byDay.get(dayKey(ms)) || []);
    return { ms, ...s, tokens: s.input + s.output };
  });
  const max = Math.max(...data.map((d) => d.tokens), 1);
  const tip = h("div", { class: "chart-tip", role: "status", hidden: true });
  const label = (d) => new Date(d.ms).toLocaleDateString([], { day: "numeric", month: "short" });
  const show = (d, el) => {
    tip.replaceChildren(h("strong", {}, label(d)), h("span", {}, `${fmtN(d.tokens)} tokens`), h("span", {}, `${d.requests} requests · ${fmtCost(d.cost)}`));
    tip.hidden = false;
    const box = el.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(r.left - box.left + r.width / 2, 70), box.width - 70)}px`;
  };
  const bars = data.map((d) => {
    const b = h("button", { class: "bar", type: "button", "aria-label": `${label(d)}: ${fmtN(d.tokens)} tokens, ${d.requests} requests` },
      h("span", { class: "bar-fill", style: `height:${d.tokens ? Math.max(2, (d.tokens / max) * 100) : 0}%` }));
    b.addEventListener("pointerenter", () => show(d, b));
    b.addEventListener("focus", () => show(d, b));
    b.addEventListener("pointerleave", () => (tip.hidden = true));
    b.addEventListener("blur", () => (tip.hidden = true));
    return b;
  });
  return h("figure", { class: "chart" },
    h("figcaption", {}, h("span", {}, "Tokens per day, last 14 days"), h("span", { class: "muted" }, data.some((d) => d.tokens) ? `max ${fmtN(max)}` : "no usage yet")),
    h("div", { class: "plot" }, bars, tip),
    h("div", { class: "axis" }, h("span", {}, label(data[0])), h("span", {}, "Today")));
}

// ------------------------------------------------------------------ settings
function settingsCard(s) {
  const save = async (patch) => {
    try {
      const next = await api("/settings", { method: "POST", body: patch });
      Object.assign(s, next);
      const { webSearch, threads, threadsUser } = session.settings(); // not part of /settings
      session.cacheSettings({ ...next, webSearch, threads, threadsUser });
      toast("Saved");
    }
    catch (e) { toast(e.message); }
  };
  const modelSelect = (style, id) => h("select", { class: "input", id, onchange: (e) => save({ models: { ...s.models, [style]: e.target.value } }) },
    Object.entries(MODELS).map(([m, name]) => h("option", { value: m, selected: m === s.models?.[style] }, name)));
  const talkChoice = (key) => h("label", { class: "talk-option" },
    h("input", { type: "radio", name: "talk", value: key, checked: (s.talk || "balanced") === key, onchange: () => save({ talk: key }) }),
    h("span", {}, h("strong", {}, TALK[key].label), h("span", { class: "hint" }, TALK[key].desc)));
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Settings")),
    h("fieldset", { class: "field talk" }, h("legend", {}, "Default talk level for new agents"),
      Object.keys(TALK).map(talkChoice),
      h("span", { class: "hint" }, "Each agent has its own level. Change it any time: open a chat, tap the group name, and pick Light, Balanced or Detailed under the member. Agents you @mention always answer.")),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "set-model-work" }, "Model for engineer teams"), modelSelect("work", "set-model-work")),
      h("div", { class: "field" }, h("label", { for: "set-model-friends" }, "Model for friend groups"), modelSelect("friends", "set-model-friends"))),
    h("p", { class: "hint muted small" }, "Flash costs about a third of Pro."),
    h("label", { class: "switch" },
      h("span", {}, h("strong", {}, "Use the next key if one fails"), h("span", { class: "hint" }, "When a key is invalid or out of balance.")),
      h("input", { type: "checkbox", checked: s.fallback !== false, onchange: (e) => save({ fallback: e.target.checked }) })));
}

// ------------------------------------------------------------------ login details
function loginCard(isDefault, username, reload) {
  const user = h("input", { class: "input", id: "new-user", autocomplete: "username", autocapitalize: "off", value: username, required: true });
  const p1 = h("input", { class: "input", id: "new-pass", type: "password", autocomplete: "new-password", minlength: 8, required: true });
  const p2 = h("input", { class: "input", id: "new-pass2", type: "password", autocomplete: "new-password", required: true });
  const err = h("p", { class: "error", hidden: true });
  const btn = h("button", { class: "btn primary", type: "submit" }, isDefault ? "Save and continue" : "Save login");
  return h("form", { class: `card ${isDefault ? "warn-card" : ""}`, onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (p1.value !== p2.value) { err.textContent = "The passwords don't match."; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const r = await api("/login/change", { method: "POST", body: { username: user.value.trim(), password: p1.value } });
      session.set(r.token, false);
      toast("Login saved. Other devices will need to sign in again.");
      reload();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } },
    h("div", { class: "card-head" }, h("h2", {}, isDefault ? "Set your own login" : "Admin login")),
    isDefault ? h("p", { class: "muted" }, "You're signed in with the default admin / admin. Pick your own username and password. " +
      "This is saved on the server, so you won't be asked again after updates or on other devices.") : null,
    h("div", { class: "field" }, h("label", { for: "new-user" }, "Username"), user),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "new-pass" }, "New password (8+ characters)"), p1),
      h("div", { class: "field" }, h("label", { for: "new-pass2" }, "Repeat password"), p2)),
    err, btn);
}
