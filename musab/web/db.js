/* On-device storage. Everything lives in this browser; nothing goes to a server except the
   DeepSeek requests themselves.
   - IndexedDB "musab": teams, messages (the bus), memories, usage (one row per API request)
   - localStorage: API keys, settings, admin login (small values) */

const DB_NAME = "musab";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
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
  async saveTeam(team) { return done((await store("teams", "readwrite")).put(team)); },

  async deleteTeam(id) {
    const d = await open();
    const t = d.transaction(["teams", "messages", "memories"], "readwrite");
    t.objectStore("teams").delete(id);
    deleteWhere(t.objectStore("messages").index("team_id"), IDBKeyRange.bound([id, 0], [id, Infinity]));
    deleteWhere(t.objectStore("memories").index("team"), IDBKeyRange.only(id));
    await finished(t);
  },

  /** Clear a team's chat. Members and their memory stay. */
  async clearMessages(id) {
    const t = (await open()).transaction("messages", "readwrite");
    deleteWhere(t.objectStore("messages").index("team_id"), IDBKeyRange.bound([id, 0], [id, Infinity]));
    await finished(t);
  },

  // ---------------------------------------------------------------- messages
  /** Post to a team's bus. A message without a parent starts a new thread. */
  async post(team, sender, recipients, content, parent = null) {
    const clean = [...new Set(recipients.map((r) => String(r).trim().toLowerCase()).filter(Boolean))].sort();
    const msg = {
      team, sender, recipients: clean.length ? clean : ["all"], content,
      parent_id: parent ? parent.id : null, thread_id: parent ? parent.thread_id : null,
      hop: parent ? parent.hop + 1 : 0, created_at: Date.now() / 1000,
    };
    const d = await open();
    const t = d.transaction("messages", "readwrite");
    const s = t.objectStore("messages");
    msg.id = await done(s.add(msg));
    if (!parent) { msg.thread_id = msg.id; s.put(msg); }
    await finished(t);
    return msg;
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
    return m;
  },
  /** Delete one member's private memories (team memory stays). */
  async deleteMemories(team, owner) {
    const t = (await open()).transaction("memories", "readwrite");
    const s = t.objectStore("memories");
    const r = s.index("team").openCursor(IDBKeyRange.only(team));
    r.onsuccess = () => { const c = r.result; if (c) { if (c.value.owner === owner) c.delete(); c.continue(); } };
    await finished(t);
  },
  async forget(team, owners, id) {
    const s = await store("memories", "readwrite");
    const m = await done(s.get(Number(id)));
    if (!m || m.team !== team || !owners.includes(m.owner)) return false;
    await done(s.delete(Number(id)));
    return true;
  },

  // ---------------------------------------------------------------- usage
  async addUsage(row) { return done((await store("usage", "readwrite")).add(row)); },
  async usageSince(ts = 0) {
    return done((await store("usage")).index("ts").getAll(IDBKeyRange.lowerBound(ts)));
  },
  async clearUsage() { return done((await store("usage", "readwrite")).clear()); },
};

// ------------------------------------------------------------------ small settings in localStorage
function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function emit() { try { window.dispatchEvent(new CustomEvent("musab-config")); } catch {} }

export const DEFAULT_SETTINGS = { model: "deepseek-v4-pro", maxHops: 6, maxReplies: 20, fallback: true };

export const config = {
  settings() { return { ...DEFAULT_SETTINGS, ...readJSON("musab.settings", {}) }; },
  saveSettings(s) { writeJSON("musab.settings", { ...this.settings(), ...s }); emit(); },

  /** [{id, label, key, created_at, status, balance}] */
  keys() { const k = readJSON("musab.keys", []); return Array.isArray(k) ? k : []; },
  saveKeys(keys) { writeJSON("musab.keys", keys); emit(); },
  activeKeyId() {
    const keys = this.keys(), id = this.settings().activeKey;
    return keys.some((k) => k.id === id) ? id : keys[0]?.id || null;
  },
  addKey(label, key) {
    const keys = this.keys();
    const row = { id: crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2),
      label: label || `Key ${keys.length + 1}`, key, created_at: Date.now(), status: "unchecked", balance: null };
    keys.push(row);
    this.saveKeys(keys);
    if (keys.length === 1) this.saveSettings({ activeKey: row.id });
    return row;
  },
  updateKey(id, patch) { this.saveKeys(this.keys().map((k) => (k.id === id ? { ...k, ...patch } : k))); },
  removeKey(id) {
    this.saveKeys(this.keys().filter((k) => k.id !== id));
    if (this.settings().activeKey === id) this.saveSettings({ activeKey: this.keys()[0]?.id || null });
  },
  /** Keys in the order to try them: active first, then the rest (if fallback is on).
      Keys that last failed (invalid / no balance) go to the back but are still tried as a last resort. */
  keyOrder() {
    const keys = this.keys(), active = this.activeKeyId();
    const first = keys.filter((k) => k.id === active);
    if (!this.settings().fallback) return first;
    const bad = (k) => (k.status === "invalid" || k.status === "no-balance" ? 1 : 0);
    return [...first, ...keys.filter((k) => k.id !== active)].sort((a, b) => bad(a) - bad(b));
  },
};

// ------------------------------------------------------------------ admin login (this device only)
const ADMIN_KEY = "musab.admin";
const SESSION_KEY = "musab.adminUntil";
export const DEFAULT_ADMIN = { username: "admin", password: "admin" };

async function pbkdf2(password, saltHex, iterations) {
  if (!crypto.subtle) throw new Error("Open the app over HTTPS (or localhost) to manage the admin password.");
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const admin = {
  isDefault() { return !readJSON(ADMIN_KEY, null); },
  username() { return readJSON(ADMIN_KEY, null)?.username || DEFAULT_ADMIN.username; },
  async verify(username, password) {
    const saved = readJSON(ADMIN_KEY, null);
    if (!saved) return username === DEFAULT_ADMIN.username && password === DEFAULT_ADMIN.password;
    if (username.trim().toLowerCase() !== saved.username) return false;
    return (await pbkdf2(password, saved.salt, saved.iterations)) === saved.hash;
  },
  async setLogin(username, password) {
    const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const iterations = 210000;
    const hash = await pbkdf2(password, salt, iterations);
    writeJSON(ADMIN_KEY, { username: username.trim().toLowerCase(), salt, iterations, hash });
  },
  /** Forgot the password: wipe the login AND the API keys, so a reset never exposes keys. */
  reset() {
    try { localStorage.removeItem(ADMIN_KEY); } catch {}
    config.saveKeys([]);
    config.saveSettings({ activeKey: null });
    this.signOut();
  },
  signIn(hours = 12) { try { sessionStorage.setItem(SESSION_KEY, String(Date.now() + hours * 3600e3)); } catch {} },
  signOut() { try { sessionStorage.removeItem(SESSION_KEY); } catch {} },
  signedIn() { try { return Number(sessionStorage.getItem(SESSION_KEY) || 0) > Date.now(); } catch { return false; } },
};
