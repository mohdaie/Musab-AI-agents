/* Backup of this device's teams, chats and agent memory, so a browser clearing its storage can't lose them.
   PC and Android (Chrome, Edge, Samsung Internet): pick a folder once and every change is saved there as
   musab-backup.json, plus one dated copy per day (the last 7 are kept). Choosing the same folder again
   on an empty device restores everything.
   iPhone, iPad and Firefox can't give a web app a folder: there you save a backup file (to Files, iCloud
   Drive, Google Drive…) and open it here to restore. */
import { db } from "./db.js";
import { $app, $sheet, appbar, h, icon, toast } from "./ui.js";

export const FILE = "musab-backup.json";
const KIND = "musab-agents-backup";
const DAILY = /^musab-backup-\d{4}-\d{2}-\d{2}\.json$/;
const KEEP_DAILY = 7;
const RW = { mode: "readwrite" };
const REMIND_DAYS = 7;

export const canPickFolder = typeof window.showDirectoryPicker === "function";

/** What the Backup page and the home screen show. lastSaved: folder save, lastFile: backup file saved by hand (ms). */
export const status = { folder: "", needsPermission: false, lastSaved: 0, lastFile: 0, error: "" };
const notify = () => window.dispatchEvent(new Event("musab-backup"));

let dir = null; // FileSystemDirectoryHandle, kept in IndexedDB (meta "backupDir")

const granted = async (handle, ask = false) => {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission(RW)) === "granted") return true;
  return ask && (await handle.requestPermission(RW)) === "granted";
};

export const ready = (async () => {
  dir = (await db.meta("backupDir")) || null;
  status.lastSaved = (await db.meta("backupSaved")) || 0;
  status.lastFile = (await db.meta("backupFile")) || 0;
  status.folder = dir?.name || "";
  if (dir) status.needsPermission = !(await granted(dir));
  notify();
})().catch(() => {});

// ------------------------------------------------------------------ the backup itself
const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export async function snapshot() {
  return { kind: KIND, version: 1, saved_at: Date.now(), ...(await db.dump()) };
}

/** Read a backup file's text; throws if it isn't one. */
export function parse(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error("This file isn't a Musab backup."); }
  if (d?.kind !== KIND || !["teams", "messages", "memories"].every((k) => Array.isArray(d[k]))
      || !d.teams.every((t) => t && typeof t.id === "string" && Array.isArray(t.agents))) {
    throw new Error("This file isn't a Musab backup.");
  }
  return d;
}

export const describe = (d) => `${d.teams.length} team${d.teams.length === 1 ? "" : "s"}, ${d.messages.length} message${d.messages.length === 1 ? "" : "s"}` +
  (d.saved_at ? `, saved ${new Date(d.saved_at).toLocaleString()}` : "");

/** Replace everything on this device with a backup. Asks first unless the device has no teams. */
export async function restore(d) {
  const local = await db.teams();
  if (local.length && !confirm(`Restore ${describe(d)}?\n\nThis replaces the ${local.length} team${local.length === 1 ? "" : "s"} on this device.`)) return false;
  await db.load(d);
  return true;
}

// ------------------------------------------------------------------ folder (PC and Android)
async function writeFile(name, text) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

async function prune() {
  const old = [];
  for await (const name of dir.keys()) if (DAILY.test(name)) old.push(name);
  old.sort();
  for (const name of old.slice(0, -KEEP_DAILY)) await dir.removeEntry(name);
}

/** Save to the folder now. Returns false if there's no folder or it needs permission again. */
export async function saveNow() {
  await ready;
  if (!dir) return false;
  if (!(await granted(dir))) { status.needsPermission = true; notify(); return false; }
  try {
    const text = JSON.stringify(await snapshot());
    await writeFile(FILE, text);
    await writeFile(`musab-backup-${today()}.json`, text);
    await prune();
    status.lastSaved = Date.now();
    status.error = "";
    status.needsPermission = false;
    await db.setMeta("backupSaved", status.lastSaved);
  } catch (e) {
    status.error = `Couldn't save to the folder: ${e.message}`; // folder moved or deleted, disk full…
  }
  notify();
  return !status.error;
}

/** The backup in the chosen folder, or null if it has none yet. */
export async function readFolder() {
  try {
    const f = await (await dir.getFileHandle(FILE)).getFile();
    return parse(await f.text());
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}

/** Ask the user for a folder. Returns the backup already in it (or null). Throws AbortError if they cancel. */
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: "musab-backup", mode: "readwrite" });
  if (!(await granted(handle, true))) throw new Error("No permission to save in that folder.");
  dir = handle;
  await db.setMeta("backupDir", handle);
  Object.assign(status, { folder: handle.name, needsPermission: false, error: "" });
  notify();
  return readFolder();
}

