import { zipSync, strToU8 } from 'fflate';
import { scrubUrl, PRIVACY_MANIFEST } from './shared/privacy.js';
import { applyRedactionToBitmap } from './shared/redaction.js';
import { exportPlaywrightSpec } from './shared/playwright-export.js';
import { buildPagesJson, buildRecapMd, canonicalUrl } from './shared/recap-export.js';
import {
  getConfig, setConfig, getActiveDenylist, onConfigChanged, DEFAULT_CONFIG,
} from './shared/access-config.js';
import { canonicalize, compileMatcher } from './shared/match-patterns.js';
import {
  persistStateSoon, loadPersistedState, clearPersistedState,
  persistScreenshot, loadScreenshots,
} from './shared/persistence.js';
import { writeBundleToProject, getProject, queryPermission } from './sidepanel/projects.js';

const SCREENSHOT_INTERVAL_MS = 8000;       // baseline periodic shot
const WAITING_SCREENSHOT_INTERVAL_MS = 30000; // throttled cadence while the page is busy and the operator is idle
const SCREENSHOT_EVENT_COOLDOWN_MS = 500;  // throttle event-triggered shots
const OFFSCREEN_PATH = 'offscreen.html';
// Past this many cumulative bytes of screenshots, switch new captures to
// JPEG at reduced quality. The bundle is honest about the switch via a
// `note` activity entry so downstream consumers know image quality changed.
const SHOT_COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024;
const SHOT_JPEG_QUALITY = 0.6;
// Width cap on the sidepanel preview thumbnail; the full PNG is kept in
// state for the bundle; the feed only needs something readable.
const SHOT_THUMB_MAX_WIDTH = 360;
const SHOT_THUMB_QUALITY = 0.5;

// Session time limit. Recordings are meant to be short, focused captures:
// past ~10 min of active recording, the signal-to-noise of a runbook drops,
// memory pressure climbs, and the bundle stops fitting in a single download.
// Pause/resume lets the operator step away without burning active time.
const SESSION_MAX_MS = 10 * 60 * 1000;
const SESSION_WARN_MS = 8 * 60 * 1000;

// Kinds written into events.json. Other activity kinds (console, screenshot)
// live in their own dedicated files in the bundle.
const EVENT_KINDS = new Set([
  'click', 'dblclick', 'input', 'change', 'submit',
  'key', 'focus', 'scroll',
  'navigation', 'tab_switch',
  'marker', 'note', 'idle',
  'pause', 'resume', 'timeout',
  'network', 'assertion',
  'waiting_start', 'waiting_end',
  'landmark_snapshot',
]);

const ACTIVITY_MAX = 5000;
const state = {
  recording: false,
  paused: false,
  pausedAt: null,        // Date.now() when paused; null otherwise
  totalPausedMs: 0,      // cumulative paused time, closed on resume
  startedAt: null,
  label: null,
  description: null,
  mic: true,
  micDeviceId: null,
  micLevel: 0,        // 0..1 RMS from offscreen
  micLevelAt: 0,
  startUrl: null,
  activity: [],       // unified event stream (all kinds), feeds sidepanel + bundle
  activitySeq: 0,
  screenshots: [],    // parallel store keeping screenshot dataUrls for bundle/preview
  consoleEntries: [], // kept for console.json convenience (denormalized from activity)
  tabTimeline: [],    // [{ tab_id, url, entered_at, left_at }]
  lastShotAt: 0,
  lastActivityAt: null,
  tabId: null,
  currentTabUrl: null,
  viewport: null,
  shotBytesTotal: 0,       // cumulative on-disk size of screenshots captured
  shotCompressed: false,   // flipped true once we switched to JPEG
  saveAs: true,            // whether chrome.downloads.download prompts Save As
  captureShots: false,     // cached access config value for bundle/status output
  redactionMode: 'black',  // 'black' | 'blur' | 'off', applied before screenshot encoding
  captureNetwork: false,   // operator toggle: capture fetch/XHR metadata
  captureNetworkBody: false, // sub-toggle: include short JSON response bodies
  waiting: false,          // between waiting_start and waiting_end, drives throttles
  waitingSince: null,      // Date.now() of current waiting window; null otherwise
  totalWaitingMs: 0,       // cumulative waiting time, closed on each waiting_end
  peakInFlightThisWait: 0, // mirrors detector's peak_reqs for status surface
  manualWaiting: false,    // operator-asserted waiting, controls the button label
  primaryNav: null,        // {region_selector, total, items} from content-script detection
  pagesVisited: new Set(), // canonicalUrl Set, powers the coverage widget
  accessNoteKeys: new Set(), // policy notes already emitted in this recording
};

let cachedConfig = { ...DEFAULT_CONFIG, denylist: [...DEFAULT_CONFIG.denylist] };
let cachedActiveDenylist = [];
let cachedDenyMatcher = compileMatcher([]);
let cachedGrantedOrigins = [];
let cachedGrantedMatcher = compileMatcher([]);
let cachedAllSitesGranted = false;
let recorderAccessRefresh = Promise.resolve();

// Active (non-paused) milliseconds since recording began. This is what the
// session time limit gates on: wall clock includes breaks; active time is
// what actually went into the recording.
function activeElapsedMs() {
  if (!state.startedAt) return 0;
  const now = state.paused && state.pausedAt ? state.pausedAt : Date.now();
  // Subtract closed pause windows, closed waiting windows, and the in-flight
  // waiting window (so the timer stops the moment waiting_start lands, not
  // only on waiting_end).
  const inFlightWait = state.waiting && state.waitingSince ? (now - state.waitingSince) : 0;
  return now - state.startedAt - state.totalPausedMs - state.totalWaitingMs - inFlightWait;
}

// Snapshot of durable state: the bits the SW needs to rehydrate after a
// crash. Screenshots are big; they go to IndexedDB separately. Everything
// else lives in chrome.storage.session as structured JSON.
function metaSnapshot() {
  return {
    recording: state.recording,
    paused: state.paused,
    pausedAt: state.pausedAt,
    totalPausedMs: state.totalPausedMs,
    startedAt: state.startedAt,
    label: state.label,
    description: state.description,
    mic: state.mic,
    micDeviceId: state.micDeviceId,
    startUrl: state.startUrl,
    tabTimeline: state.tabTimeline,
    activitySeq: state.activitySeq,
    lastActivityAt: state.lastActivityAt,
    tabId: state.tabId,
    currentTabUrl: state.currentTabUrl,
    viewport: state.viewport,
    shotBytesTotal: state.shotBytesTotal,
    shotCompressed: state.shotCompressed,
    captureShots: state.captureShots,
    redactionMode: state.redactionMode,
    captureNetwork: state.captureNetwork,
    captureNetworkBody: state.captureNetworkBody,
    waiting: state.waiting,
    waitingSince: state.waitingSince,
    totalWaitingMs: state.totalWaitingMs,
    manualWaiting: state.manualWaiting,
    primaryNav: state.primaryNav,
    pagesVisited: Array.from(state.pagesVisited),
    accessNoteKeys: Array.from(state.accessNoteKeys),
  };
}

function schedulePersist() {
  if (!state.recording) return;
  // Activity entries can carry `thumb_url` (data URL bytes); strip before
  // persisting; rehydration rebuilds preview from IDB if needed.
  const activity = state.activity.map(({ thumb_url, ...rest }) => rest);
  persistStateSoon(metaSnapshot(), activity, state.consoleEntries);
}

// Long-lived ports from sidepanel instances (one per open panel).
const sidepanelPorts = new Set();

function nowT() {
  return state.startedAt ? Date.now() - state.startedAt : 0;
}

