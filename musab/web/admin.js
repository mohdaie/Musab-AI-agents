/* Admin: sign in, manage DeepSeek API keys, see usage and cost per key, settings.
   Everything is stored in this browser only. */
import { admin, config, db, DEFAULT_ADMIN } from "./db.js";
import { MODELS, checkBalance } from "./engine.js";
import { $app, h, icon, toast } from "./ui.js";

const PERIODS = { today: "Today", d7: "7 days", d30: "30 days", all: "All time" };
let period = "d7";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmtN = (n) => compact.format(n || 0);
const fmtCost = (c) => (c > 0 && c < 0.01 ? `$${c.toFixed(4)}` : `$${(c || 0).toFixed(2)}`);
const mask = (k) => (k.length > 10 ? `${k.slice(0, 3)}…${k.slice(-4)}` : "••••");
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function since(p) {
  const today = startOfDay(Date.now());
  return { today, d7: today - 6 * 864e5, d30: today - 29 * 864e5, all: 0 }[p];
}

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

function pill(text, kind = "") { return h("span", { class: `pill ${kind}` }, text); }

function page(...kids) {
  return h("div", { class: "page admin" }, ...kids);
}

// ------------------------------------------------------------------ entry
export async function adminView({ go, current, setCleanup }) {
  if (!admin.signedIn()) return loginView(go, current, setCleanup);
  return dashboard(go, setCleanup);
}

// ------------------------------------------------------------------ login
function loginView(go, current, setCleanup) {
  const user = h("input", { class: "input", id: "adm-user", autocomplete: "username", autocapitalize: "off", spellcheck: "false", required: true });
  const pass = h("input", { class: "input", id: "adm-pass", type: "password", autocomplete: "current-password", required: true });
  const err = h("p", { class: "error", hidden: true });
  const submit = h("button", { class: "btn primary block", type: "submit" }, "Sign in");
  const form = h("form", { class: "card", onsubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      if (await admin.verify(user.value.trim(), pass.value)) {
        admin.signIn();
        if (current()) dashboard(go, setCleanup);
        return;
      }
      err.textContent = "Wrong username or password."; err.hidden = false;
      pass.select();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    submit.disabled = false;
  } },
    h("div", { class: "field" }, h("label", { for: "adm-user" }, "Username"), user),
    h("div", { class: "field" }, h("label", { for: "adm-pass" }, "Password"), pass),
    err, submit,
    admin.isDefault()
      ? h("p", { class: "note" }, `First time? Sign in with `, h("strong", {}, DEFAULT_ADMIN.username), " / ",
        h("strong", {}, DEFAULT_ADMIN.password), ", then change it.")
      : h("p", { class: "muted small center" },
        h("button", { type: "button", class: "link-btn", onclick: () => {
          if (!confirm("Reset the admin login to admin / admin?\n\nFor safety this also deletes the API keys saved on this device. Your teams and chats stay.")) return;
          admin.reset(); toast("Login reset. Sign in with admin / admin and add your keys again."); loginView(go, current, setCleanup);
        } }, "Forgot password?")));
  $app.replaceChildren(page(
    h("div", { class: "topbar" },
      h("button", { class: "icon-btn", "aria-label": "Back", html: icon("back"), onclick: () => go("#/") }),
      h("h1", {}, "Admin")),
    h("p", { class: "muted" }, "API keys and usage for this app."),
    form));
  if (matchMedia("(hover: hover)").matches) user.focus();
}

// ------------------------------------------------------------------ dashboard
async function dashboard(go, setCleanup) {
  const root = page();
  const keysCard = h("section", { class: "card" });
  const usageCard = h("section", { class: "card" });
  const render = async () => {
    renderKeys(keysCard, rerender);
    await renderUsage(usageCard);
  };
  const rerender = () => render().catch((e) => toast(e.message));

  root.append(...[
    h("div", { class: "topbar" },
      h("button", { class: "icon-btn", "aria-label": "Back", html: icon("back"), onclick: () => go("#/") }),
      h("h1", {}, "Admin"),
      h("button", { class: "btn", onclick: () => { admin.signOut(); go("#/"); }, html: `${icon("logout")} Sign out` })),
    admin.isDefault() ? loginCard(true, rerender) : null,
    keysCard, usageCard, settingsCard(),
    admin.isDefault() ? null : loginCard(false, rerender),
    h("p", { class: "note" },
      "Keys are saved only in this browser on this device and are sent only to api.deepseek.com. " +
      "The admin login protects this screen on this device. Anyone who opens the app link on their own device gets an empty app and needs their own key."),
  ].filter(Boolean));
  $app.replaceChildren(root);
  const onCfg = () => { if (root.isConnected) renderKeys(keysCard, rerender); };
  window.addEventListener("musab-config", onCfg);
  setCleanup(() => window.removeEventListener("musab-config", onCfg));
  await render();

  // Refresh balances in the background, then redraw.
  Promise.allSettled(config.keys().map((k) => refreshBalance(k))).then(() => { if (root.isConnected) rerender(); });
}

