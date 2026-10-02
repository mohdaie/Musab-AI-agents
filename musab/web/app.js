/* Musab Agents PWA: create a team of agents, then chat with them. No framework.
   Teams, chats and agent memory are stored on this device; the admin login, API keys, settings and
   usage are on the server, which also relays the agents' DeepSeek requests (server.js). */
import { adminView } from "./admin.js";
import { db } from "./db.js";
import { Engine, TALK, TALK_LEVELS, addMember, createTeam, removeMember, setAgentSkills, setAgentTalk } from "./engine.js";
import { session, skills, syncSettings, syncSkills } from "./server.js";
import { $app, $banner, $sheet, appbar, avatar, colorFor, fmtTime, groupAvatar, h, icon, richText, toast } from "./ui.js";

// ------------------------------------------------------------------ data (all on this device)
const engine = new Engine();

async function teamsWithLast() {
  const teams = await db.teams();
  for (const t of teams) t.last_message = (await db.recent(t.id, 1))[0] || null;
  return teams.sort((a, b) => (b.last_message?.created_at || b.created_at || 0) - (a.last_message?.created_at || a.created_at || 0));
}

function checkStatus() {
  const msg = !session.signedIn() ? "Agents can't reply yet. Sign in to Admin on this device."
    : session.mustChange() ? "Set your own admin password before the agents can reply." : "";
  $banner.hidden = !msg || location.hash.startsWith("#/admin");
  if (msg) $banner.replaceChildren(msg, " ", h("a", { href: "#/admin" }, "Open Admin"));
}
window.addEventListener("musab-session", checkStatus);
window.addEventListener("hashchange", checkStatus);

// ------------------------------------------------------------------ router
let cleanup = null;
let routeSeq = 0; // async views draw only if they are still the current route
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const seq = ++routeSeq;
  const current = () => seq === routeSeq;
  if ($sheet.open) $sheet.close();
  window.scrollTo(0, 0);
  const [, view, id] = location.hash.split("/");
  if (view === "new") return wizard.start();
  if (view === "admin") return adminView({ go, current, setCleanup: (fn) => { if (current()) cleanup = fn; else fn(); } });
  if (view === "team" && id) return chatView(decodeURIComponent(id), current);
  return homeView(current);
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ home
async function homeView(current) {
  $app.replaceChildren(h("div", { class: "spinner" }));
  let teams;
  try { teams = await teamsWithLast(); } catch (e) {
    if (!current()) return;
    $app.replaceChildren(h("div", { class: "page" }, h("p", { class: "error" }, `Can't open this device's storage: ${e.message}`),
      h("button", { class: "btn", onclick: route }, "Try again")));
    return;
  }
  if (!current()) return;
  const adminBtn = h("button", { class: "icon-btn", "aria-label": "Admin", title: "Admin", html: icon("admin"), onclick: () => go("#/admin") });
  const body = h("div", { class: "content list" });
  if (!teams.length) {
    body.append(h("div", { class: "hero" },
      h("img", { class: "logo", src: "icons/icon-192.png", alt: "" }),
      h("h2", {}, "Build your AI team"),
      h("p", {}, "Pick how many agents you want, give each one a designation and what they're good at, then chat with all of them in one group. Make it a team of engineers or a group of friends."),
      h("button", { class: "btn primary", onclick: () => go("#/new"), html: `${icon("plus")} Create a team` })));
  } else {
    const list = h("ul", { class: "chat-list" });
    const draw = (filter) => {
      const shown = teams.filter((t) => filter === "all" || t.style === filter);
      list.replaceChildren(...(shown.length ? shown.map((t) => {
        const last = t.last_message;
        const who = last ? (last.sender === "user" ? "You" : last.sender === "system" ? "" : last.sender) : "";
        const preview = last ? `${who ? `${who}: ` : ""}${last.content}` : t.agents.map((a) => a.name).join(", ");
        return h("li", {}, h("button", { class: "chat-row", onclick: () => go(`#/team/${encodeURIComponent(t.id)}`) },
          groupAvatar(t, "lg"),
          h("span", { class: "chat-row-main" },
            h("span", { class: "chat-row-top" }, h("strong", {}, t.name), h("small", {}, last ? fmtTime(last.created_at) : "")),
            h("span", { class: "chat-row-bottom" },
              h("span", { class: "preview" }, preview),
              h("span", { class: "tag" }, t.style === "friends" ? "Friends" : "Team")))));
      }) : [h("li", { class: "list-empty" }, "Nothing here yet.")]));
    };
    const chips = [["all", "All"], ["work", "Teams"], ["friends", "Friends"]].map(([k, label]) =>
      h("button", { "aria-pressed": String(k === "all"), onclick: (e) => {
        chips.forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget))); draw(k);
      } }, label));
    draw("all");
    body.append(h("div", { class: "filters" }, chips), list);
  }
  $app.replaceChildren(h("div", { class: "screen" },
    appbar({ title: "Musab Agents", actions: [adminBtn], cls: "home" }),
    body,
    h("button", { class: "fab", "aria-label": "New team", title: "New team", html: icon("plus"), onclick: () => go("#/new") })));
}