function normalizeIncomingEvent(e, fallbackTabId) {
  const ts = e.ts || Date.now();
  return {
    ...e,
    ts,
    t: state.startedAt ? ts - state.startedAt : 0,
    tab_id: e.tab_id ?? fallbackTabId,
  };
}

function pushActivity(entry) {
  // Auto-insert an `idle` marker when a gap >= 1s exists between the previous
  // activity and this one. Only while recording, and never before the first
  // event (lastActivityAt is null until the first real push). Skip idle
  // insertion for entries that already describe a gap semantically: `idle`
  // itself, and `pause`/`resume` (their pair already carries the duration).
  const skipIdleGap = entry.kind === 'idle' || entry.kind === 'pause' || entry.kind === 'resume';
  if (state.recording && state.lastActivityAt != null && !skipIdleGap) {
    const gapMs = Date.now() - state.lastActivityAt;
    if (gapMs >= 1000) {
      state.activitySeq += 1;
      const idleEntry = {
        id: state.activitySeq,
        kind: 'idle',
        t: (state.lastActivityAt - state.startedAt),
        ts: state.lastActivityAt,
        duration_ms: gapMs,
      };
      state.activity.push(idleEntry);
      if (state.activity.length > ACTIVITY_MAX) {
        state.activity.splice(0, state.activity.length - ACTIVITY_MAX);
      }
      for (const port of sidepanelPorts) {
        try { port.postMessage({ type: 'activity:append', entries: [idleEntry] }); } catch {}
      }
    }
  }

  state.activitySeq += 1;
  const withId = { id: state.activitySeq, ...entry };
  state.activity.push(withId);
  if (state.activity.length > ACTIVITY_MAX) {
    state.activity.splice(0, state.activity.length - ACTIVITY_MAX);
  }
  for (const port of sidepanelPorts) {
    try { port.postMessage({ type: 'activity:append', entries: [withId] }); } catch {}
  }
  state.lastActivityAt = Date.now();
  schedulePersist();
  return withId;
}

function applyActiveDenylist(patterns) {
  cachedActiveDenylist = Array.isArray(patterns) ? [...patterns] : [];
  cachedDenyMatcher = compileMatcher(cachedActiveDenylist);
}

function applyCachedConfig(config) {
  const denylist = Array.isArray(config?.denylist)
    ? [...config.denylist]
    : [...DEFAULT_CONFIG.denylist];
  cachedConfig = { ...DEFAULT_CONFIG, ...config, denylist };
  applyActiveDenylist(cachedConfig.denylistEnabled ? denylist : []);
  if (state.recording) state.captureShots = !!cachedConfig.captureShots;
}

function applyGrantedOrigins(origins) {
  cachedGrantedOrigins = Array.from(new Set(
    (Array.isArray(origins) ? origins : []).filter((origin) => typeof origin === 'string'),
  ));
  cachedAllSitesGranted = cachedGrantedOrigins.includes('<all_urls>');
  cachedGrantedMatcher = compileMatcher(
    cachedGrantedOrigins.filter((origin) => origin !== '<all_urls>'),
  );
}

async function refreshCachedAccess() {
  const config = await getConfig();
  let permissions = { origins: [] };
  try { permissions = await chrome.permissions.getAll(); } catch {}
  applyCachedConfig(config);
  applyGrantedOrigins(permissions?.origins);
}

function applyPermissionDelta(perms, added) {
  const next = new Set(cachedGrantedOrigins);
  for (const origin of perms?.origins || []) {
    if (added) next.add(origin);
    else next.delete(origin);
  }
  applyGrantedOrigins(Array.from(next));
}

function parsePageUrl(url) {
  try { return new URL(url); } catch { return null; }
}

function pageHost(url) {
  return parsePageUrl(url)?.host || null;
}

function pageOrigin(url) {
  const parsed = parsePageUrl(url);
  return parsed?.host ? `${parsed.protocol}//${parsed.host}` : null;
}

function isInjectablePage(url) {
  const protocol = parsePageUrl(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

function hasGrantedAccess(url) {
  if (!isInjectablePage(url)) return false;
  return cachedAllSitesGranted || cachedGrantedMatcher(url);
}

function pushAccessNoteOnce(key, text) {
  if (!state.recording || state.accessNoteKeys.has(key)) return null;
  state.accessNoteKeys.add(key);
  return pushActivity({
    kind: 'note',
    t: nowT(),
    ts: Date.now(),
    text,
    access_policy: key,
  });
}

function noteDeniedPage(url) {
  const host = pageHost(url);
  if (!host) return null;
  return pushAccessNoteOnce(`deny:${host}`, `not captured: ${host} is on the denylist`);
}

function noteMissingAccess(url) {
  const host = pageHost(url);
  if (!host) return null;
  return pushAccessNoteOnce(`access:${host}`, `no access to ${host}, not captured`);
}

function noteMissingScreenshotGrant() {
  return pushAccessNoteOnce(
    'screenshots:no-all-sites',
    'screenshots not captured: all-sites access is not granted',
  );
}

function senderCanRecord(sender) {
  if (sender?.tab?.id !== state.tabId) return false;
  const url = sender?.tab?.url || sender?.url;
  return hasGrantedAccess(url) && !cachedDenyMatcher(url);
}

async function getTrackedVisibleTab() {
  const tabId = state.tabId;
  if (tabId == null) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (state.tabId !== tabId || !tab?.active) return null;
    return tab;
  } catch {
    return null;
  }
}

function broadcastRecordingState() {
  for (const port of sidepanelPorts) {
    try { port.postMessage({ type: 'recording:state', recording: state.recording, paused: state.paused }); } catch {}
  }
}

function broadcastWaitingState() {
  for (const port of sidepanelPorts) {
    try { port.postMessage({ type: 'waiting:state', waiting: state.waiting }); } catch {}
  }
}

// Coverage for the sidepanel widget: how many of the starting page's primary
// nav items has the operator visited so far. Null when we don't know the
// target list (non-primary-nav page, restricted URL, etc.).
function coverageSnapshot() {
  if (!state.primaryNav || !Array.isArray(state.primaryNav.items)) return null;
  const items = state.primaryNav.items;
  if (items.length === 0) return null;
  let visited = 0;
  for (const it of items) {
    if (it?.href && state.pagesVisited.has(it.href)) visited += 1;
  }
  return { visited, total: items.length, region: 'primary-nav' };
}

function reset() {
  state.recording = false;
  state.paused = false;
  state.pausedAt = null;
  state.totalPausedMs = 0;
  state.startedAt = null;
  state.label = null;
  state.description = null;
  state.mic = true;
  state.micDeviceId = null;
  state.micLevel = 0;
  state.micLevelAt = 0;
  state.startUrl = null;
  state.activity = [];
  state.activitySeq = 0;
  state.screenshots = [];
  state.consoleEntries = [];
  state.tabTimeline = [];
  state.lastShotAt = 0;
  state.lastActivityAt = null;
  state.tabId = null;
  state.currentTabUrl = null;
  state.viewport = null;
  state.shotBytesTotal = 0;
  state.shotCompressed = false;
  state.saveAs = true;
  state.captureShots = false;
  state.redactionMode = 'black';
  state.captureNetwork = false;
  state.captureNetworkBody = false;
  state.waiting = false;
  state.waitingSince = null;
  state.totalWaitingMs = 0;
  state.peakInFlightThisWait = 0;
  state.manualWaiting = false;
  state.primaryNav = null;
  state.pagesVisited = new Set();
  state.accessNoteKeys = new Set();
  cachedConfig = { ...DEFAULT_CONFIG, denylist: [...DEFAULT_CONFIG.denylist] };
  cachedActiveDenylist = [];
  cachedDenyMatcher = compileMatcher([]);
  cachedGrantedOrigins = [];
  cachedGrantedMatcher = compileMatcher([]);
  cachedAllSitesGranted = false;
}

async function ensureOffscreen({ needMic = false } = {}) {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  // BLOBS is needed to create object URLs for the bundle download (the SW
  // itself has no URL.createObjectURL). USER_MEDIA is added when recording
  // mic audio. Chrome accepts multiple reasons in the array.
  const reasons = needMic ? ['USER_MEDIA', 'BLOBS'] : ['BLOBS'];
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons,
    justification: 'Record microphone audio and materialize the Recaptain bundle for download.',
  });
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch {}
}