async function refreshBalance(k) {
  try {
    const b = await checkBalance(k.key);
    config.updateKey(k.id, { balance: b, status: b.available ? "ok" : "no-balance" });
    return b;
  } catch (e) {
    if (e.status === 401) config.updateKey(k.id, { status: "invalid" });
    throw e;
  }
}

// ------------------------------------------------------------------ keys
const STATUS = {
  ok: ["Working", "ok"], invalid: ["Invalid key", "bad"], "no-balance": ["No balance", "warn"], unchecked: ["Not checked", ""],
};

function balanceText(b) {
  if (!b?.infos?.length) return null;
  return b.infos.map((i) => `${i.currency === "USD" ? "$" : i.currency === "CNY" ? "¥" : `${i.currency} `}${Number(i.total_balance).toFixed(2)}`).join(" · ");
}

function renderKeys(card, rerender) {
  const keys = config.keys();
  const active = config.activeKeyId();
  const list = keys.map((k) => {
    const [label, kind] = STATUS[k.status] || STATUS.unchecked;
    const bal = balanceText(k.balance);
    const checkBtn = h("button", { class: "btn small", html: `${icon("refresh")} Check`, onclick: async () => {
      checkBtn.disabled = true;
      try { await refreshBalance(k); toast(`${k.label}: balance updated`); }
      catch (e) { toast(`${k.label}: ${e.message}`); }
      rerender();
    } });
    return h("div", { class: "key-row" },
      h("div", { class: "key-main" },
        h("div", { class: "key-title" }, h("strong", {}, k.label), k.id === active ? pill("Active", "accent") : null, pill(label, kind)),
        h("div", { class: "muted small mono" }, mask(k.key)),
        h("div", { class: "key-balance" }, bal ? [h("span", { class: "muted small" }, "Balance "), h("strong", {}, bal),
          h("span", { class: "muted small" }, ` · checked ${new Date(k.balance.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)]
          : h("span", { class: "muted small" }, "Balance not checked yet")),
        h("div", { class: "key-usage small", "data-key": k.id })),
      h("div", { class: "key-actions" },
        k.id === active ? null : h("button", { class: "btn small", onclick: () => { config.saveSettings({ activeKey: k.id }); toast(`Now using ${k.label}`); rerender(); } }, "Use this key"),
        checkBtn,
        h("button", { class: "btn small danger", onclick: () => {
          if (!confirm(`Remove “${k.label}” from this device? Its usage history stays.`)) return;
          config.removeKey(k.id); rerender();
        } }, "Remove")));
  });

  const label = h("input", { class: "input", id: "key-label", maxlength: 40, placeholder: keys.length ? `Key ${keys.length + 1}` : "Personal", autocomplete: "off" });
  const key = h("input", { class: "input mono", id: "key-value", type: "password", placeholder: "sk-…", autocomplete: "off", spellcheck: "false", required: true });
  const show = h("button", { type: "button", class: "btn", "aria-label": "Show key", html: icon("eye"), onclick: () => { key.type = key.type === "password" ? "text" : "password"; } });
  const err = h("p", { class: "error", hidden: true });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save key");
  const form = h("form", { class: "add-key", onsubmit: async (e) => {
    e.preventDefault();
    const value = key.value.trim();
    err.hidden = true;
    if (!/^sk-[\w-]{8,}$/.test(value)) { err.textContent = "That doesn't look like a DeepSeek key (it starts with sk-)."; err.hidden = false; return; }
    if (config.keys().some((k) => k.key === value)) { err.textContent = "This key is already saved."; err.hidden = false; return; }
    save.disabled = true; save.textContent = "Checking…";
    let balance = null, status = "unchecked";
    try {
      balance = await checkBalance(value);
      status = balance.available ? "ok" : "no-balance";
    } catch (ex) {
      if (ex.status === 401) {
        err.textContent = "DeepSeek says this key is invalid. Check it and try again."; err.hidden = false;
        save.disabled = false; save.textContent = "Save key"; return;
      }
      toast(`Saved, but couldn't check it now: ${ex.message}`);
    }
    const row = config.addKey(label.value.trim(), value);
    config.updateKey(row.id, { balance, status });
    toast(status === "no-balance" ? "Key saved, but it has no balance. Top up at platform.deepseek.com." : "Key saved");
    rerender();
  } },
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "key-label" }, "Name"), label),
      h("div", { class: "field" }, h("label", { for: "key-value" }, "DeepSeek API key"),
        h("div", { class: "input-group" }, key, show))),
    err, save,
    h("p", { class: "muted small" }, "Get a key at ", h("a", { href: "https://platform.deepseek.com/api_keys", target: "_blank", rel: "noopener" }, "platform.deepseek.com"),
      ". With more than one key, agents use the active one and move to the next if a key is invalid or runs out of balance."));

  card.replaceChildren(
    h("div", { class: "card-head" }, h("h2", { html: `${icon("key")} API keys` }), pill(`${keys.length} saved`)),
    keys.length ? h("div", { class: "key-list" }, list) : h("p", { class: "muted" }, "No keys yet. Add your DeepSeek API key so the agents can reply."),
    form);
  fillKeyUsage(card).catch(() => {});
}