/** Light / Balanced / Detailed switch for one agent. */
function levelPicker(value, onchange, label = "How much this agent talks") {
  const box = h("div", { class: "level", role: "radiogroup", "aria-label": label });
  const hint = h("small", { class: "level-hint" }, TALK[value]?.desc || "");
  const draw = (v) => {
    box.replaceChildren(...TALK_LEVELS.map((k) => h("button", { type: "button", role: "radio", "aria-checked": String(k === v),
      onclick: async () => { if (k === v) return; if ((await onchange(k)) !== false) { v = k; hint.textContent = TALK[k].desc; draw(k); } } }, TALK[k].label)));
  };
  draw(value);
  return h("div", { class: "level-field" }, box, hint);
}
/** A member's skills: chips, and a checklist of every skill from Admin → Skills to change them. */
function skillsPicker(team, a) {
  const box = h("div", { class: "skills-field" });
  const view = () => {
    const mine = (a.skillIds || []).map((id) => skills.byId(id)).filter(Boolean);
    box.replaceChildren(
      h("div", { class: "skill-chips" },
        h("span", { class: "label-sm" }, "Skills"),
        mine.length ? mine.map((k) => h("span", { class: "skill-chip", title: k.description }, k.name)) : h("span", { class: "muted small" }, "none"),
        h("button", { type: "button", class: "link-btn small", "aria-label": `Edit skills of ${a.name}`, onclick: edit }, mine.length ? "Edit" : "Add")));
  };
  const edit = async () => {
    await syncSkills();
    const all = skills.all();
    if (!all.length) {
      box.replaceChildren(h("p", { class: "muted small" }, "No skills yet. Add them in ", h("a", { href: "#/admin" }, "Admin → Skills"), ", from a GitHub repo or your own."));
      return;
    }
    const chosen = new Set(a.skillIds || []);
    box.replaceChildren(h("div", { class: "skill-pick" },
      all.map((k) => h("label", { class: "skill-option" },
        h("input", { type: "checkbox", checked: chosen.has(k.id), onchange: (e) => (e.target.checked ? chosen.add(k.id) : chosen.delete(k.id)) }),
        h("span", {}, h("strong", {}, k.name), h("small", {}, k.description || "")))),
      h("div", { class: "footer-actions" },
        h("button", { type: "button", class: "btn small", onclick: view }, "Cancel"),
        h("button", { type: "button", class: "btn small primary", onclick: async () => {
          try { await setAgentSkills(team.id, a.name, [...chosen]); a.skillIds = [...chosen]; toast(`@${a.name}: ${chosen.size} skill${chosen.size === 1 ? "" : "s"}`); view(); }
          catch (e) { toast(e.message); }
        } }, "Save"))));
  };
  view();
  return box;
}

const defaultLevel = () => (TALK[session.settings().talk] ? session.settings().talk : "balanced");