async function sendToOffscreen(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  return tab;
}

// Decode a data URL into its raw bytes. In-memory this is 33% smaller than
// keeping the base64 string around, which matters across a long recording.
function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Decode a captured PNG, downscale it to a small JPEG thumbnail for sidepanel
// preview, and optionally re-encode the full image as JPEG when we've blown
// past the compression threshold. Runs in the SW: OffscreenCanvas and
// createImageBitmap are available; URL.createObjectURL is not.
async function processCapturedShot(pngDataUrl, { compress, rects = [], mode = 'black', devicePixelRatio = 1 } = {}) {
  const pngBytes = dataUrlToBytes(pngDataUrl);
  let fullBytes = pngBytes;
  let mime = 'image/png';
  try {
    const blob = new Blob([pngBytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);

    // Paint over sensitive rects before any downstream encode. When rects
    // is empty or mode === 'off', the helper returns a pass-through canvas
    // so the rest of the pipeline stays uniform.
    const activeMode = mode === 'off' ? 'black' : mode;
    const applyRects = mode === 'off' ? [] : rects;
    const sourceCanvas = applyRedactionToBitmap(bitmap, applyRects, { mode: activeMode, devicePixelRatio });
    const redacted = applyRects.length > 0;

    // Redacted shots force JPEG: PNG of a blacked/blurred shot is wasted
    // bytes and makes the bundle larger for no gain.
    const forceJpeg = redacted;

    if (compress || forceJpeg) {
      const jpegBlob = await sourceCanvas.convertToBlob({ type: 'image/jpeg', quality: SHOT_JPEG_QUALITY });
      fullBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      mime = 'image/jpeg';
    } else {
      // No re-encode needed; ship the original PNG bytes unchanged, since
      // we didn't modify the bitmap. (applyRedactionToBitmap returns a fresh
      // canvas on the redact path; otherwise we short-circuit to the raw bytes.)
      if (redacted) {
        const pngBlob = await sourceCanvas.convertToBlob({ type: 'image/png' });
        fullBytes = new Uint8Array(await pngBlob.arrayBuffer());
        mime = 'image/png';
      }
    }

    // Thumbnail: small JPEG drawn from the redacted canvas so previews are
    // also safe.
    const scale = Math.min(1, SHOT_THUMB_MAX_WIDTH / sourceCanvas.width);
    const tw = Math.max(1, Math.round(sourceCanvas.width * scale));
    const th = Math.max(1, Math.round(sourceCanvas.height * scale));
    const thumbCanvas = new OffscreenCanvas(tw, th);
    thumbCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, tw, th);
    const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: SHOT_THUMB_QUALITY });
    const thumbBytes = new Uint8Array(await thumbBlob.arrayBuffer());
    const thumbBase64 = uint8ToBase64(thumbBytes);
    bitmap.close?.();
    return { bytes: fullBytes, mime, thumbDataUrl: `data:image/jpeg;base64,${thumbBase64}` };
  } catch {
    // If decode/encode fails for any reason, fall back to the raw PNG with
    // no thumbnail; we'd rather ship a valid (if uglier) bundle than skip
    // the screenshot entirely. Redaction failure falls through here too,
    // which means we ship the un-redacted PNG; that's bad, so we flag via
    // the thumbnail being null and log.
    return { bytes: fullBytes, mime, thumbDataUrl: null };
  }
}

async function takeScreenshot(reason) {
  if (!state.recording || state.paused) return null;
  if (!cachedConfig.captureShots) return null;
  if (!cachedAllSitesGranted) {
    noteMissingScreenshotGrant();
    return null;
  }

  const trackedTab = await getTrackedVisibleTab();
  if (!trackedTab || !hasGrantedAccess(trackedTab.url)) return null;
  if (cachedDenyMatcher(trackedTab.url)) {
    noteDeniedPage(trackedTab.url);
    return null;
  }

  const trackedTabId = trackedTab.id;
  const now = Date.now();
  if (now - state.lastShotAt < SCREENSHOT_EVENT_COOLDOWN_MS) return null;
  state.lastShotAt = now;
  try {
    const wasCompressed = state.shotCompressed;
    const shouldCompress = state.shotBytesTotal >= SHOT_COMPRESS_THRESHOLD_BYTES;
    if (shouldCompress && !state.shotCompressed) {
      state.shotCompressed = true;
    }

    // Ask the content script for the rects to black/blur before capture.
    // Redaction mode 'off' skips the roundtrip entirely.
    let rects = [];
    let dpr = 1;
    if (state.redactionMode !== 'off' && trackedTabId != null) {
      try {
        const resp = await chrome.tabs.sendMessage(trackedTabId, { type: 'recorder:collect-mask-rects' });
        rects = Array.isArray(resp?.rects) ? resp.rects : [];
        if (typeof resp?.devicePixelRatio === 'number') dpr = resp.devicePixelRatio;
      } catch {
        // Tab doesn't have the content script (restricted page, etc.);
        // fall through with no rects. Operator-facing contract covers this.
      }
    }

    // The visible tab can change while mask rects are collected. Recheck the
    // exact page immediately before capture so an ignored tab switch cannot
    // photograph a different site.
    if (!state.recording || state.paused || !cachedConfig.captureShots) return null;
    if (!cachedAllSitesGranted) {
      noteMissingScreenshotGrant();
      return null;
    }
    const captureTab = await getTrackedVisibleTab();
    if (!captureTab || captureTab.id !== trackedTabId || !hasGrantedAccess(captureTab.url)) return null;
    if (cachedDenyMatcher(captureTab.url)) {
      noteDeniedPage(captureTab.url);
      return null;
    }

    const captureUrl = captureTab.url || state.currentTabUrl;
    const rawDataUrl = await chrome.tabs.captureVisibleTab(captureTab.windowId, { format: 'png' });
    const { bytes, mime, thumbDataUrl } = await processCapturedShot(rawDataUrl, {
      compress: shouldCompress,
      rects,
      mode: state.redactionMode,
      devicePixelRatio: dpr,
    });

    const t = now - state.startedAt;
    const seq = state.screenshots.length;
    const shot = {
      t,
      reason: reason || 'periodic',
      tab_id: trackedTabId,
      url: scrubUrl(captureUrl),
      bytes,
      mime,
      mask_rects: rects,
      redaction_mode: state.redactionMode,
    };
    state.screenshots.push(shot);
    state.shotBytesTotal += bytes.byteLength;
    // Fire-and-forget IDB write so crash recovery can restore the image.
    persistScreenshot(seq, shot).catch(() => {});

    // Honest-bundle marker: emit a `note` the first time compression kicks
    // in so consumers know image quality changed mid-recording.
    if (state.shotCompressed && !wasCompressed) {
      pushActivity({
        kind: 'note',
        t,
        ts: Date.now(),
        text: `[auto] screenshots switched to JPEG (quality ${SHOT_JPEG_QUALITY}): cumulative screenshot size passed ${Math.round(SHOT_COMPRESS_THRESHOLD_BYTES / 1024 / 1024)}MB.`,
      });
    }

    pushActivity({
      kind: 'screenshot',
      t,
      reason: reason || 'periodic',
      tab_id: trackedTabId,
      url: scrubUrl(captureUrl),
      mime,
      thumb_url: thumbDataUrl, // tiny preview, not the full image
    });
    return state.screenshots.length - 1;
  } catch {
    // captureVisibleTab can fail on restricted pages; ignore.
    return null;
  }
}