async function fillKeyUsage(card) {
  const rows = await db.usageSince(since("d30"));
  const byKey = groupBy(rows, "keyId");
  const today = since("today");
  for (const el of card.querySelectorAll(".key-usage")) {
    const all = byKey.get(el.dataset.key) || [];
    const t = sum(all.filter((r) => r.ts >= today)), m = sum(all);
    el.replaceChildren(
      h("span", {}, h("span", { class: "muted" }, "Today "), `${t.requests} req · ${fmtN(t.input + t.output)} tokens · ${fmtCost(t.cost)}`),
      h("span", {}, h("span", { class: "muted" }, "30 days "), `${m.requests} req · ${fmtN(m.input + m.output)} tokens · ${fmtCost(m.cost)}`));
  }
}

// ------------------------------------------------------------------ usage
async function renderUsage(card) {
  const rows = await db.usageSince(since(period));
  const t = sum(rows);
  const keys = Object.fromEntries(config.keys().map((k) => [k.id, k.label]));
  const teams = Object.fromEntries((await db.teams()).map((x) => [x.id, x.name]));

  const tabs = h("div", { class: "segmented", role: "tablist" }, Object.entries(PERIODS).map(([k, v]) =>
    h("button", { role: "tab", "aria-selected": String(k === period), onclick: () => { period = k; renderUsage(card); } }, v)));

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
        h("td", {}, String(s.requests)),
        h("td", {}, `${fmtN(s.input)} / ${fmtN(s.output)}`), h("td", {}, fmtCost(s.cost)))))));
  };

  card.replaceChildren(...[
    h("div", { class: "card-head" }, h("h2", {}, "Usage"), tabs),
    h("div", { class: "stats" },
      tile("Requests", String(t.requests), t.failed ? `${t.failed} failed` : "all succeeded"),
      tile("Tokens in", fmtN(t.input)),
      tile("Tokens out", fmtN(t.output)),
      tile("Est. cost", fmtCost(t.cost), "USD")),
    await dailyChart(),
    rows.length ? null : h("p", { class: "muted" }, "No requests in this period yet."),
    table("By API key", groupBy(rows, "keyId"), (k) => keys[k] || "Removed key", true),
    table("By team", groupBy(rows, "team"), (k) => teams[k] || k || "Other", false),
    h("p", { class: "muted small" }, "Counted on this device. Cost is estimated from DeepSeek's published prices, including peak and off-peak rates; your real balance is shown on each key."),
    h("button", { class: "link-btn small", onclick: async () => {
      if (!confirm("Clear the usage history on this device? Keys and chats stay.")) return;
      await db.clearUsage(); renderUsage(card);
    } }, "Clear usage history"),
  ].filter(Boolean));
}