// ------------------------------------------------------------------ wizard
const KINDS = {
  work: {
    title: "Team of engineers", desc: "Specialists who solve problems together and hand work to each other.",
    names: ["alex", "maya", "omar", "lina", "sam", "zara", "ivan", "nora", "ken", "aisha", "leo", "tara"],
    role: "e.g. Database administrator", about: "e.g. SQL Server and PostgreSQL tuning, backups. Careful, always asks for evidence first.",
    example: [
      ["zu", "Windows infrastructure admin", "Servers, event logs, patching and performance counters. Terse and practical, asks for the exact error text."],
      ["charles", "Database administrator", "SQL Server, PostgreSQL and MySQL. Wants query plans, wait stats and backups confirmed before touching production."],
      ["mike", "Active Directory expert", "DNS, replication, Kerberos and Group Policy. Always says which DC, site and account is involved."],
      ["nina", "Network engineer", "Firewalls, VLANs, routing and VPNs. Checks packet captures before blaming the network."],
      ["sara", "Security analyst", "Threat hunting, hardening and incident response. Questions every change for risk."],
      ["dev", "Software developer", "Python and JavaScript, APIs and debugging. Likes small, testable fixes."],
    ],
  },
  friends: {
    title: "Group of friends", desc: "A casual group chat with different personalities.",
    names: ["amir", "jess", "danny", "sofia", "ray", "mei", "tom", "nadia", "max", "ella", "kai", "rina"],
    role: "e.g. The joker", about: "e.g. Loves football and bad puns, always optimistic, teases everyone.",
    example: [
      ["amir", "The joker", "Loves bad puns and football. Never serious for long, but always has your back."],
      ["jess", "The foodie", "Knows every good restaurant in town and has a strong opinion about all of them."],
      ["danny", "The gamer", "Up all night playing games, explains everything with game references."],
      ["sofia", "The wise one", "Calm, gives thoughtful advice, asks how you're really doing."],
      ["ray", "The gym bro", "Fitness obsessed, motivational, turns every problem into a workout plan."],
      ["mei", "The traveller", "Has been everywhere, always planning the next trip, shares travel stories."],
    ],
  },
};