async function maybePeriodicScreenshot() {
  if (!state.recording || state.paused) return;
  if (!state.captureShots) return;
  const now = Date.now();
  const interval = state.waiting ? WAITING_SCREENSHOT_INTERVAL_MS : SCREENSHOT_INTERVAL_MS;
  if (now - state.lastShotAt < interval) return;
  await takeScreenshot(state.waiting ? 'waiting_periodic' : 'periodic');
}

async function maybeEnforceTimeLimit() {
  if (!state.recording || state.paused) return;
  if (activeElapsedMs() < SESSION_MAX_MS) return;
  // Auto-stop at cap: emit a marker event, then invoke the normal stop path
  // so the bundle finalizes and the sidepanel flips to idle.
  pushActivity({
    kind: 'timeout',
    t: activeElapsedMs(),
    ts: Date.now(),
    limit_ms: SESSION_MAX_MS,
  });
  try { await stop({ target: 'download' }); } catch {}
}

// Kinds that warrant a screenshot: a click/change/submit/navigation is a
// natural "moment" to capture what the UI looked like.
const SHOT_TRIGGER_KINDS = new Set(['click', 'dblclick', 'change', 'submit', 'navigation', 'tab_switch']);

async function start({ label, mic, micDeviceId, description, saveAs, redactionMode, captureNetwork, captureNetworkBody }) {
  if (state.recording) throw new Error('already recording');
  const tab = await getActiveTab();
  reset();
  state.recording = true;
  state.startedAt = Date.now();
  state.label = label || null;
  state.description = description || null;
  state.mic = !!mic;
  state.micDeviceId = micDeviceId || null;
  state.saveAs = saveAs !== false;
  state.redactionMode = (redactionMode === 'blur' || redactionMode === 'off') ? redactionMode : 'black';
  state.captureNetwork = !!captureNetwork;
  state.captureNetworkBody = !!captureNetworkBody;
  state.startUrl = scrubUrl(tab.url || null);
  state.tabId = tab.id;
  state.currentTabUrl = scrubUrl(tab.url || null);
  state.tabTimeline.push({ tab_id: tab.id, url: scrubUrl(tab.url || null), entered_at: state.startedAt, left_at: null });

  // Capture policy is storage-backed and can change during the recording.
  // Load it before any injection or screenshot path becomes active.
  await refreshCachedAccess();

  // Best-effort viewport snapshot for the starting tab. Fails silently on
  // restricted pages (chrome://, web store, etc.).
  let viewport = null;
  if (hasGrantedAccess(tab.url) && !cachedDenyMatcher(tab.url)) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          width: window.innerWidth,
          height: window.innerHeight,
          device_scale_factor: window.devicePixelRatio || 1,
        }),
      });
      viewport = res?.result || null;
    } catch {}
  }
  state.viewport = viewport;

  // Offscreen is needed regardless of mic: it's where the bundle blob URL
  // is created at stop time.
  await ensureOffscreen({ needMic: !!state.mic });
  if (state.mic) {
    const res = await sendToOffscreen('mic:start', { deviceId: state.micDeviceId });
    if (!res?.ok) {
      reset();
      throw new Error(res?.error || 'failed to start microphone');
    }
  }

  // Registration does not cover an already-open document, so the serialized
  // access refresh also probes and starts the tracked tab when policy allows.
  await queueRecorderAccessRefresh();

  startPeriodicScreenshots();
  broadcastRecordingState();
  takeScreenshot('start');
}

let periodicShotHandle = null;
function startPeriodicScreenshots() {
  if (periodicShotHandle != null) clearInterval(periodicShotHandle);
  periodicShotHandle = setInterval(() => {
    maybePeriodicScreenshot().catch(() => {});
    maybeEnforceTimeLimit().catch(() => {});
  }, 2000);
}

async function pause() {
  if (!state.recording || state.paused) return;
  state.paused = true;
  state.pausedAt = Date.now();
  pushActivity({ kind: 'pause', t: activeElapsedMs(), ts: state.pausedAt });
  if (state.mic) {
    try { await sendToOffscreen('mic:pause'); } catch {}
  }
  if (state.tabId != null) {
    try { await chrome.tabs.sendMessage(state.tabId, { type: 'recorder:end' }); } catch {}
  }
  broadcastRecordingState();
}

async function resume() {
  if (!state.recording || !state.paused) return;
  const gap = Date.now() - (state.pausedAt || Date.now());
  state.totalPausedMs += gap;
  state.paused = false;
  state.pausedAt = null;
  if (state.mic) {
    try { await sendToOffscreen('mic:resume'); } catch {}
  }
  if (state.tabId != null) {
    const tabId = state.tabId;
    const ready = await ensureContentScript(tabId);
    if (ready && state.recording && state.tabId === tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'recorder:begin',
          captureNetwork: state.captureNetwork,
          captureNetworkBody: state.captureNetworkBody,
        });
      } catch {}
    }
  }
  pushActivity({ kind: 'resume', t: activeElapsedMs(), ts: Date.now(), paused_ms: gap });
  broadcastRecordingState();
}

async function handleTabSwitch(newTabId) {
  if (!state.recording || state.paused) return;
  if (!cachedConfig.followTabs) return;
  if (newTabId === state.tabId) return;

  let newTab;
  try { newTab = await chrome.tabs.get(newTabId); } catch { return; }

  const now = Date.now();
  // Tell old tab's content script to stop listening before new tab takes over
  if (state.tabId != null) {
    try { await chrome.tabs.sendMessage(state.tabId, { type: 'recorder:end' }); } catch {}
    const last = state.tabTimeline[state.tabTimeline.length - 1];
    if (last && last.left_at == null) last.left_at = now;
  }

  const tabSwitchEntry = pushActivity({
    kind: 'tab_switch',
    t: now - state.startedAt,
    ts: now,
    fromTabId: state.tabId,
    fromUrl: scrubUrl(state.currentTabUrl),
    toTabId: newTab.id,
    toUrl: scrubUrl(newTab.url || null),
  });

  state.tabId = newTab.id;
  state.currentTabUrl = scrubUrl(newTab.url || null);
  state.tabTimeline.push({ tab_id: newTab.id, url: scrubUrl(newTab.url || null), entered_at: now, left_at: null });

  const ready = await ensureContentScript(newTab.id);
  if (ready && state.recording && !state.paused && state.tabId === newTab.id) {
    try {
      await chrome.tabs.sendMessage(newTab.id, {
        type: 'recorder:begin',
        captureNetwork: state.captureNetwork,
        captureNetworkBody: state.captureNetworkBody,
      });
    } catch {}
  }

  const shotId = await takeScreenshot('tab_switch');
  if (typeof shotId === 'number') {
    tabSwitchEntry.screenshot_id = shotId;
  }
}

