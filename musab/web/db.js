/* On-device storage (IndexedDB "musab"): teams, messages (the bus) and agent memories, plus "meta"
   for this device's own state (the backup folder, see backup.js).
   Admin login, API keys, settings and usage live on the server (see server.js).
   The old "usage" store from earlier versions is left in place but no longer used.
   Every write fires a "musab-data" event on window so backup.js can save a copy. */

const DB_NAME = "musab";
const DB_VERSION = 2;
const DATA = ["teams", "messages", "memories"]; // what a backup holds
let dbPromise = null;
const changed = () => window.dispatchEvent(new Event("musab-data"));

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (e) => {
        const d = r.result;
        if (e.oldVersion < 2) d.createObjectStore("meta");
        if (e.oldVersion >= 1) return;
        d.createObjectStore("teams", { keyPath: "id" });
        const m = d.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        m.createIndex("team_id", ["team", "id"]);
        m.createIndex("thread", ["team", "thread_id", "id"]);
        const mem = d.createObjectStore("memories", { keyPath: "id", autoIncrement: true });
        mem.createIndex("team", "team");
        const u = d.createObjectStore("usage", { keyPath: "id", autoIncrement: true });
        u.createIndex("ts", "ts");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("Close other tabs of this app and reload."));
    });
    try { navigator.storage?.persist?.(); } catch {}
  }
  return dbPromise;
}

const done = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const finished = (t) => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = t.onabort = () => reject(t.error || new Error("transaction aborted"));
});

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

// Collect up to `limit` values from a cursor over `range` (direction "prev" = newest first).
function collect(source, range, limit, direction = "next") {
  return new Promise((resolve, reject) => {
    const out = [];
    const r = source.openCursor(range, direction);
    r.onsuccess = () => {
      const c = r.result;
      if (!c || out.length >= limit) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

// Delete every record an index cursor visits (inside an open readwrite transaction).
function deleteWhere(index, range) {
  const r = index.openKeyCursor(range);
  r.onsuccess = () => { const c = r.result; if (c) { index.objectStore.delete(c.primaryKey); c.continue(); } };
}

// ------------------------------------------------------------------ teams
export const db = {
  async teams() { return done((await store("teams")).getAll()); },
  async team(id) { return done((await store("teams")).get(id)); },
  async saveTeam(team) { const r = await done((await store("teams", "readwrite")).put(team)); changed(); return r; },

  async deleteTeam(id) {
    const d = await open();
    const t = d.transaction(["teams", "messages", "memories"], "readwrite");
    t.objectStore("teams").delete(id);
    deleteWhere(t.objectStore("messages").index("team_id"), IDBKeyRange.bound([id, 0], [id, Infinity]));
    deleteWhere(t.objectStore("memories").index("team"), IDBKeyRange.only(id));
    await finished(t);
    changed();
  },

  /** Clear a team's chat. Members and their memory stay. */
  async clearMessages(id) {
    const t = (await open()).transaction("messages", "readwrite");
    deleteWhere(t.objectStore("messages").index("team_id"), IDBKeyRange.bound([id, 0], [id, Infinity]));
    await finished(t);
    changed();
  },

  // ---------------------------------------------------------------- messages
  /** Post to a team's bus. A message without a parent starts a new thread. `extra` adds fields (e.g. a Threads draft). */
  async post(team, sender, recipients, content, parent = null, extra = null) {
    const clean = [...new Set(recipients.map((r) => String(r).trim().toLowerCase()).filter(Boolean))].sort();
    const msg = {
      team, sender, recipients: clean.length ? clean : ["all"], content,
      parent_id: parent ? parent.id : null, thread_id: parent ? parent.thread_id : null,
      hop: parent ? parent.hop + 1 : 0, created_at: Date.now() / 1000, ...(extra || {}),
    };
    const d = await open();
    const t = d.transaction("messages", "readwrite");
    const s = t.objectStore("messages");
    msg.id = await done(s.add(msg));
    if (!parent) { msg.thread_id = msg.id; s.put(msg); }
    await finished(t);
    changed();
    return msg;
  },

  /** Change fields of one saved message (e.g. a Threads draft after it's edited or posted). */
  async updateMessage(id, patch) {
    const t = (await open()).transaction("messages", "readwrite");
    const s = t.objectStore("messages");
    const m = await done(s.get(id));
    if (m) s.put({ ...m, ...patch, id });
    await finished(t);
    changed();
    return m ? { ...m, ...patch, id } : null;
  },

  async messagesAfter(team, after, limit = 200) {
    const idx = (await store("messages")).index("team_id");
    return collect(idx, IDBKeyRange.bound([team, after + 1], [team, Infinity]), limit);
  },

  async recent(team, limit = 50) {
    const idx = (await store("messages")).index("team_id");
    return (await collect(idx, IDBKeyRange.bound([team, 0], [team, Infinity]), limit, "prev")).reverse();
  },

  async thread(team, threadId, limit = 30) {
    const idx = (await store("messages")).index("thread");
    const range = IDBKeyRange.bound([team, threadId, 0], [team, threadId, Infinity]);
    return (await collect(idx, range, limit, "prev")).reverse();
  },

  async countThreadReplies(team, threadId, agentNames) {
    const idx = (await store("messages")).index("thread");
    const all = await collect(idx, IDBKeyRange.bound([team, threadId, 0], [team, threadId, Infinity]), 10000);
    return all.filter((m) => agentNames.has(m.sender)).length;
  },

  // ---------------------------------------------------------------- memories
  async memories(team) { return done((await store("memories")).index("team").getAll(IDBKeyRange.only(team))); },
  async remember(team, owner, content) {
    const m = { team, owner, content: String(content).trim(), created_at: Date.now() / 1000 };
    m.id = await done((await store("memories", "readwrite")).add(m));
    changed();
    return m;
  },
  /** Delete one member's private memories (team memory stays). */
  async deleteMemories(team, owner) {
    const t = (await open()).transaction("memories", "readwrite");
    const s = t.objectStore("memories");
    const r = s.index("team").openCursor(IDBKeyRange.only(team));
    r.onsuccess = () => { const c = r.result; if (c) { if (c.value.owner === owner) c.delete(); c.continue(); } };
    await finished(t);
    changed();
  },
  async forget(team, owners, id) {
    const s = await store("memories", "readwrite");
    const m = await done(s.get(Number(id)));
    if (!m || m.team !== team || !owners.includes(m.owner)) return false;
    await done(s.delete(Number(id)));
    changed();
    return true;
  },

  // ---------------------------------------------------------------- whole-device copy (backup.js)
  /** Every team, message and memory on this device. */
  async dump() {
    const t = (await open()).transaction(DATA);
    const [teams, messages, memories] = await Promise.all(DATA.map((n) => done(t.objectStore(n).getAll())));
    return { teams, messages, memories };
  },
  /** Replace every team, message and memory on this device with `data` (from dump()). */
  async load(data) {
    const t = (await open()).transaction(DATA, "readwrite");
    for (const n of DATA) {
      const s = t.objectStore(n);
      s.clear();
      for (const row of data[n]) s.put(row);
    }
    await finished(t);
    changed();
  },

  // ---------------------------------------------------------------- this device's own state
  async meta(key) { return done((await store("meta")).get(key)); },
  async setMeta(key, value) {
    const s = await store("meta", "readwrite");
    return done(value === undefined ? s.delete(key) : s.put(value, key));
  },
};