const wizard = {
  state: null,
  fresh() { return { step: 1, name: "", style: "work", count: 3, agents: [], error: "" }; },
  start() {
    if (!this.state) this.state = this.fresh();
    this.render();
  },
  agentsFor(count) {
    const s = this.state, k = KINDS[s.style];
    while (s.agents.length < count) s.agents.push({ name: "", role: "", about: "", talk: defaultLevel() });
    s.agents.length = count;
    s.agents.forEach((a, i) => (a.placeholder = k.names[i % k.names.length] + (i >= k.names.length ? i + 1 : "")));
  },
  render() {
    const s = this.state;
    const page = h("div", { class: "content" });
    page.append(h("div", { class: "steps" }, h("span", { class: "on" }), h("span", { class: s.step === 2 ? "on" : "" })));
    page.append(s.step === 1 ? this.step1() : this.step2());
    $app.replaceChildren(h("div", { class: "screen" },
      appbar({ title: s.step === 1 ? "Create a team" : "Your agents", subtitle: `Step ${s.step} of 2`,
        back: () => (s.step === 2 ? (s.step = 1, s.error = "", this.render()) : (this.state = null, go("#/"))) }),
      page));
    const first = page.querySelector("input");
    if (first && !first.value && matchMedia("(hover: hover)").matches) first.focus();
  },
  step1() {
    const s = this.state;
    const nameIn = h("input", { class: "input", id: "team-name", maxlength: 60, autocomplete: "off",
      placeholder: s.style === "friends" ? "e.g. The Squad" : "e.g. IT Ops Team", value: s.name,
      oninput: (e) => (s.name = e.target.value) });
    const out = h("output", {}, String(s.count));
    const minus = h("button", { type: "button", "aria-label": "Fewer agents", disabled: s.count <= 1, onclick: () => setCount(s.count - 1) }, "−");
    const plus = h("button", { type: "button", "aria-label": "More agents", disabled: s.count >= 12, onclick: () => setCount(s.count + 1) }, "+");
    const setCount = (n) => {
      s.count = Math.max(1, Math.min(12, n));
      out.textContent = s.count; minus.disabled = s.count <= 1; plus.disabled = s.count >= 12;
    };
    const choice = (key) => h("button", { type: "button", class: "choice", "aria-pressed": String(s.style === key),
      onclick: () => { s.style = key; this.render(); } },
      h("span", { html: icon(key) }), h("strong", {}, KINDS[key].title), h("small", {}, KINDS[key].desc));
    const err = h("p", { class: "error", hidden: !s.error }, s.error);
    return h("form", { onsubmit: (e) => {
      e.preventDefault();
      if (!s.name.trim()) { s.error = "Give your team a name."; err.textContent = s.error; err.hidden = false; nameIn.focus(); return; }
      s.error = ""; this.agentsFor(s.count); s.step = 2; this.render();
    } },
      h("div", { class: "field" }, h("label", { for: "team-name" }, "Team name"), nameIn),
      h("div", { class: "field" }, h("span", { class: "label" }, "What kind of team?"),
        h("div", { class: "choices" }, choice("work"), choice("friends"))),
      h("div", { class: "field" }, h("span", { class: "label" }, "How many agents?"),
        h("div", {}, h("span", { class: "stepper" }, minus, out, plus))),
      err,
      h("button", { class: "btn primary block", type: "submit" }, "Next"));
  },
  step2() {
    const s = this.state, k = KINDS[s.style];
    const cards = s.agents.map((a, i) => {
      const id = (f) => `a${i}-${f}`;
      const av = avatar(a.name || a.placeholder);
      const handle = h("input", { class: "input", id: id("name"), maxlength: 32, autocomplete: "off", autocapitalize: "off",
        spellcheck: "false", placeholder: a.placeholder, value: a.name,
        oninput: (e) => {
          e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
          a.name = e.target.value;
          const n = avatar(a.name || a.placeholder); av.replaceWith(n);
        } });
      return h("section", { class: "agent-card" },
        h("header", {}, av, h("h3", {}, `Agent #${i + 1}`)),
        h("div", { class: "row" },
          h("div", { class: "field" }, h("label", { for: id("name") }, "Name"), h("div", { class: "handle" }, handle)),
          h("div", { class: "field" }, h("label", { for: id("role") }, "Designation"),
            h("input", { class: "input", id: id("role"), maxlength: 120, required: true, placeholder: k.role, value: a.role,
              oninput: (e) => (a.role = e.target.value) }))),
        h("div", { class: "field" },
          h("label", { for: id("about") }, s.style === "friends" ? "Personality" : "Expert at / characteristic"),
          h("textarea", { class: "textarea", id: id("about"), maxlength: 2000, placeholder: k.about,
            oninput: (e) => (a.about = e.target.value) }, a.about)),
        h("div", { class: "field" }, h("span", { class: "label" }, "How much they talk"),
          levelPicker(a.talk || defaultLevel(), (k) => { a.talk = k; })));
    });
    const err = h("p", { class: "error", hidden: !s.error }, s.error);
    const submit = h("button", { class: "btn primary", type: "submit" }, "Create team");
    return h("form", { onsubmit: async (e) => {
      e.preventDefault();
      const agents = s.agents.map((a) => ({ name: a.name || a.placeholder, role: a.role.trim(), about: a.about.trim(), talk: a.talk }));
      const missing = agents.findIndex((a) => !a.role);
      if (missing >= 0) { s.error = `Agent #${missing + 1} needs a designation.`; }
      else if (new Set(agents.map((a) => a.name)).size !== agents.length) { s.error = "Each agent needs a different name."; }
      else s.error = "";
      if (s.error) { err.textContent = s.error; err.hidden = false; err.scrollIntoView({ block: "center" }); return; }
      submit.disabled = true; submit.textContent = "Saving…";
      try {
        const team = await createTeam({ name: s.name.trim(), style: s.style, agents });
        this.state = null;
        go(`#/team/${encodeURIComponent(team.id)}`);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false; submit.disabled = false; submit.textContent = "Create team";
      }
    } },
      h("p", { class: "hint", style: "margin:0 0 14px;color:var(--muted)" },
        `${s.agents.length} agent${s.agents.length > 1 ? "s" : ""} in “${s.name.trim()}”. `,
        h("button", { type: "button", class: "link-btn", onclick: () => {
          s.agents.forEach((a, i) => {
            const ex = k.example[i];
            if (ex) [a.name, a.role, a.about] = ex;
          });
          this.render();
        } }, "Fill with examples")),
      cards, err,
      h("div", { class: "footer-actions" },
        h("button", { class: "btn", type: "button", onclick: () => { s.step = 1; s.error = ""; this.render(); } }, "Back"),
        submit));
  },
};