async function handleTabUrlChange(tabId, changeInfo) {
  if (!state.recording || state.paused || tabId !== state.tabId) return;
  if (!changeInfo?.url) return;
  const prevUrl = state.currentTabUrl;
  const scrubbedNext = scrubUrl(changeInfo.url);
  state.currentTabUrl = scrubbedNext;
  // Update timeline record
  const last = state.tabTimeline[state.tabTimeline.length - 1];
  if (last && last.tab_id === tabId && last.left_at == null) {
    last.url = scrubbedNext;
  }
  const navAt = Date.now();
  const navEntry = pushActivity({
    kind: 'navigation',
    t: navAt - state.startedAt,
    ts: navAt,
    tab_id: tabId,
    from: scrubUrl(prevUrl),
    to: scrubbedNext,
  });

  const nextDenied = cachedDenyMatcher(changeInfo.url);
  const nextGranted = hasGrantedAccess(changeInfo.url);
  const prevOrigin = pageOrigin(prevUrl);
  const nextOrigin = pageOrigin(changeInfo.url);
  if (nextDenied) noteDeniedPage(changeInfo.url);
  if (nextOrigin && nextOrigin !== prevOrigin && !nextGranted) {
    noteMissingAccess(changeInfo.url);
  }

  if (nextDenied || !nextGranted) {
    // Re-registration only affects future documents. Stop a script that was
    // already installed if an SPA route enters denied or ungranted scope.
    try { await chrome.tabs.sendMessage(tabId, { type: 'recorder:end' }); } catch {}
  } else {
    const ready = await ensureContentScript(tabId);
    if (ready && state.recording && !state.paused && state.tabId === tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'recorder:begin',
          captureNetwork: state.captureNetwork,
          captureNetworkBody: state.captureNetworkBody,
        });
      } catch {}
    }
  }

  const shotId = await takeScreenshot('navigation');
  if (typeof shotId === 'number') {
    navEntry.screenshot_id = shotId;
  }
}

// Host grants are optional and can be either all-sites or a set of origins.
// Dynamic registration keeps injection scoped to the active recording.
const RECORDER_SCRIPT_ID = 'recaptain-recorder';

async function registerRecorderContentScript() {
  let permissions = { origins: [] };
  try { permissions = await chrome.permissions.getAll(); } catch {}
  const origins = Array.isArray(permissions?.origins) ? permissions.origins : [];
  applyGrantedOrigins(origins);

  let denylist = [];
  try { denylist = await getActiveDenylist(); } catch {}
  applyActiveDenylist(denylist);

  const matches = cachedAllSitesGranted
    ? ['<all_urls>']
    : cachedGrantedOrigins.filter((origin) => origin !== '<all_urls>');
  const excludeMatches = [];
  for (const pattern of denylist) {
    try { excludeMatches.push(canonicalize(pattern)); } catch {}
  }

  if (!state.recording) return;
  await unregisterRecorderContentScript();
  if (!state.recording || matches.length === 0) return;

  try {
    await chrome.scripting.registerContentScripts([{
      id: RECORDER_SCRIPT_ID,
      js: ['content.js'],
      matches,
      excludeMatches: Array.from(new Set(excludeMatches)),
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: false,
    }]);
  } catch {
    // A grant can disappear between getAll and registration. The permission
    // listener will derive the next valid registration.
  }
  if (!state.recording) await unregisterRecorderContentScript();
}

async function unregisterRecorderContentScript() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_SCRIPT_ID] }); } catch {}
}

async function ensureContentScript(tabId) {
  // After the extension is reloaded, tabs that were already open do NOT
  // automatically get the content script. Probe with a quick message, and
  // inject via scripting.executeScript if the content script didn't answer.
  // The content script has its own idempotence guard so re-injection is safe.
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  if (cachedDenyMatcher(tab.url)) {
    noteDeniedPage(tab.url);
    return false;
  }
  if (!hasGrantedAccess(tab.url)) {
    noteMissingAccess(tab.url);
    return false;
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'recorder:ping' });
    if (res?.ok) return true;
  } catch {}

  // Navigation can change the URL while the ping is in flight. Recheck policy
  // before the one-off injection into the already-open document.
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  if (cachedDenyMatcher(tab.url)) {
    noteDeniedPage(tab.url);
    return false;
  }
  if (!hasGrantedAccess(tab.url)) {
    noteMissingAccess(tab.url);
    return false;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

async function syncTrackedTabCapture() {
  if (!state.recording || state.tabId == null) return;
  const tabId = state.tabId;
  const ready = await ensureContentScript(tabId);
  if (!ready) {
    // Removing a registration does not unload a script already in the page.
    try { await chrome.tabs.sendMessage(tabId, { type: 'recorder:end' }); } catch {}
    return;
  }
  if (!state.recording || state.paused || state.tabId !== tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'recorder:begin',
      captureNetwork: state.captureNetwork,
      captureNetworkBody: state.captureNetworkBody,
    });
  } catch {}
}

function queueRecorderAccessRefresh() {
  recorderAccessRefresh = recorderAccessRefresh
    .catch(() => {})
    .then(async () => {
      if (!state.recording) return;
      await refreshCachedAccess();
      if (!state.recording) return;
      await registerRecorderContentScript();
      if (!state.recording) return;
      await syncTrackedTabCapture();
    });
  return recorderAccessRefresh;
}

async function stop({ target = 'download', projectName = null } = {}) {
  if (!state.recording) return { bundled: false };
  state.recording = false;
  broadcastRecordingState();
  await recorderAccessRefresh.catch(() => {});
  await unregisterRecorderContentScript();

  if (periodicShotHandle != null) {
    clearInterval(periodicShotHandle);
    periodicShotHandle = null;
  }

  // Close the current tab timeline segment
  const last = state.tabTimeline[state.tabTimeline.length - 1];
  if (last && last.left_at == null) last.left_at = Date.now();

  if (state.tabId != null) {
    try { await chrome.tabs.sendMessage(state.tabId, { type: 'recorder:end' }); } catch {}
  }

  let audioBytes = null;
  if (state.mic) {
    try {
      const res = await sendToOffscreen('mic:stop');
      if (res?.ok && res.bytes) audioBytes = new Uint8Array(res.bytes);
    } catch {}
    // NOTE: do not close the offscreen doc yet; the download path below
    // needs it to create the bundle blob URL. Close after download/project.
  }

  if (target === 'project' && projectName) {
    // Load the directory handle from IDB in this (SW) context rather than
    // accepting it through sendMessage; runtime messages JSON-serialize,
    // which strips the FileSystemDirectoryHandle prototype and leaves a
    // plain object with no methods.
    const project = await getProject(projectName).catch(() => null);
    const projectHandle = project?.dirHandle || null;
    const perm = projectHandle ? await queryPermission(projectHandle) : 'denied';

    const bundle = await assembleBundle(audioBytes, { zip: false });
    const { folder } = bundleSlugs(bundle.manifest);
    lastAssembled = bundle;

    if (!projectHandle || perm !== 'granted') {
      await closeOffscreen();
      await clearPersistedState();
      reset();
      return {
        bundled: true,
        target: 'project',
        folder,
        error: {
          name: 'PermissionError',
          message: !projectHandle
            ? `Project "${projectName}" not found.`
            : `Folder access is "${perm}"; re-grant on next Start.`,
        },
      };
    }

    try {
      const written = await writeBundleToProject(projectHandle, folder, bundle.files);
      await closeOffscreen();
      await clearPersistedState();
      reset();
      lastAssembled = null;
      return { bundled: true, target: 'project', folder: written };
    } catch (err) {
      await closeOffscreen();
      await clearPersistedState();
      reset();
      return {
        bundled: true,
        target: 'project',
        folder,
        error: { name: err?.name || 'Error', message: err?.message || String(err) },
      };
    }
  }

  const bundle = await assembleBundle(audioBytes);
  await downloadBundle(bundle);
  await closeOffscreen();

  await clearPersistedState();
  reset();
  return { bundled: true, target: 'download' };
}

// Held so the sidepanel can request a zip-download fallback if the FS write fails.
let lastAssembled = null;

async function fetchExtensionFile(relPath, fallback) {
  try {
    const res = await fetch(chrome.runtime.getURL(relPath));
    if (!res.ok) return fallback;
    return await res.text();
  } catch { return fallback; }
}

