/* The Musab server (Supabase Edge Function in supabase/functions/musab): admin login, API keys,
   settings and usage are stored there, and it relays chat requests to DeepSeek so keys never
   reach the browser. This device only keeps its sign-in token and a cached copy of the settings. */
export const SERVER = "https://wkzrefbvjxqphkrduyqj.supabase.co/functions/v1/musab";

const TOKEN = "musab.session";
const SETTINGS = "musab.serverSettings";
export const DEFAULT_SETTINGS = {
  talk: "balanced", fallback: true, activeKey: null,
  models: { work: "deepseek-v4-pro", friends: "deepseek-flash" },
};

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const emit = () => { try { window.dispatchEvent(new CustomEvent("musab-session")); } catch {} };

export class ServerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const session = {
  token: () => read(TOKEN),
  signedIn: () => !!read(TOKEN),
  /** The session is still on the default password until it's changed. */
  mustChange: () => read("musab.mustChange") === "1",
  set(token, mustChange = false) { write(TOKEN, token); write("musab.mustChange", mustChange ? "1" : null); emit(); },
  signOut() { write(TOKEN, null); write("musab.mustChange", null); emit(); },
  settings() {
    let s = {};
    try { s = JSON.parse(read(SETTINGS) || "{}") || {}; } catch {}
    return { ...DEFAULT_SETTINGS, ...s, models: { ...DEFAULT_SETTINGS.models, ...(s.models || {}) } };
  },
  cacheSettings(s) { write(SETTINGS, JSON.stringify(s)); emit(); },
};

/** Call the server. Throws ServerError; a 401 signs this device out. */
export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (session.token()) headers.Authorization = `Bearer ${session.token()}`;
  let res;
  try {
    res = await fetch(SERVER + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ServerError(0, `Can't reach the server (${e.message}). Check your connection.`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") session.signOut();
    throw new ServerError(res.status, data?.error || `Server error ${res.status}`);
  }
  return data;
}

/** Refresh the cached settings (talk level, models) from the server when signed in. */
export async function syncSettings() {
  if (!session.signedIn()) return null;
  try {
    const me = await api("/me");
    session.set(session.token(), me.mustChange);
    session.cacheSettings(me.settings || {});
    return me;
  } catch { return null; }
}