// ------------------------------------------------------------------ chat
async function chatView(id, current) {
  $app.replaceChildren(h("div", { class: "spinner" }));
  let team;
  try { team = await db.team(id); } catch {}
  if (!current()) return;
  if (!team) {
    $app.replaceChildren(h("div", { class: "page" }, h("p", { class: "error" }, "This team doesn't exist on this device."),
      h("button", { class: "btn", onclick: () => go("#/") }, "Back to teams")));
    return;
  }
  const names = new Set(team.agents.map((a) => a.name));
  const roles = Object.fromEntries(team.agents.map((a) => [a.name, a.role]));
  let lastId = 0, prev = null, alive = true, timer = null, pollMs = 2000;

  const list = h("div", { class: "messages-inner" });
  const scroller = h("div", { class: "messages" }, list);
  const input = h("textarea", { rows: 1, maxlength: 8000, "aria-label": "Message", placeholder: "Message" });
  const sendBtn = h("button", { class: "send", "aria-label": "Send", html: icon("send"), disabled: true });
  const memberNames = `${team.agents.map((a) => a.name).join(", ")}, You`;
  const subtitle = h("small", { class: "subtitle" }, memberNames);
  const bar = appbar({ title: team.name, subtitle: "", back: () => go("#/"), avatarEl: groupAvatar(team), onTitle: () => teamSheet(team),
    actions: [h("button", { class: "icon-btn", "aria-label": "Team info", html: icon("more"), onclick: () => teamSheet(team) })] });
  bar.querySelector(".appbar-text small").replaceWith(subtitle);

  // Typing "@" shows the members to pick from, like mentions in a group chat.
  const mentions = h("div", { class: "mention-pop", role: "listbox", hidden: true });
  function mentionQuery() {
    const before = input.value.slice(0, input.selectionStart);
    const m = /(^|\s)@([\w-]*)$/.exec(before);
    return m ? m[2].toLowerCase() : null;
  }
  function showMentions() {
    const q = mentionQuery();
    const hits = q == null ? [] : team.agents.filter((a) => a.name.startsWith(q));
    mentions.hidden = !hits.length;
    mentions.replaceChildren(...hits.map((a) => h("button", { type: "button", role: "option", class: "mention-item",
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        const pos = input.selectionStart, before = input.value.slice(0, pos).replace(/@[\w-]*$/, `@${a.name} `);
        input.value = before + input.value.slice(pos);
        input.setSelectionRange(before.length, before.length);
        mentions.hidden = true; input.focus(); autosize(); sendBtn.disabled = !input.value.trim();
      } }, avatar(a.name, "sm"), h("span", {}, h("strong", {}, a.name), h("small", {}, a.role)))));
  }

  const form = h("form", { class: "composer" }, mentions, h("div", { class: "composer-inner" }, h("div", { class: "pill-input" }, input), sendBtn));
  $app.replaceChildren(h("div", { class: "chat" }, bar, scroller, form));

  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  input.addEventListener("input", () => { autosize(); sendBtn.disabled = !input.value.trim(); showMentions(); });
  input.addEventListener("click", showMentions);
  input.addEventListener("blur", () => setTimeout(() => (mentions.hidden = true), 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) {
      e.preventDefault(); form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const m = await engine.post(id, text);
      input.value = ""; autosize();
      add([m]); poll(true);
    } catch (ex) { toast(ex.message); sendBtn.disabled = false; }
  });

  function emptyState() {
    const ideas = team.style === "friends"
      ? ["Hey everyone! How was your week?", "Where should we go for dinner tonight?", "Settle this: pineapple on pizza?"]
      : ["Introduce yourselves and what you're best at.", "Users say the file server is slow and can't log in. Where do we start?", "Review our backup plan for weak spots."];
    return h("div", { class: "empty-chat" },
      h("h3", {}, team.style === "friends" ? "Say hi to the group" : "Start the discussion"),
      h("p", {}, "A message goes to the group. Type @ to talk to one person."),
      h("div", { class: "suggestions" }, ideas.map((t) => h("button", { onclick: () => {
        input.value = t; autosize(); sendBtn.disabled = false; input.focus();
      } }, t))));
  }

  const dayLabel = (ts) => {
    const d = new Date(ts * 1000), today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
    return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
  };
  let lastDay = "";
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function add(msgs) {
    msgs = msgs.filter((m) => m.id > lastId);
    if (!msgs.length) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (!lastId) list.replaceChildren();
    for (const m of msgs) {
      lastId = m.id;
      const day = dayLabel(m.created_at);
      if (day !== lastDay) { list.append(h("div", { class: "day" }, h("span", {}, day))); lastDay = day; prev = null; }
      if (m.sender === "system") { list.append(h("div", { class: "sys" }, h("span", {}, m.content))); prev = null; continue; }
      const mine = m.sender === "user";
      const grouped = prev && prev.sender === m.sender && m.created_at - prev.created_at < 300;
      const to = m.recipients.filter((r) => r !== "all" && r !== "user" && r !== m.sender);
      const showTo = !mine ? to : m.recipients.filter((r) => r !== "all");
      const who = mine ? (showTo.length ? h("div", { class: "who" }, h("span", { class: "to" }, "to " + showTo.map((r) => "@" + r).join(" "))) : null)
        : grouped && !to.length ? null
        : h("div", { class: "who" }, h("span", { class: "name", style: `color:${colorFor(m.sender)}` }, m.sender),
            roles[m.sender] && !grouped ? h("span", { class: "to" }, `~ ${roles[m.sender]}`) : null,
            to.length ? h("span", { class: "to" }, "→ " + to.map((r) => "@" + r).join(" ")) : null);
      list.append(h("div", { class: `msg ${mine ? "mine" : ""} ${grouped ? "cont" : "first"}` },
        mine ? null : h("span", { class: "avatar-slot" }, grouped ? null : avatar(m.sender)),
        h("div", { class: "bubble" }, who,
          h("div", { class: "text", html: richText(m.content, names) }),
          h("span", { class: "meta" },
            h("time", { datetime: new Date(m.created_at * 1000).toISOString() }, clock(m.created_at)),
            mine ? h("span", { class: "ticks", "aria-label": "Sent", html: icon("check2") }) : null))));
      prev = m;
    }
    if (nearBottom || msgs.some((m) => m.sender === "user")) scroller.scrollTop = scroller.scrollHeight;
  }

  // Like a group chat: "jess is typing…" replaces the member list under the group name.
  function setBusy(busy) {
    subtitle.classList.toggle("typing", busy.length > 0);
    subtitle.textContent = busy.length > 2 ? `${busy.length} people are typing…`
      : busy.length ? `${busy.join(" and ")} ${busy.length > 1 ? "are" : "is"} typing…` : memberNames;
  }

  async function poll(once = false) {
    if (!once) clearTimeout(timer);
    try {
      const msgs = await db.messagesAfter(id, lastId);
      if (!alive) return;
      add(msgs); setBusy(engine.busyIn(id));
      pollMs = 2000;
    } catch { pollMs = Math.min(pollMs * 2, 15000); }
    if (!once && alive) timer = setTimeout(poll, document.hidden ? 10000 : pollMs);
  }
  const onVis = () => { if (!document.hidden) poll(); };
  const onChange = (e) => { if (e.detail.team === id) { setBusy(engine.busyIn(id)); poll(true); } };
  document.addEventListener("visibilitychange", onVis);
  engine.addEventListener("change", onChange);
  cleanup = () => {
    alive = false; clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVis);
    engine.removeEventListener("change", onChange);
  };

  // first load: last 200 messages
  try {
    const msgs = await db.recent(id, 200);
    if (msgs.length) add(msgs); else list.replaceChildren(emptyState());
    setBusy(engine.busyIn(id));
    scroller.scrollTop = scroller.scrollHeight;
  } catch (e) { toast(e.message); }
  timer = setTimeout(poll, pollMs);
}