async function dailyChart() {
  const days = 14;
  const first = startOfDay(Date.now()) - (days - 1) * 864e5;
  const rows = await db.usageSince(first);
  const byDay = groupBy(rows.map((r) => ({ ...r, day: dayKey(r.ts) })), "day");
  const data = Array.from({ length: days }, (_, i) => {
    const ms = first + i * 864e5 + 3600e3 * 12; // midday avoids DST edges
    const s = sum(byDay.get(dayKey(ms)) || []);
    return { ms, ...s, tokens: s.input + s.output };
  });
  const max = Math.max(...data.map((d) => d.tokens), 1);
  const tip = h("div", { class: "chart-tip", role: "status", hidden: true });
  const label = (d) => new Date(d.ms).toLocaleDateString([], { day: "numeric", month: "short" });
  const show = (d, el) => {
    tip.replaceChildren(h("strong", {}, label(d)), h("span", {}, `${fmtN(d.tokens)} tokens`),
      h("span", {}, `${d.requests} requests · ${fmtCost(d.cost)}`));
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
function settingsCard() {
  const s = config.settings();
  const save = (patch) => { config.saveSettings(patch); toast("Saved"); };
  const model = h("select", { class: "input", id: "set-model", onchange: (e) => save({ model: e.target.value }) },
    Object.entries(MODELS).map(([id, name]) => h("option", { value: id, selected: id === s.model }, name)));
  const num = (id, value, min, max, key) => h("input", { class: "input", id, type: "number", inputmode: "numeric", min, max, value,
    onchange: (e) => {
      const v = Math.max(min, Math.min(max, Math.round(Number(e.target.value) || value)));
      e.target.value = v; save({ [key]: v });
    } });
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Settings")),
    h("div", { class: "field" }, h("label", { for: "set-model" }, "Model for all agents"), model,
      h("span", { class: "hint" }, "Flash costs about a third of Pro. Good for friends chats.")),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "set-hops" }, "Agent-to-agent hops"), num("set-hops", s.maxHops, 1, 12, "maxHops"),
        h("span", { class: "hint" }, "How many times agents can pass a thread between them.")),
      h("div", { class: "field" }, h("label", { for: "set-replies" }, "Max agent replies per thread"), num("set-replies", s.maxReplies, 3, 60, "maxReplies"),
        h("span", { class: "hint" }, "Stops long chains from using too many tokens."))),
    h("label", { class: "switch" },
      h("span", {}, h("strong", {}, "Use the next key if one fails"), h("span", { class: "hint" }, "When a key is invalid or out of balance.")),
      h("input", { type: "checkbox", checked: s.fallback, onchange: (e) => save({ fallback: e.target.checked }) })));
}

// ------------------------------------------------------------------ login details
function loginCard(isDefault, rerender) {
  const user = h("input", { class: "input", id: "new-user", autocomplete: "username", autocapitalize: "off", value: admin.username(), required: true });
  const p1 = h("input", { class: "input", id: "new-pass", type: "password", autocomplete: "new-password", minlength: 6, required: true });
  const p2 = h("input", { class: "input", id: "new-pass2", type: "password", autocomplete: "new-password", required: true });
  const err = h("p", { class: "error", hidden: true });
  const btn = h("button", { class: "btn primary", type: "submit" }, isDefault ? "Change login" : "Save login");
  return h("form", { class: `card ${isDefault ? "warn-card" : ""}`, onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    const u = user.value.trim();
    if (!/^[a-zA-Z0-9._@-]{3,40}$/.test(u)) { err.textContent = "Username: 3 to 40 letters, numbers, . _ @ or -"; err.hidden = false; return; }
    if (p1.value.length < 6) { err.textContent = "Use at least 6 characters for the password."; err.hidden = false; return; }
    if (p1.value === DEFAULT_ADMIN.password) { err.textContent = "Pick a password other than the default."; err.hidden = false; return; }
    if (p1.value !== p2.value) { err.textContent = "The passwords don't match."; err.hidden = false; return; }
    btn.disabled = true;
    try {
      await admin.setLogin(u, p1.value);
      toast("Login saved");
      dashboardRefresh(rerender);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } },
    h("div", { class: "card-head" }, h("h2", {}, isDefault ? "Change the default login" : "Admin login")),
    isDefault ? h("p", { class: "muted" }, "You're still using admin / admin. Pick your own username and password.") : null,
    h("div", { class: "field" }, h("label", { for: "new-user" }, "Username"), user),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "new-pass" }, "New password"), p1),
      h("div", { class: "field" }, h("label", { for: "new-pass2" }, "Repeat password"), p2)),
    err, btn);
}

function dashboardRefresh() {
  // Re-render the whole admin page so the default-login warning disappears.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