function summarizeUrls() {
  const urls = [];
  const hosts = [];
  const seenUrl = new Set();
  const seenHost = new Set();
  const push = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    if (!seenUrl.has(raw)) {
      seenUrl.add(raw);
      if (urls.length < 200) urls.push(raw);
    }
    try {
      const h = new URL(raw).host;
      if (h && !seenHost.has(h)) { seenHost.add(h); hosts.push(h); }
    } catch {}
  };
  push(state.startUrl);
  for (const t of state.tabTimeline) push(t.url);
  for (const a of state.activity) {
    if (a.kind === 'navigation') push(a.to);
    else if (a.kind === 'tab_switch') push(a.toUrl);
    else if (a.url) push(a.url);
  }
  return { urls, hosts: hosts.sort() };
}

async function assembleBundle(audioBytes, { zip = true } = {}) {
  const endedAt = Date.now();
  const bundleConfig = await getConfig();
  const bundleDenylist = await getActiveDenylist();

  // events.json: filter activity to the interaction kinds; drop the activity id.
  const events = state.activity
    .filter((a) => EVENT_KINDS.has(a.kind))
    .map(({ id, ...rest }) => rest);

  const { urls, hosts } = summarizeUrls();

  const manifest = {
    format: 'recaptain-recording/2.2',
    id: crypto.randomUUID(),
    label: state.label,
    description: state.description || null,
    start_url: state.startUrl,
    hosts,
    urls,
    started_at: new Date(state.startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    duration_ms: endedAt - state.startedAt,
    total_waiting_ms: state.totalWaitingMs,
    events_count: events.length,
    screenshots_count: state.screenshots.length,
    console_count: state.consoleEntries.length,
    tabs_count: state.tabTimeline.length,
    pages_count: 0, // filled in below, after buildPagesJson runs
    mic: state.mic,
    mic_device_id: state.micDeviceId || null,
    capture_shots: state.captureShots,
    capture_network: state.captureNetwork,
    capture_network_body: state.captureNetwork && state.captureNetworkBody,
    viewport: state.viewport,
    privacy: {
      ...PRIVACY_MANIFEST,
      denylist: bundleDenylist,
      denylistEnabled: !!bundleConfig.denylistEnabled,
    },
    waiting_semantics: {
      description: 'Windows where the page was busy (network / spinner / DOM churn) AND the operator was idle. Screenshots drop to 30s cadence, mic is paused, time does not count against the session cap.',
      signals: ['network_active', 'spinner_visible', 'dom_churn', 'manual'],
      screenshot_interval_ms_active: SCREENSHOT_INTERVAL_MS,
      screenshot_interval_ms_waiting: WAITING_SCREENSHOT_INTERVAL_MS,
    },
    capture_model: {
      kind: 'semantic',
      event_kinds: Array.from(EVENT_KINDS),
      locators: 'Playwright-style: getByTestId / getByRole / getByLabel / getByPlaceholder / getByText / locator(css)',
      notes: 'No DOM snapshot. Each event carries a target descriptor with Playwright locator suggestions, ordered by preferred stability.',
    },
    user_agent: navigator.userAgent,
    extension_version: chrome.runtime.getManifest().version,
  };

  const shotExt = (mime) => (mime === 'image/jpeg' ? 'jpg' : 'png');
  const shotIndex = state.screenshots.map((s, i) => ({
    file: `screenshots/${String(i).padStart(4, '0')}.${shotExt(s.mime)}`,
    t: s.t,
    reason: s.reason,
    tab_id: s.tab_id,
    url: scrubUrl(s.url),
    mime: s.mime,
    bytes: s.bytes?.byteLength ?? 0,
    mask_rects: s.mask_rects || [],
    redaction_mode: s.redaction_mode || 'off',
  }));

  // Consumer-facing docs baked into the bundle. Sibling build step copies
  // these into dist/ under the extension origin.
  const readmeText = await fetchExtensionFile(
    'consumer-readme.md',
    '# Recaptain Recording Bundle\n\n(consumer-readme.md missing from extension build)\n',
  );
  const promptText = await fetchExtensionFile(
    'consumer-prompt.md',
    '# LLM Conversion Prompt\n\n(consumer-prompt.md missing from extension build)\n',
  );

  // pages.json + RECAP.md: session digest derived from landmark_snapshot
  // events. buildPagesJson dedupes by canonical URL and assigns stable IDs.
  const landmarkEvents = state.activity.filter((a) => a.kind === 'landmark_snapshot');
  const pages = buildPagesJson(landmarkEvents, shotIndex);
  manifest.pages_count = pages.length;

  const recapMd = buildRecapMd({
    manifest,
    events,
    pages,
    tabTimeline: state.tabTimeline,
  });

  // replay.spec.ts: mechanical Playwright test (no LLM in the loop).
  let replaySpec = '';
  try {
    replaySpec = exportPlaywrightSpec({
      manifest,
      events,
      screenshotsIndex: shotIndex,
      console: state.consoleEntries,
    });
  } catch {
    replaySpec = '// replay.spec.ts generation failed at bundle time.\n';
  }

  const files = {
    'events.json': strToU8(JSON.stringify(events)),
    'screenshots/index.json': strToU8(JSON.stringify(shotIndex, null, 2)),
    'console.json': strToU8(JSON.stringify(state.consoleEntries)),
    'tabs.json': strToU8(JSON.stringify(state.tabTimeline, null, 2)),
    'pages.json': strToU8(JSON.stringify(pages, null, 2)),
    'RECAP.md': strToU8(recapMd),
    'replay.spec.ts': strToU8(replaySpec),
    'README.md': strToU8(readmeText),
    'PROMPT.md': strToU8(promptText),
  };

  for (const [i, shot] of state.screenshots.entries()) {
    files[`screenshots/${String(i).padStart(4, '0')}.${shotExt(shot.mime)}`] = shot.bytes;
  }

  if (audioBytes && audioBytes.byteLength > 0) {
    files['audio.webm'] = audioBytes;
    manifest.audio = { file: 'audio.webm', mime: 'audio/webm' };
  }

  // Self-contained HTML viewer: index.html with JSON data inlined into
  // <script type="application/json"> tags, plus companion CSS/JS. Works from
  // file:// after the consumer unzips the bundle. Binaries (screenshots,
  // audio) load via normal <img>/<audio> tags relative to index.html.
  try {
    const viewerHtmlTpl = await fetchExtensionFile('viewer/viewer.html', '');
    const viewerCss = await fetchExtensionFile('viewer/viewer.css', '');
    const viewerJs = await fetchExtensionFile('viewer/viewer.js', '');
    if (viewerHtmlTpl) {
      // Escape </script> via < so a captured page can't smuggle the
      // closing tag out of an inline JSON block.
      const inject = (data) => JSON.stringify(data).replace(/</g, '\\u003c');
      const indexHtml = viewerHtmlTpl
        .replace('__MANIFEST_JSON__', inject(manifest))
        .replace('__EVENTS_JSON__', inject(events))
        .replace('__CONSOLE_JSON__', inject(state.consoleEntries))
        .replace('__TABS_JSON__', inject(state.tabTimeline))
        .replace('__SHOTS_JSON__', inject(shotIndex));
      files['index.html'] = strToU8(indexHtml);
      if (viewerCss) files['viewer.css'] = strToU8(viewerCss);
      if (viewerJs) files['viewer.js'] = strToU8(viewerJs);
    }
  } catch {
    // Viewer injection is a nice-to-have; a failure must not block the
    // bundle from being downloadable.
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = zip ? zipSync(files, { level: 6 }) : null;
  return { zipped, manifest, files };
}

function bundleSlugs(manifest) {
  const labelSlug = (manifest.label || '')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Local-time YYMMDD-HHMM. Short and human-scannable; seconds aren't needed
  // for uniqueness because the write layer auto-suffixes -2/-3 on collision.
  const d = new Date(manifest.started_at);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    String(d.getFullYear()).slice(2) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) + '-' +
    pad(d.getHours()) +
    pad(d.getMinutes());
  const base = labelSlug ? `recaptain-rec-${labelSlug}-${stamp}` : `recaptain-rec-${stamp}`;
  return { labelSlug, stamp, folder: base, zipName: `${base}.zip` };
}

function uint8ToBase64(bytes) {
  // btoa needs a binary string; build it in chunks to avoid stack-overflow
  // on String.fromCharCode.apply for large arrays.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(bin);
}

async function downloadBundle({ zipped, manifest }) {
  const { zipName } = bundleSlugs(manifest);

  // The SW has no URL.createObjectURL. Route the bytes to the offscreen doc,
  // which creates a blob URL and hands it back. This sidesteps the ~200MB
  // ceiling of the data: URL path we used to take.
  await ensureOffscreen({ needMic: false });
  const buf = zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  );
  let blobId = null;
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'bundle:blob-url',
      bytes: buf,
      mime: 'application/zip',
    });
    if (!res?.ok) throw new Error(res?.error || 'bundle blob url failed');
    blobId = res.id;
    await chrome.downloads.download({ url: res.url, filename: zipName, saveAs: state.saveAs !== false });
  } finally {
    // Give Chrome a beat to start streaming from the blob before revoking.
    // The download is set up synchronously, but any in-flight reads hold a
    // strong ref even after revoke, so this is safe.
    if (blobId) {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'bundle:revoke',
          id: blobId,
        }).catch(() => {});
      }, 1000);
    }
  }
}