/** Open the team sheet with the team as it is saved now (levels and members may have changed). */
async function teamSheet(team) {
  let fresh = null;
  try { fresh = await db.team(team.id); } catch {}
  drawTeamSheet(fresh || team);
}

function drawTeamSheet(team) {
  const friends = team.style === "friends";
  const kind = KINDS[team.style];
  // Re-open the chat so the header, name chips and messages show the change, then the sheet again.
  const refresh = async (msg) => { toast(msg); $sheet.close(); route(); const t = await db.team(team.id); if (t) setTimeout(() => teamSheet(t), 50); };

  const addForm = () => {
    const taken = new Set(team.agents.map((a) => a.name));
    const placeholder = kind.names.find((n) => !taken.has(n)) || `agent${team.agents.length + 1}`;
    const name = h("input", { class: "input", id: "add-name", maxlength: 32, autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder,
      oninput: (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""); } });
    const role = h("input", { class: "input", id: "add-role", maxlength: 120, placeholder: kind.role, required: true });
    const about = h("textarea", { class: "textarea", id: "add-about", maxlength: 2000, placeholder: kind.about });
    let level = defaultLevel();
    const err = h("p", { class: "error", hidden: true });
    const save = h("button", { class: "btn primary", type: "submit" }, "Add");
    return h("form", { class: "add-member", onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await addMember(team.id, { name: name.value || placeholder, role: role.value, about: about.value, talk: level });
        refresh(`@${name.value || placeholder} joined`);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; }
    } },
      h("h3", {}, friends ? "Add a friend" : "Add a team member"),
      h("div", { class: "row" },
        h("div", { class: "field" }, h("label", { for: "add-name" }, "Name"), h("div", { class: "handle" }, name)),
        h("div", { class: "field" }, h("label", { for: "add-role" }, "Designation"), role)),
      h("div", { class: "field" }, h("label", { for: "add-about" }, friends ? "Personality" : "Expert at / characteristic"), about),
      h("div", { class: "field" }, h("span", { class: "label" }, "How much they talk"), levelPicker(level, (k) => { level = k; })),
      err,
      h("div", { class: "footer-actions" },
        h("button", { class: "btn", type: "button", onclick: () => form.replaceWith(addBtn) }, "Cancel"), save));
  };
  let form;
  const addBtn = h("button", { class: "btn block", disabled: team.agents.length >= 12, html: `${icon("plus")} ${friends ? "Add a friend" : "Add a member"}`,
    onclick: () => { form = addForm(); addBtn.replaceWith(form); form.querySelector("#add-role").focus(); } });

  const body = h("div", { class: "sheet-body" },
    h("h2", {}, team.name),
    h("p", { class: "sub" }, `${friends ? "Group of friends" : "Team of engineers"} · ${team.agents.length} member${team.agents.length > 1 ? "s" : ""}`),
    team.agents.map((a) => h("div", { class: "member-row" }, avatar(a.name, "lg"),
      h("div", { class: "member-info" }, h("strong", {}, "@" + a.name), h("div", { class: "role" }, a.role), a.persona ? h("p", {}, a.persona) : null,
        levelPicker(a.talk || defaultLevel(), async (k) => {
          try { await setAgentTalk(team.id, a.name, k); a.talk = k; toast(`@${a.name}: ${TALK[k].label}`); return true; }
          catch (e) { toast(e.message); return false; }
        }, `How much @${a.name} talks`),
        skillsPicker(team, a)),
      h("button", { class: "btn small danger", "aria-label": `Remove ${a.name}`, disabled: team.agents.length <= 1,
        title: team.agents.length <= 1 ? "A team needs at least one member" : "", onclick: async () => {
          if (!confirm(`Remove @${a.name} from “${team.name}”? Their own memory is deleted; their old messages stay in the chat.`)) return;
          try { await removeMember(team.id, a.name); refresh(`@${a.name} removed`); } catch (e) { toast(e.message); }
        } }, "Remove"))),
    addBtn,
    h("h3", { class: "danger-title" }, "Delete"),
    h("div", { class: "footer-actions" },
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Clear the whole chat in “${team.name}”? The members and what they remember stay. This can't be undone.`)) return;
        try { await db.clearMessages(team.id); toast("Chat cleared"); $sheet.close(); route(); } catch (e) { toast(e.message); }
      } }, "Clear chat"),
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Delete “${team.name}” with all its members, chat and memory? This can't be undone.`)) return;
        try { await db.deleteTeam(team.id); $sheet.close(); go("#/"); toast("Team deleted"); } catch (e) { toast(e.message); }
      } }, "Delete team")),
    h("button", { class: "btn primary block close-sheet", onclick: () => $sheet.close() }, "Close"));
  $sheet.replaceChildren(body);
  if (!$sheet.open) $sheet.showModal();
}
$sheet.addEventListener("click", (e) => { if (e.target === $sheet) $sheet.close(); });

// ------------------------------------------------------------------ boot
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
checkStatus();
route();
syncSettings(); // pick up settings changed on another device
