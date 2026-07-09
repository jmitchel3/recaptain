// Crash-recovery persistence for the service worker. Split across two
// storages:
//
//   - chrome.storage.session: small structured state (metadata, activity
//     array, console entries, tab timeline). Survives SW restart within a
//     browser session. ~10MB quota; activity is capped well below that.
//   - IndexedDB: screenshot byte blobs, which would blow past the session
//     storage quota on a long recording.
//
// The SW writes state incrementally during a recording. On SW wake, it
// rehydrates state so pause/stop still work even if Chrome killed and
// restarted the worker mid-session.

const SESSION_KEY_META = 'wb_recording_meta';
const SESSION_KEY_ACTIVITY = 'wb_recording_activity';
const SESSION_KEY_CONSOLE = 'wb_recording_console';
const IDB_NAME = 'recaptain';
const IDB_VERSION = 1;
const IDB_STORE_SHOTS = 'screenshots';

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_SHOTS)) {
        db.createObjectStore(IDB_STORE_SHOTS, { keyPath: 'seq' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode) {
  const db = await openDB();
  const t = db.transaction(IDB_STORE_SHOTS, mode);
  return { store: t.objectStore(IDB_STORE_SHOTS), done: new Promise((r, j) => {
    t.oncomplete = () => r();
    t.onerror = () => j(t.error);
    t.onabort = () => j(t.error);
  }) };
}

export async function persistScreenshot(seq, shot) {
  try {
    const { store, done } = await tx('readwrite');
    store.put({ seq, ...shot });
    await done;
  } catch {
    // IDB failure is non-fatal; crash recovery for screenshots is a
    // nice-to-have, not a requirement. Text events are far more important.
  }
}

export async function loadScreenshots() {
  try {
    const { store, done } = await tx('readonly');
    const req = store.getAll();
    await new Promise((r, j) => { req.onsuccess = () => r(); req.onerror = () => j(req.error); });
    await done;
    const rows = req.result || [];
    rows.sort((a, b) => a.seq - b.seq);
    return rows;
  } catch {
    return [];
  }
}

export async function clearScreenshots() {
  try {
    const { store, done } = await tx('readwrite');
    store.clear();
    await done;
  } catch {}
}

// Debounced writer: coalesces bursts of activity into one write. The delay
// trades recoverability for cost: shorter = less lost on crash, more writes.
let flushTimer = null;
let pendingFlush = null;

function scheduleFlush(writer, delayMs) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingFlush = writer;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const w = pendingFlush;
    pendingFlush = null;
    try { await w(); } catch {}
  }, delayMs);
}

export function persistStateSoon(meta, activity, consoleEntries, { delayMs = 500 } = {}) {
  scheduleFlush(async () => {
    const payload = {
      [SESSION_KEY_META]: meta,
      [SESSION_KEY_ACTIVITY]: activity,
      [SESSION_KEY_CONSOLE]: consoleEntries,
    };
    try {
      await chrome.storage.session.set(payload);
    } catch {
      // Quota or serialization error: drop silently; next flush will retry.
    }
  }, delayMs);
}

export async function flushPersistNow() {
  if (!flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = null;
  const w = pendingFlush;
  pendingFlush = null;
  if (w) { try { await w(); } catch {} }
}

export async function loadPersistedState() {
  try {
    const got = await chrome.storage.session.get([
      SESSION_KEY_META, SESSION_KEY_ACTIVITY, SESSION_KEY_CONSOLE,
    ]);
    return {
      meta: got[SESSION_KEY_META] || null,
      activity: Array.isArray(got[SESSION_KEY_ACTIVITY]) ? got[SESSION_KEY_ACTIVITY] : [],
      consoleEntries: Array.isArray(got[SESSION_KEY_CONSOLE]) ? got[SESSION_KEY_CONSOLE] : [],
    };
  } catch {
    return { meta: null, activity: [], consoleEntries: [] };
  }
}

export async function clearPersistedState() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; pendingFlush = null; }
  try {
    await chrome.storage.session.remove([
      SESSION_KEY_META, SESSION_KEY_ACTIVITY, SESSION_KEY_CONSOLE,
    ]);
  } catch {}
  await clearScreenshots();
}