function serializeError(err) {
  if (!err) return { message: 'unknown error' };
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || null,
  };
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  handleTabSwitch(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  handleTabUrlChange(tabId, changeInfo).catch(() => {});
});

function handlePermissionsChanged(perms, added) {
  if (!state.recording) return;
  // Update the hot-path gate immediately, then re-read the complete grant
  // set inside the serialized refresh.
  applyPermissionDelta(perms, added);
  queueRecorderAccessRefresh().catch(() => {});
}

chrome.permissions.onAdded.addListener((perms) => handlePermissionsChanged(perms, true));
chrome.permissions.onRemoved.addListener((perms) => handlePermissionsChanged(perms, false));

onConfigChanged((config) => {
  if (!state.recording) return;
  applyCachedConfig(config);
  schedulePersist();
  queueRecorderAccessRefresh().catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  sidepanelPorts.add(port);
  // Rehydrate before we send the sidepanel its initial activity dump;
  // otherwise a newly-opened panel right after SW wake would see empty
  // state briefly.
  rehydrateIfNeeded().finally(() => {
    try {
      port.postMessage({ type: 'activity:init', entries: state.activity });
      port.postMessage({ type: 'recording:state', recording: state.recording, paused: state.paused });
    } catch {}
  });
  port.onDisconnect.addListener(() => {
    sidepanelPorts.delete(port);
  });
});

// The extension has no popup; clicking the action icon opens the side panel.
async function configureSidePanel() {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch {}
}
chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
configureSidePanel();

// Rehydrate an in-flight recording if the SW was killed mid-session and is
// now being woken by an event. Only text state is restored; microphone
// audio cumulated in the offscreen doc is lost because MediaRecorder can't
// span a SW crash. We mark the rehydrate in the activity stream so the
// bundle is honest about the gap.
let rehydrateDone = null;
async function rehydrateIfNeeded() {
  if (rehydrateDone) return rehydrateDone;
  rehydrateDone = (async () => {
    const { meta, activity, consoleEntries } = await loadPersistedState();
    if (!meta || !meta.recording) return;

    state.recording = true;
    state.paused = !!meta.paused;
    state.pausedAt = meta.pausedAt ?? null;
    state.totalPausedMs = meta.totalPausedMs || 0;
    state.startedAt = meta.startedAt;
    state.label = meta.label ?? null;
    state.description = meta.description ?? null;
    state.mic = !!meta.mic;
    state.micDeviceId = meta.micDeviceId ?? null;
    state.startUrl = meta.startUrl ?? null;
    state.tabId = meta.tabId ?? null;
    state.currentTabUrl = meta.currentTabUrl ?? null;
    state.viewport = meta.viewport ?? null;
    state.tabTimeline = Array.isArray(meta.tabTimeline) ? meta.tabTimeline : [];
    state.activitySeq = meta.activitySeq || 0;
    state.lastActivityAt = meta.lastActivityAt || null;
    state.shotBytesTotal = meta.shotBytesTotal || 0;
    state.shotCompressed = !!meta.shotCompressed;
    state.activity = activity;
    state.consoleEntries = consoleEntries;
    state.screenshots = await loadScreenshots();
    state.captureShots = !!meta.captureShots;
    state.redactionMode = (meta.redactionMode === 'blur' || meta.redactionMode === 'off') ? meta.redactionMode : 'black';
    state.captureNetwork = !!meta.captureNetwork;
    state.captureNetworkBody = !!meta.captureNetworkBody;
    state.waiting = !!meta.waiting;
    state.waitingSince = meta.waitingSince ?? null;
    state.totalWaitingMs = meta.totalWaitingMs || 0;
    state.manualWaiting = !!meta.manualWaiting;
    state.primaryNav = meta.primaryNav || null;
    state.pagesVisited = new Set(Array.isArray(meta.pagesVisited) ? meta.pagesVisited : []);
    const persistedAccessNotes = Array.isArray(meta.accessNoteKeys)
      ? meta.accessNoteKeys
      : activity.map((entry) => entry?.access_policy).filter(Boolean);
    state.accessNoteKeys = new Set(persistedAccessNotes);

    pushActivity({
      kind: 'note',
      t: activeElapsedMs(),
      ts: Date.now(),
      text: '[auto] recording resumed after service worker restart; mic audio from before this point was lost.',
    });

    await queueRecorderAccessRefresh();
    startPeriodicScreenshots();
    broadcastRecordingState();
  })();
  try { await rehydrateDone; } catch { rehydrateDone = null; }
}

chrome.runtime.onStartup.addListener(() => { rehydrateIfNeeded().catch(() => {}); });
rehydrateIfNeeded().catch(() => {});

// Test hook: exposes a handful of functions so e2e tests can drive the
// recorder from the SW context via `sw.evaluate(...)` without depending on
// the sidepanel UI. Size is negligible and access is limited to contexts
// that can already reach the SW (extension-internal).
//
// `stopAndPackage` is the test-only shortcut that skips chrome.downloads
// (which isn't reliably observable from Playwright) and returns the zipped
// bundle bytes directly. Returns a regular Array so it survives structured
// clone across the Playwright evaluate boundary.
async function stopAndPackage() {
  if (!state.recording) throw new Error('not recording');
  state.recording = false;
  broadcastRecordingState();
  await recorderAccessRefresh.catch(() => {});
  await unregisterRecorderContentScript();
  if (periodicShotHandle != null) { clearInterval(periodicShotHandle); periodicShotHandle = null; }
  const last = state.tabTimeline[state.tabTimeline.length - 1];
  if (last && last.left_at == null) last.left_at = Date.now();
  let audioBytes = null;
  if (state.mic) {
    try { const r = await sendToOffscreen('mic:stop'); if (r?.ok && r.bytes) audioBytes = new Uint8Array(r.bytes); } catch {}
  }
  const bundle = await assembleBundle(audioBytes);
  await closeOffscreen();
  await clearPersistedState();
  reset();
  return Array.from(bundle.zipped);
}

