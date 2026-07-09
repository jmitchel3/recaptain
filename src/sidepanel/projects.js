// Project storage + File System Access helpers.
//
// A "project" is { name, dirHandle, createdAt, lastUsedAt }. The directory
// handle is a live FileSystemDirectoryHandle persisted in IndexedDB (handles
// are structured-cloneable). Permission on a stored handle does NOT survive
// a browser restart — we re-request on Start, which carries the user gesture.

const DB_NAME = 'recaptain';
const DB_VERSION = 1;
const STORE = 'projects';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects() {
  const db = await openDb();
  try {
    const all = await asPromise(tx(db, 'readonly').getAll());
    all.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
    return all;
  } finally {
    db.close();
  }
}

export async function getProject(name) {
  if (!name) return null;
  const db = await openDb();
  try {
    return (await asPromise(tx(db, 'readonly').get(name))) || null;
  } finally {
    db.close();
  }
}

export async function saveProject(project) {
  const db = await openDb();
  try {
    await asPromise(tx(db, 'readwrite').put(project));
  } finally {
    db.close();
  }
}

export async function deleteProject(name) {
  const db = await openDb();
  try {
    await asPromise(tx(db, 'readwrite').delete(name));
  } finally {
    db.close();
  }
}

export async function touchProject(name) {
  const existing = await getProject(name);
  if (!existing) return;
  existing.lastUsedAt = Date.now();
  await saveProject(existing);
}

// Permission state without prompting. Returns 'granted' | 'denied' | 'prompt'.
export async function queryPermission(handle) {
  if (!handle?.queryPermission) return 'prompt';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

// Must be called inside a user gesture (click handler). Returns the new state.
export async function requestPermission(handle) {
  if (!handle?.requestPermission) return 'denied';
  try {
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

// Pick a directory. Must be called from a user gesture.
export async function pickDirectory() {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser does not support the File System Access API.');
  }
  return await window.showDirectoryPicker({ mode: 'readwrite' });
}

// Resolve a nested path like "screenshots/0000.png" under root, creating dirs.
async function getNestedFileHandle(root, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return await dir.getFileHandle(fileName, { create: true });
}

async function writeBytes(root, relPath, bytes) {
  const fh = await getNestedFileHandle(root, relPath);
  const w = await fh.createWritable();
  try {
    await w.write(bytes);
  } finally {
    await w.close();
  }
}

// Create the <stamp>__<label>/ subfolder under the project root, avoiding
// collisions by suffixing -2, -3, etc.
async function createRecordingDir(root, baseName) {
  let name = baseName;
  let i = 2;
  while (true) {
    try {
      await root.getDirectoryHandle(name, { create: false });
      name = `${baseName}-${i++}`;
    } catch {
      return { dir: await root.getDirectoryHandle(name, { create: true }), name };
    }
  }
}

// Write the bundle files to <root>/<folder>/. Writes manifest.json LAST so a
// watcher can treat it as a completion marker. Returns the final folder name
// actually used (post-collision-suffix).
export async function writeBundleToProject(root, folder, files) {
  const { dir, name: finalFolder } = await createRecordingDir(root, folder);

  // Write everything except manifest.json first.
  const entries = Object.entries(files).filter(([p]) => p !== 'manifest.json');
  for (const [relPath, bytes] of entries) {
    await writeBytes(dir, relPath, bytes);
  }

  // Completion marker — written last.
  const manifestBytes = files['manifest.json'];
  if (manifestBytes) {
    await writeBytes(dir, 'manifest.json', manifestBytes);
  }

  return finalFolder;
}