/** After a reload the browser may ask again before the app can write to the folder (needs a tap). */
export async function allow() {
  await ready;
  if (!dir || !(await granted(dir, true))) return false;
  status.needsPermission = false;
  notify();
  await saveNow();
  return true;
}

export async function stopFolder() {
  dir = null;
  await db.setMeta("backupDir", undefined);
  Object.assign(status, { folder: "", needsPermission: false, error: "" });
  notify();
}

// Save a couple of seconds after the last change (agents write several messages in a row),
// and right away when the app goes to the background.
let timer = 0, running = null, again = false;
function run() {
  timer = 0;
  if (running) { again = true; return; }
  running = saveNow().finally(() => { running = null; if (again) { again = false; schedule(); } });
}
function schedule() {
  if (!dir || status.needsPermission) return;
  clearTimeout(timer);
  timer = setTimeout(run, 2000);
}
window.addEventListener("musab-data", () => ready.then(schedule));
document.addEventListener("visibilitychange", () => { if (document.hidden && timer) { clearTimeout(timer); run(); } });

// ------------------------------------------------------------------ backup file (every device; the only way on iPhone)
export async function saveFile() {
  const name = `musab-backup-${today()}.json`;
  const file = new File([JSON.stringify(await snapshot(), null, 1)], name, { type: "application/json" });
  let shared = false;
  // Phones: the share sheet has "Save to Files" / Drive, where the user picks the folder.
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Musab Agents backup" }); shared = true; } catch (e) {
      if (e.name === "AbortError") return false;
    }
  }
  if (!shared) {
    const a = h("a", { href: URL.createObjectURL(file), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  status.lastFile = Date.now();
  await db.setMeta("backupFile", status.lastFile);
  notify();
  return true;
}

// ------------------------------------------------------------------ home screen notice
/** A one-line notice for the home screen when the backup needs attention, else null. */
export async function backupNotice(go) {
  await ready;
  if (status.needsPermission) {
    return h("div", { class: "backup-notice" },
      h("span", {}, `Backups to “${status.folder}” are paused until you allow it again.`),
      h("button", { class: "btn small primary", onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        if (await allow()) { toast(`Saved to ${status.folder}`); btn.closest(".backup-notice")?.remove(); }
        else { btn.disabled = false; toast("The browser didn't allow it. Try again or choose the folder again in Backup."); }
      } }, "Allow"));
  }
  if (status.error) {
    return h("div", { class: "backup-notice" }, h("span", {}, status.error), h("button", { class: "btn small", onclick: () => go("#/backup") }, "Fix"));
  }
  const last = Math.max(status.lastSaved, status.lastFile);
  if (!dir && Date.now() - last > REMIND_DAYS * 864e5 && (await db.teams()).length) {
    return h("div", { class: "backup-notice" },
      h("span", {}, last ? `Last backup ${new Date(last).toLocaleDateString()}.` : "Your teams are only saved in this browser."),
      h("button", { class: "btn small primary", onclick: () => go("#/backup") }, "Back up"));
  }
  return null;
}

// ------------------------------------------------------------------ Backup page
const when = (ms) => (ms ? new Date(ms).toLocaleString() : "never");

export async function backupView({ go, current }) {
  await ready;
  if (!current()) return;
  const off = () => window.removeEventListener("musab-backup", redraw);
  const redraw = () => { if (current() && location.hash === "#/backup") draw(); else off(); };
  window.addEventListener("musab-backup", redraw);

  const busy = (fn) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(); } catch (ex) { if (ex.name !== "AbortError") toast(ex.message); }
    btn.disabled = false;
  };

  const pickFolder = busy(async () => {
    const found = await chooseFolder();
    if (!found?.teams.length) {
      await saveNow();
      toast(`Backups will be saved to ${status.folder}`);
      return;
    }
    if (!(await db.teams()).length) {
      await db.load(found);
      toast(`Restored ${describe(found)}`);
      return go("#/");
    }
    askRestore(found);
  });

  // The folder already has a backup and this device has teams too: let the user pick which to keep.
  const askRestore = (found) => {
    $sheet.replaceChildren(h("div", { class: "sheet-body" },
      h("h2", {}, "This folder has a backup"),
      h("p", { class: "sub" }, describe(found)),
      h("button", { class: "btn primary block", onclick: async () => {
        $sheet.close();
        await db.load(found);
        toast("Restored from the folder");
        go("#/");
      } }, "Restore it on this device"),
      h("button", { class: "btn block", onclick: async () => {
        $sheet.close();
        if (await saveNow()) toast(`Saved this device's teams to ${status.folder}`);
      } }, "Replace it with this device's teams"),
      h("p", { class: "muted small" }, "Restoring replaces the teams, chats and memory on this device. " +
        "Replacing keeps this device as it is; the older copies stay in the folder for 7 days.")));
    if (!$sheet.open) $sheet.showModal();
  };

  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const d = parse(await f.text());
      if (await restore(d)) { toast(`Restored ${describe(d)}`); go("#/"); }
    } catch (ex) { toast(ex.message); }
  } });

  function folderCard() {
    if (!canPickFolder) {
      return h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { html: `${icon("folder")} Backup folder` })),
        h("p", { class: "muted" }, "This browser can't save to a folder by itself (iPhone, iPad and Firefox can't). " +
          "Save a backup file below every few days, and keep the app on your Home Screen so the browser is less likely to clear it."));
    }
    const head = h("div", { class: "card-head" }, h("h2", { html: `${icon("folder")} Backup folder` }),
      status.folder ? h("span", { class: `pill ${status.needsPermission || status.error ? "warn" : "ok"}` },
        status.needsPermission ? "Paused" : status.error ? "Not saving" : "Auto-saving") : null);
    if (!status.folder) {
      return h("section", { class: "card" }, head,
        h("p", {}, "Choose a folder on this device, for example Documents. Every change to your teams, chats and agent memory is saved there, " +
          "so nothing is lost if the browser clears its data."),
        h("p", { class: "muted small" }, "Already have a backup there? Choose the same folder and it's restored."),
        h("button", { class: "btn primary block", html: `${icon("folder")} Choose folder`, onclick: pickFolder }));
    }
    return h("section", { class: "card" }, head,
      h("dl", { class: "backup-facts" },
        h("dt", {}, "Folder"), h("dd", {}, status.folder),
        h("dt", {}, "Last saved"), h("dd", { class: "last-saved" }, when(status.lastSaved))),
      status.error ? h("p", { class: "error" }, status.error, " Choose the folder again.") : null,
      status.needsPermission
        ? h("button", { class: "btn primary block", onclick: busy(async () => { if (!(await allow())) toast("The browser didn't allow it."); }) }, "Allow saving to this folder")
        : h("button", { class: "btn primary block", onclick: busy(async () => { if (await saveNow()) toast("Saved"); }) }, "Save now"),
      h("div", { class: "footer-actions" },
        h("button", { class: "btn", onclick: busy(async () => {
          if (!(await granted(dir, true))) return toast("The browser didn't allow it.");
          const d = await readFolder();
          if (!d) return toast("No backup in this folder yet.");
          if (await restore(d)) { toast(`Restored ${describe(d)}`); go("#/"); }
        }) }, "Restore"),
        h("button", { class: "btn", onclick: pickFolder }, "Change folder")),
      h("p", { class: "note" }, `The folder keeps ${FILE} (always the latest) and one copy per day for the last ${KEEP_DAILY} days.`),
      h("button", { class: "link-btn small danger-text", onclick: async () => {
        if (confirm(`Stop saving to ${status.folder}? The files already there stay.`)) { await stopFolder(); toast("Stopped saving to the folder"); }
      } }, "Stop using this folder"));
  }

  function fileCard() {
    return h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { html: `${icon("download")} Backup file` })),
      h("p", {}, canPickFolder ? "Save a single backup file by hand, for example to move your teams to another device."
        : "Save a backup file to Files, iCloud Drive or Google Drive. Open it here to get everything back."),
      h("dl", { class: "backup-facts" }, h("dt", {}, "Last file"), h("dd", {}, when(status.lastFile))),
      h("div", { class: "footer-actions" },
        h("button", { class: "btn primary", onclick: busy(async () => { if (await saveFile()) toast("Backup file saved"); }) }, "Save file"),
        h("button", { class: "btn", onclick: () => fileInput.click() }, "Restore")),
      fileInput);
  }

  function draw() {
    $app.replaceChildren(h("div", { class: "screen" },
      appbar({ title: "Backup", subtitle: "Teams, chats and agent memory", back: () => go("#/") }),
      h("div", { class: "content admin" }, folderCard(), fileCard(),
        h("p", { class: "note" }, "Admin login, API keys, skills, settings and usage are on your server, so they don't need a backup."))));
  }
  draw();
}