async function startForTest(options = {}) {
  // The legacy e2e hook starts with screenshots on. Keep that isolated test
  // contract while the production path follows the persisted opt-in default.
  await rehydrateIfNeeded();
  await setConfig({ captureShots: options.captureShots ?? true });
  return start(options);
}

self.__recaptainTest = {
  start: startForTest,
  stop,
  pause,
  resume,
  getState: () => state,
  stopAndPackage,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Ensure any in-flight recording is restored before handling the
      // message; otherwise a fresh onMessage could race a wake-time
      // rehydrate and see stale state.
      await rehydrateIfNeeded();
      if (msg?.type === 'recorder:start') {
        // Preserve the existing message contract while making storage-backed
        // config the single screenshot gate.
        if (typeof msg.captureShots === 'boolean') {
          await setConfig({ captureShots: msg.captureShots });
        }
        await start({
          label: msg.label,
          mic: msg.mic,
          micDeviceId: msg.micDeviceId,
          description: msg.description || null,
          saveAs: msg.saveAs,
          redactionMode: msg.redactionMode,
          captureNetwork: msg.captureNetwork,
          captureNetworkBody: msg.captureNetworkBody,
        });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:mark-waiting') {
        // Relay to the active tab's content script, which toggles the
        // manual-waiting flag on its detector. The detector will then emit
        // the corresponding waiting_start / waiting_end through the normal
        // activity:push path, so waiting-window state converges on its own.
        // We also track the manual flag here so the sidepanel can render the
        // right button label (the button state lives in the SW, not the
        // content script, since content scripts die across navigations).
        state.manualWaiting = !!msg.active;
        if (state.recording && state.tabId != null) {
          try { await chrome.tabs.sendMessage(state.tabId, { type: 'recorder:mark-waiting', active: !!msg.active }); } catch {}
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'nav:detected') {
        if (state.recording && senderCanRecord(sender) && msg.nav) state.primaryNav = msg.nav;
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:stop') {
        const res = await stop({
          target: msg.target === 'project' ? 'project' : 'download',
          projectName: msg.projectName || null,
        });
        sendResponse({ ok: true, ...res });
        return;
      }
      if (msg?.type === 'recorder:pause') {
        await pause();
        sendResponse({ ok: true, paused: state.paused });
        return;
      }
      if (msg?.type === 'recorder:resume') {
        await resume();
        sendResponse({ ok: true, paused: state.paused });
        return;
      }
      if (msg?.type === 'recorder:download-last') {
        // Fallback path: sidepanel tried to write to a project folder but
        // failed (permission revoked, disk full, etc.); re-bundle as zip
        // and hand off to chrome.downloads so the recording isn't lost.
        if (!lastAssembled) { sendResponse({ ok: false, error: { message: 'no bundle to download' } }); return; }
        let { zipped, manifest, files } = lastAssembled;
        if (!zipped) zipped = zipSync(files, { level: 6 });
        await downloadBundle({ zipped, manifest });
        await closeOffscreen();
        lastAssembled = null;
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:clear-last') {
        lastAssembled = null;
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:status') {
        const eventsCount = state.activity.reduce((n, a) => n + (EVENT_KINDS.has(a.kind) ? 1 : 0), 0);
        sendResponse({
          recording: state.recording,
          paused: state.paused,
          startedAt: state.startedAt,
          activeMs: activeElapsedMs(),
          maxMs: SESSION_MAX_MS,
          warnMs: SESSION_WARN_MS,
          eventsCount,
          shotsCount: state.screenshots.length,
          consoleCount: state.consoleEntries.length,
          tabsCount: state.tabTimeline.length,
          mic: state.mic,
          micLevel: state.micLevel,
          micLevelAt: state.micLevelAt,
          waiting: state.waiting,
          waitingSince: state.waitingSince,
          totalWaitingMs: state.totalWaitingMs,
          manualWaiting: state.manualWaiting,
          coverage: coverageSnapshot(),
        });
        return;
      }
      if (msg?.type === 'console:entry') {
        if (state.recording && !state.paused && senderCanRecord(sender)) {
          const t = msg.ts - state.startedAt;
          const scrubbed = scrubUrl(msg.url);
          const entry = {
            level: msg.level,
            ts: msg.ts,
            t,
            url: scrubbed,
            tab_id: sender?.tab?.id ?? null,
            args: Array.isArray(msg.args) ? msg.args : [],
          };
          state.consoleEntries.push(entry);
          pushActivity({
            kind: 'console',
            t,
            level: msg.level,
            url: scrubbed,
            tab_id: entry.tab_id,
            args: entry.args,
          });
          // pushActivity already scheduled a flush; nothing else to do.
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'activity:push') {
        if (state.recording && !state.paused && senderCanRecord(sender) && Array.isArray(msg.entries)) {
          let shouldShoot = false;
          // Track the *last* pushed entry of a trigger kind in this batch so
          // we can stamp it with screenshot_id after the capture resolves.
          // If multiple trigger kinds fire in a single batch we only stamp
          // the last one: single screenshot, single owning event.
          let lastTriggerEntry = null;
          let waitingStateChanged = false;
          for (const e of msg.entries) {
            const withTime = normalizeIncomingEvent(e, sender?.tab?.id ?? null);
            const pushed = pushActivity(withTime);
            if (SHOT_TRIGGER_KINDS.has(withTime.kind)) {
              shouldShoot = true;
              lastTriggerEntry = pushed;
            }
            if (withTime.kind === 'waiting_start') {
              state.waiting = true;
              state.waitingSince = Date.now();
              state.peakInFlightThisWait = 0;
              if (state.mic) { try { await sendToOffscreen('mic:pause'); } catch {} }
              waitingStateChanged = true;
            }
            if (withTime.kind === 'waiting_end') {
              if (state.waitingSince) state.totalWaitingMs += Date.now() - state.waitingSince;
              if (typeof withTime.peak_reqs === 'number' && withTime.peak_reqs > state.peakInFlightThisWait) {
                state.peakInFlightThisWait = withTime.peak_reqs;
              }
              state.waiting = false;
              state.waitingSince = null;
              if (state.mic) { try { await sendToOffscreen('mic:resume'); } catch {} }
              waitingStateChanged = true;
            }
            if (withTime.kind === 'landmark_snapshot' && withTime.url) {
              state.pagesVisited.add(canonicalUrl(withTime.url));
            }
          }
          if (shouldShoot) {
            const shotId = await takeScreenshot('interaction');
            if (typeof shotId === 'number' && lastTriggerEntry) {
              lastTriggerEntry.screenshot_id = shotId;
            }
          }
          if (waitingStateChanged) broadcastWaitingState();
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:marker') {
        if (state.recording) {
          const label = typeof msg.label === 'string' ? msg.label.slice(0, 200) : '';
          pushActivity({ kind: 'marker', label, ts: Date.now(), t: nowT() });
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:note') {
        if (state.recording) {
          const text = typeof msg.text === 'string' ? msg.text.slice(0, 2000) : '';
          pushActivity({ kind: 'note', text, ts: Date.now(), t: nowT() });
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'mic:level') {
        state.micLevel = typeof msg.level === 'number' ? msg.level : 0;
        state.micLevelAt = Date.now();
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'recorder:content-ready') {
        sendResponse({
          recording: state.recording && !state.paused && senderCanRecord(sender),
          captureNetwork: state.captureNetwork,
          captureNetworkBody: state.captureNetworkBody,
        });
        return;
      }
    } catch (err) {
      sendResponse({ error: serializeError(err) });
    }
  })();
  return true;
});
