import {
  listProjects, saveProject, deleteProject, touchProject,
  queryPermission, requestPermission, pickDirectory,
} from './projects.js';
import {
  getConfig, setConfig, onConfigChanged, DEFAULT_CONFIG, BUILTIN_DENYLIST,
} from '../shared/access-config.js';
import { canonicalize, isValidPattern } from '../shared/match-patterns.js';

// ───────────────────────────────────────────────────────────────────────
// Elements
// ───────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const idlePanel = $('idle-panel');
const activePanel = $('active-panel');

const labelInput = $('label');
const descriptionInput = $('description');
const micInput = $('mic');
const micDeviceRow = $('mic-device-row');
const micDeviceSelect = $('mic-device');
const micDot = $('mic-dot');
const micText = $('mic-text');
const micManage = $('mic-manage');

const captureShotsInput = $('capture-shots');
const followTabsInput = $('follow-tabs');
const captureAccessFeedback = $('capture-access-feedback');
const captureNetworkInput = $('capture-network');
const captureNetworkBodyInput = $('capture-network-body');

const startBtn = $('start');
const accessSection = $('access-section');
const accessWhyHost = $('access-why-host');
const modeAllowed = $('mode-allowed');
const modeAll = $('mode-all');
const accessAllmode = $('access-allmode');
const allNeedsGrant = $('all-needs-grant');
const scopeText = $('scope-text');
const scopeRevoke = $('scope-revoke');
const grantCurrentAccessBtn = $('grant-current-access');
const grantAccessBtn = $('grant-access');
const accessWhy = $('access-why');
const accessGranted = $('access-granted');
const accessRestricted = $('access-restricted');
const accessRestrictedCopy = $('access-restricted-copy');
const accessGrantedCopy = $('access-granted-copy');
const accessAllowlistEl = $('access-allowlist');
const accessOrigins = $('access-origins');
const accessEmpty = $('access-empty');
const accessFeedback = $('access-feedback');
const captureHint = $('capture-hint');
const quickGrantBtn = $('quick-grant');
const allowlistEdit = $('allowlist-edit');
const allowlistMore = $('allowlist-more');
const allowlistEditor = $('allowlist-editor');
const allowlistText = $('allowlist-text');
const allowlistSave = $('allowlist-save');
const allowlistCancel = $('allowlist-cancel');
const denylistOrigins = $('denylist-origins');
const denylistEdit = $('denylist-edit');
const denylistMore = $('denylist-more');
const denylistEditor = $('denylist-editor');
const denylistText = $('denylist-text');
const denylistSave = $('denylist-save');
const denylistReset = $('denylist-reset');
const denylistCancel = $('denylist-cancel');
const stopBtn = $('stop');

const LIST_TRUNCATE = 4;
let allowlistExpanded = false;
let denylistExpanded = false;
const pauseBtn = $('pause');
const markWaitingBtn = $('mark-waiting');
const pausedBanner = $('paused-banner');
const waitingBanner = $('waiting-banner');
const coverageLine = $('coverage-line');
const timerRemainingEl = $('timer-remaining');

const stepLabelInput = $('step-label');
const markStepBtn = $('mark-step');
const noteTextInput = $('note-text');
const postNoteBtn = $('post-note');

const timerEl = $('timer');
const eventsEl = $('events-count');
const shotsEl = $('shots-count');
const consoleCountEl = $('console-count');
const tabsCountEl = $('tabs-count');

const meterWrap = $('meter-wrap');
const meterBar = $('meter-bar');
const meterWarning = $('meter-warning');

const errorBox = $('error-box');
const errorText = $('error-text');
const copyErrBtn = $('copy-error');
const dismissErrBtn = $('dismiss-error');

const feedEl = $('feed');
const emptyEl = $('empty');
const feedCountsEl = $('feed-counts');
const filterText = $('filter-text');
const filterType = $('filter-type');
const clearActivityBtn = $('clear-activity');
const autoscrollEl = $('autoscroll');

const projectSelect = $('project-select');
const projectNewBtn = $('project-new');
const projectRemoveBtn = $('project-remove');
const projectInfo = $('project-info');
const projectFolderName = $('project-folder-name');
const projectPermDot = $('project-perm-dot');
const projectBanner = $('project-banner');
const postStopBanner = $('post-stop-banner');

const ERROR_STORAGE_KEY = 'lastError';
const MIC_DEVICE_STORAGE_KEY = 'micDeviceId';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectName';
const CAPTURE_NETWORK_STORAGE_KEY = 'captureNetwork';
const CAPTURE_NETWORK_BODY_STORAGE_KEY = 'captureNetworkBody';

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────
function fmt(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function fmtRelTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  const frac = String(Math.floor((ms % 1000) / 100));
  return `${m}:${s}.${frac}`;
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ───────────────────────────────────────────────────────────────────────
// Error display: persistent, copyable
// ───────────────────────────────────────────────────────────────────────
function formatError(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.name && err.name !== 'Error') parts.unshift(`[${err.name}]`);
  if (err.stack) parts.push('', err.stack);
  return parts.join('\n') || String(err);
}

async function showError(err) {
  const text = formatError(err);
  errorText.textContent = text;
  errorBox.classList.remove('hidden');
  copyErrBtn.classList.remove('copied');
  copyErrBtn.textContent = 'copy';
  try { await chrome.storage.local.set({ [ERROR_STORAGE_KEY]: { text, at: Date.now() } }); } catch {}
}

async function clearError() {
  errorText.textContent = '';
  errorBox.classList.add('hidden');
  try { await chrome.storage.local.remove(ERROR_STORAGE_KEY); } catch {}
}

async function restoreError() {
  try {
    const { [ERROR_STORAGE_KEY]: saved } = await chrome.storage.local.get(ERROR_STORAGE_KEY);
    if (saved?.text) {
      errorText.textContent = saved.text;
      errorBox.classList.remove('hidden');
    }
  } catch {}
}

copyErrBtn.addEventListener('click', async () => {
  const text = errorText.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    copyErrBtn.textContent = 'copied';
    copyErrBtn.classList.add('copied');
    setTimeout(() => {
      copyErrBtn.textContent = 'copy';
      copyErrBtn.classList.remove('copied');
    }, 1500);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(errorText);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});
dismissErrBtn.addEventListener('click', () => { clearError(); });

function errFromResponse(res) {
  const e = res?.error;
  if (!e) return null;
  if (typeof e === 'string') return new Error(e);
  const err = new Error(e.message || 'unknown error');
  if (e.name) err.name = e.name;
  if (e.stack) err.stack = e.stack;
  return err;
}

// ───────────────────────────────────────────────────────────────────────
// Microphone: device picker + permission indicator
// ───────────────────────────────────────────────────────────────────────
function updateMicDeviceVisibility() {
  const on = micInput.checked;
  micDeviceRow.classList.toggle('hidden', !on);
  const micStatus = $('mic-status');
  const micWhy = $('mic-why');
  if (micStatus) micStatus.classList.toggle('hidden', !on);
  if (micWhy) micWhy.classList.toggle('hidden', !on);
}

async function refreshMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const prev = micDeviceSelect.value;
    micDeviceSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default microphone';
    micDeviceSelect.appendChild(defaultOpt);
    for (const m of mics) {
      if (!m.deviceId || m.deviceId === 'default') continue;
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || `Microphone (${m.deviceId.slice(0, 6)}…)`;
      micDeviceSelect.appendChild(opt);
    }
    if (prev && [...micDeviceSelect.options].some((o) => o.value === prev)) {
      micDeviceSelect.value = prev;
    } else {
      try {
        const { [MIC_DEVICE_STORAGE_KEY]: saved } = await chrome.storage.local.get(MIC_DEVICE_STORAGE_KEY);
        if (saved) micDeviceSelect.value = saved;
      } catch {}
    }
  } catch {}
}

micDeviceSelect.addEventListener('change', async () => {
  try { await chrome.storage.local.set({ [MIC_DEVICE_STORAGE_KEY]: micDeviceSelect.value }); } catch {}
});
micInput.addEventListener('change', updateMicDeviceVisibility);

function updateNetworkBodyAvailability() {
  const on = captureNetworkInput.checked;
  captureNetworkBodyInput.disabled = !on;
  if (!on) captureNetworkBodyInput.checked = false;
}
captureNetworkInput.addEventListener('change', async () => {
  updateNetworkBodyAvailability();
  try { await chrome.storage.local.set({ [CAPTURE_NETWORK_STORAGE_KEY]: captureNetworkInput.checked }); } catch {}
});
captureNetworkBodyInput.addEventListener('change', async () => {
  try { await chrome.storage.local.set({ [CAPTURE_NETWORK_BODY_STORAGE_KEY]: captureNetworkBodyInput.checked }); } catch {}
});

async function restoreCaptureSettings() {
  try {
    const got = await chrome.storage.local.get([
      CAPTURE_NETWORK_STORAGE_KEY,
      CAPTURE_NETWORK_BODY_STORAGE_KEY,
    ]);
    if (typeof got[CAPTURE_NETWORK_STORAGE_KEY] === 'boolean') captureNetworkInput.checked = got[CAPTURE_NETWORK_STORAGE_KEY];
    if (typeof got[CAPTURE_NETWORK_BODY_STORAGE_KEY] === 'boolean') captureNetworkBodyInput.checked = got[CAPTURE_NETWORK_BODY_STORAGE_KEY];
  } catch {}
  updateNetworkBodyAvailability();
}
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', refreshMicDevices);
}

async function refreshMicStatus() {
  let s = 'unknown';
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    s = p.state;
    p.onchange = () => refreshMicStatus();
  } catch {}
  micDot.classList.remove('granted', 'denied', 'prompt');
  if (s === 'granted') {
    micDot.classList.add('granted');
    micText.textContent = 'permission granted';
    micManage.textContent = 'revoke';
  } else if (s === 'denied') {
    micDot.classList.add('denied');
    micText.textContent = 'blocked';
    micManage.textContent = 'unblock';
  } else if (s === 'prompt') {
    micDot.classList.add('prompt');
    micText.textContent = 'will ask on Start';
    micManage.textContent = 'manage';
  } else {
    micText.textContent = 'status unknown';
    micManage.textContent = 'manage';
  }
}

micManage.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://settings/content/microphone' });
});

async function ensureMicPermission() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state === 'granted') return;
  } catch {}
  await chrome.tabs.create({
    url: chrome.runtime.getURL('permission.html'),
    active: true,
  });
  throw new Error(
    'Microphone permission not granted yet. A new tab was opened to grant access; after it closes, click "Start recording" again.'
  );
}

// ───────────────────────────────────────────────────────────────────────
// Projects: selection, creation, permission state
// ───────────────────────────────────────────────────────────────────────
const projectState = {
  list: [],            // [{name, dirHandle, createdAt, lastUsedAt}]
  activeName: null,    // selected project name, or null
  permission: 'prompt' // 'granted' | 'prompt' | 'denied'
};

function activeProject() {
  if (!projectState.activeName) return null;
  return projectState.list.find((p) => p.name === projectState.activeName) || null;
}

function renderProjectUI() {
  const prev = projectSelect.value;
  projectSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '- no project (download as zip) -';
  projectSelect.appendChild(none);
  for (const p of projectState.list) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    projectSelect.appendChild(opt);
  }
  projectSelect.value = projectState.activeName ?? prev ?? '';

  const ap = activeProject();
  if (ap) {
    projectInfo.classList.remove('hidden');
    projectRemoveBtn.classList.remove('hidden');
    const folderLabel = ap.dirHandle?.name ? `${ap.dirHandle.name}/` : '(folder unavailable)';
    projectFolderName.textContent = folderLabel;
    projectPermDot.classList.remove('granted', 'prompt', 'denied');
    projectPermDot.classList.add(projectState.permission);
    projectPermDot.title = ({
      granted: 'Folder access granted; recording will save here',
      prompt: 'Folder access will be requested on Start',
      denied: 'Folder access denied; Start will fall back to zip download',
    })[projectState.permission] || '';
    stopBtn.textContent = `Stop & save to ${ap.name}`;
  } else {
    projectInfo.classList.add('hidden');
    projectRemoveBtn.classList.add('hidden');
    stopBtn.textContent = 'Stop & download';
  }
}

function showProjectBanner(message, actions = []) {
  projectBanner.innerHTML = '';
  const line = document.createElement('div');
  line.textContent = message;
  projectBanner.appendChild(line);
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'banner-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      row.appendChild(btn);
    }
    projectBanner.appendChild(row);
  }
  projectBanner.classList.remove('hidden');
}
function hideProjectBanner() { projectBanner.classList.add('hidden'); projectBanner.innerHTML = ''; }

function showPostStopBanner(message, actions = []) {
  postStopBanner.innerHTML = '';
  const line = document.createElement('div');
  line.textContent = message;
  postStopBanner.appendChild(line);
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'banner-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = a.label;
      btn.addEventListener('click', async () => {
        try { await a.onClick(); } finally { /* leave banner decision to handler */ }
      });
      row.appendChild(btn);
    }
    postStopBanner.appendChild(row);
  }
  postStopBanner.classList.remove('hidden');
}
function hidePostStopBanner() { postStopBanner.classList.add('hidden'); postStopBanner.innerHTML = ''; }

async function refreshProjectPermission() {
  const ap = activeProject();
  if (!ap) { projectState.permission = 'prompt'; return; }
  projectState.permission = await queryPermission(ap.dirHandle);
}

async function loadProjects() {
  try {
    projectState.list = await listProjects();
  } catch {
    projectState.list = [];
  }
  try {
    const { [ACTIVE_PROJECT_STORAGE_KEY]: saved } = await chrome.storage.local.get(ACTIVE_PROJECT_STORAGE_KEY);
    projectState.activeName = saved && projectState.list.some((p) => p.name === saved) ? saved : null;
  } catch {
    projectState.activeName = null;
  }
  await refreshProjectPermission();
  renderProjectUI();
}

async function setActiveProject(name) {
  projectState.activeName = name || null;
  try { await chrome.storage.local.set({ [ACTIVE_PROJECT_STORAGE_KEY]: projectState.activeName }); } catch {}
  await refreshProjectPermission();
  renderProjectUI();
  hideProjectBanner();
}

projectSelect.addEventListener('change', () => {
  setActiveProject(projectSelect.value || null);
});

projectNewBtn.addEventListener('click', async () => {
  projectNewBtn.disabled = true;
  try {
    // Chrome requires showDirectoryPicker() to be called SYNCHRONOUSLY under
    // the click's user-gesture token. Any prior prompt()/await would consume
    // the token and fail with SecurityError. So: pick first, name after.
    let dirHandle;
    try {
      dirHandle = await pickDirectory();
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled the picker
      throw err;
    }
    const suggested = dirHandle?.name || 'project';
    const name = (window.prompt('Project name:', suggested) || '').trim();
    if (!name) return;
    if (projectState.list.some((p) => p.name === name)) {
      throw new Error(`A project named "${name}" already exists. Remove it first or pick a different name.`);
    }
    const project = { name, dirHandle, createdAt: Date.now(), lastUsedAt: Date.now() };
    await saveProject(project);
    projectState.list = await listProjects();
    await setActiveProject(name);
  } catch (err) {
    await showError(err);
  } finally {
    projectNewBtn.disabled = false;
  }
});

projectRemoveBtn.addEventListener('click', async () => {
  const ap = activeProject();
  if (!ap) return;
  if (!window.confirm(`Remove project "${ap.name}"? (Your folder and its files stay on disk.)`)) return;
  try {
    await deleteProject(ap.name);
    projectState.list = await listProjects();
    await setActiveProject(null);
  } catch (err) {
    await showError(err);
  }
});

// ───────────────────────────────────────────────────────────────────────
// Site access and broad-capability config
// ───────────────────────────────────────────────────────────────────────
const ALL_SITES_PATTERN = '<all_urls>';
const ALL_SITES_PERMISSION = { origins: [ALL_SITES_PATTERN] };
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const RESTRICTED_PROTOCOLS = new Set([
  'about:', 'chrome:', 'chrome-extension:', 'view-source:',
]);

let accessConfig = { ...DEFAULT_CONFIG };
let configReady = false;
let configTogglePending = null;
let configToggleDesired = null;
let currentGrantPending = false;
let allSitesGrantPending = false;
let startPending = false;
let accessRefreshSequence = 0;

const accessState = {
  loading: true,
  site: null,
  grantedOrigins: [],
  permissionsKnown: false,
  hasAllSites: false,
  currentGranted: false,
};

function setInlineFeedback(el, message, tone = 'warn') {
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
  el.classList.toggle('ok', tone === 'ok');
}

function restrictedSite(reason) {
  return { host: null, pattern: null, url: null, reason };
}

function siteFromTab(tab) {
  const rawUrl = tab?.pendingUrl || tab?.url;
  if (!rawUrl) return restrictedSite('The current tab URL is unavailable.');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return restrictedSite('The current tab URL cannot be used for site access.');
  }

  if (RESTRICTED_PROTOCOLS.has(url.protocol)) {
    return restrictedSite(`${url.protocol} pages do not allow extension site access.`);
  }
  if (url.protocol === 'file:' && !url.hostname) {
    return restrictedSite('Local file pages without a host cannot be granted site access.');
  }
  if (!WEB_PROTOCOLS.has(url.protocol) || !url.hostname) {
    return restrictedSite('Open an http or https site to grant recording access.');
  }

  const input = `${url.protocol}//${url.hostname}/*`;
  if (!isValidPattern(input)) {
    return restrictedSite('This site address cannot be represented as a Chrome match pattern.');
  }

  return {
    host: url.hostname,
    pattern: canonicalize(input),
    url: rawUrl,
    reason: null,
  };
}

async function queryCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return siteFromTab(tab);
  } catch {
    return restrictedSite('Recaptain could not inspect the current tab.');
  }
}

async function getGrantedOrigins() {
  try {
    const permissions = await chrome.permissions.getAll();
    return [...new Set((permissions?.origins || []).filter((origin) => typeof origin === 'string'))]
      .sort((a, b) => {
        if (a === ALL_SITES_PATTERN) return -1;
        if (b === ALL_SITES_PATTERN) return 1;
        return a.localeCompare(b);
      });
  } catch {
    return null;
  }
}

function accessInteractionPending() {
  return Boolean(
    currentGrantPending
    || allSitesGrantPending
    || configTogglePending
    || startPending
  );
}

function renderStartAvailability() {
  // Start records with whatever access is already granted; it never requests
  // access itself. So it stays disabled until the current site is covered by a
  // per-site grant or all-sites access.
  startBtn.disabled = accessInteractionPending()
    || !configReady
    || accessState.loading
    || !accessState.site?.pattern
    || !accessState.currentGranted;
}

// Screenshots and follow-across-tabs live in the Additional-features box and are
// only meaningful under all-sites access. When all-sites is granted the toggles
// are plain config writes (no permission prompt); otherwise the box shows the
// grant button instead of the toggles.
function renderCaptureConfig() {
  const pending = accessInteractionPending();
  captureShotsInput.checked = configTogglePending === 'captureShots'
    ? Boolean(configToggleDesired)
    : Boolean(accessConfig.captureShots);
  followTabsInput.checked = configTogglePending === 'followTabs'
    ? Boolean(configToggleDesired)
    : Boolean(accessConfig.followTabs);
  // Toggles stay clickable without all-sites; enabling one requests it. The hint
  // just explains why the prompt appears.
  captureShotsInput.disabled = !configReady || pending;
  followTabsInput.disabled = !configReady || pending;
  captureHint.classList.toggle('hidden', accessState.hasAllSites);
  renderDenylist();
  renderStartAvailability();
}

function renderGrantedOrigins() {
  const perSite = accessState.grantedOrigins.filter((o) => o !== ALL_SITES_PATTERN);
  const frag = document.createDocumentFragment();
  for (const origin of perSite) {
    const row = document.createElement('li');
    row.className = 'access-origin';

    const label = document.createElement('span');
    label.className = 'access-origin-label';
    label.textContent = origin;
    label.title = origin;

    const remove = document.createElement('button');
    remove.className = 'btn access-remove';
    remove.type = 'button';
    remove.textContent = 'remove';
    remove.disabled = accessInteractionPending();
    remove.setAttribute('aria-label', `Remove ${origin}`);
    remove.addEventListener('click', () => {
      removeGrantedOrigin(origin, remove);
    });

    row.append(label, remove);
    frag.appendChild(row);
  }
  accessOrigins.replaceChildren(frag);
  accessEmpty.classList.toggle('hidden', perSite.length > 0);
  const moreVisible = perSite.length > LIST_TRUNCATE;
  allowlistMore.classList.toggle('hidden', !moreVisible);
  allowlistMore.textContent = allowlistExpanded ? 'Show fewer' : `Show all ${perSite.length}`;
}

function renderList(container, patterns, expanded, mono = true) {
  const frag = document.createDocumentFragment();
  const limit = expanded ? patterns.length : LIST_TRUNCATE;
  for (const p of patterns.slice(0, limit)) {
    const row = document.createElement('li');
    row.className = 'access-origin';
    const label = document.createElement('span');
    label.className = 'access-origin-label';
    if (!mono) label.style.fontFamily = 'inherit';
    label.textContent = p;
    label.title = p;
    row.appendChild(label);
    frag.appendChild(row);
  }
  container.replaceChildren(frag);
}

function renderDenylist() {
  const patterns = Array.isArray(accessConfig.denylist) ? accessConfig.denylist : [];
  renderList(denylistOrigins, patterns, denylistExpanded);
  const moreVisible = patterns.length > LIST_TRUNCATE;
  denylistMore.classList.toggle('hidden', !moreVisible);
  denylistMore.textContent = denylistExpanded ? 'Show fewer' : `Show all ${patterns.length}`;
}

// Short status word shown in the header pill; the accent bar color is driven by
// the data-state on the card.
function setAccessState(state, pill, allowQuickGrant = true) {
  accessSection.dataset.state = state;
  scopeText.textContent = pill;
  // The "+" quick-grant only makes sense for granting the current site.
  const canQuickGrant = allowQuickGrant && state === 'ungranted' && !accessInteractionPending();
  quickGrantBtn.classList.toggle('hidden', !canQuickGrant);
}

function renderAccessUI() {
  const allMode = accessConfig.recordMode === 'all';
  modeAllowed.setAttribute('aria-pressed', String(!allMode));
  modeAll.setAttribute('aria-pressed', String(allMode));
  modeAllowed.classList.toggle('active', !allMode);
  modeAll.classList.toggle('active', allMode);
  modeAllowed.disabled = accessInteractionPending();
  modeAll.disabled = accessInteractionPending();

  accessAllmode.classList.toggle('hidden', !allMode);
  accessAllowlistEl.classList.toggle('hidden', allMode);
  accessWhy.classList.add('hidden');
  accessGranted.classList.add('hidden');
  accessRestricted.classList.add('hidden');

  if (allMode) {
    // "All sites" records everything and needs all-sites permission.
    const granted = accessState.hasAllSites;
    setAccessState(granted ? 'granted' : 'ungranted', granted ? 'all sites' : 'needs grant', false);
    allNeedsGrant.classList.toggle('hidden', granted);
    grantAccessBtn.disabled = accessInteractionPending();
  } else if (accessState.loading) {
    setAccessState('loading', 'checking');
    accessWhy.classList.remove('hidden');
    accessWhyHost.textContent = 'this site';
    grantCurrentAccessBtn.textContent = 'Grant access';
    grantCurrentAccessBtn.disabled = true;
  } else if (!accessState.site?.pattern) {
    setAccessState('restricted', 'unavailable');
    accessRestricted.classList.remove('hidden');
    accessRestrictedCopy.textContent = accessState.site?.reason || 'Site access is unavailable on this page.';
  } else if (accessState.currentGranted) {
    setAccessState('granted', accessState.hasAllSites ? 'all sites' : 'granted');
    accessGranted.classList.remove('hidden');
    accessGrantedCopy.textContent = accessState.hasAllSites
      ? `${accessState.site.host} is covered by all-sites access.`
      : `${accessState.site.host} is ready to record.`;
    const perSiteGrant = !accessState.hasAllSites
      && accessState.grantedOrigins.includes(accessState.site.pattern);
    scopeRevoke.classList.toggle('hidden', !perSiteGrant);
    scopeRevoke.disabled = accessInteractionPending();
  } else {
    setAccessState('ungranted', 'not granted');
    accessWhy.classList.remove('hidden');
    accessWhyHost.textContent = accessState.site.host;
    grantCurrentAccessBtn.textContent = `Grant ${accessState.site.host}`;
    grantCurrentAccessBtn.disabled = accessInteractionPending();
  }

  renderGrantedOrigins();
  renderCaptureConfig();
}

async function refreshAccessUI() {
  const sequence = ++accessRefreshSequence;
  const [site, grantedOrigins] = await Promise.all([
    queryCurrentSite(),
    getGrantedOrigins(),
  ]);

  let currentGranted = false;
  if (site.pattern) {
    try {
      currentGranted = await chrome.permissions.contains({ origins: [site.pattern] });
    } catch {}
  }
  if (sequence !== accessRefreshSequence) return;

  accessState.loading = false;
  accessState.site = site;
  accessState.grantedOrigins = grantedOrigins || [];
  accessState.permissionsKnown = Array.isArray(grantedOrigins);
  accessState.hasAllSites = accessState.grantedOrigins.includes(ALL_SITES_PATTERN);
  accessState.currentGranted = currentGranted;
  renderAccessUI();
  reconcileBroadCapabilities();
}

async function loadAccessConfig() {
  accessConfig = await getConfig();
  configReady = true;
  renderAccessUI();
  reconcileBroadCapabilities();
}

onConfigChanged((next) => {
  accessConfig = next;
  configReady = true;
  renderAccessUI();
  reconcileBroadCapabilities();
});

// If all-sites access disappears (revoked here or from chrome://extensions)
// while a broad feature is still on in config, turn the feature off. The
// features box hides the toggles without all-sites, so this only fires for
// out-of-band revocation.
async function reconcileBroadCapabilities() {
  if (
    configTogglePending
    || currentGrantPending
    || allSitesGrantPending
    || startPending
    || !configReady
    || accessState.loading
    || !accessState.permissionsKnown
    || accessState.hasAllSites
    || (!accessConfig.captureShots && !accessConfig.followTabs)
  ) return;

  accessConfig = await setConfig({ captureShots: false, followTabs: false });
  configReady = true;
  renderCaptureConfig();
}

// Screenshots and follow-tabs need all-sites permission; enabling one requests
// it (under this change's user gesture) without changing the record mode.
async function updateBroadCapability(key, input) {
  if (configTogglePending) {
    input.checked = Boolean(accessConfig[key]);
    return;
  }
  const desired = input.checked;
  const previous = Boolean(accessConfig[key]);
  configTogglePending = key;
  configToggleDesired = desired;
  renderCaptureConfig();

  try {
    if (desired && !accessState.hasAllSites) {
      const granted = await chrome.permissions.request(ALL_SITES_PERMISSION);
      if (!granted) {
        input.checked = false;
        setInlineFeedback(captureAccessFeedback, 'That needs all-sites access, which was not granted.');
        return;
      }
    }
    accessConfig = await setConfig({ [key]: desired });
    configReady = true;
    setInlineFeedback(captureAccessFeedback, '');
  } catch (err) {
    input.checked = previous;
    setInlineFeedback(captureAccessFeedback, 'That setting could not be updated.');
    await showError(err);
  } finally {
    configTogglePending = null;
    configToggleDesired = null;
    await refreshAccessUI();
  }
}

captureShotsInput.addEventListener('change', () => {
  updateBroadCapability('captureShots', captureShotsInput);
});
followTabsInput.addEventListener('change', () => {
  updateBroadCapability('followTabs', followTabsInput);
});

// Record-mode segmented control.
modeAllowed.addEventListener('click', async () => {
  if (accessConfig.recordMode !== 'all' || accessInteractionPending()) return;
  accessConfig = await setConfig({ recordMode: 'allowed' });
  await refreshAccessUI();
});
modeAll.addEventListener('click', async () => {
  if (accessConfig.recordMode === 'all' || accessInteractionPending()) return;
  // All-sites mode needs all-sites permission; request it under this gesture.
  if (!accessState.hasAllSites) {
    let granted = false;
    try { granted = await chrome.permissions.request(ALL_SITES_PERMISSION); } catch {}
    if (!granted) {
      setInlineFeedback(accessFeedback, 'All-sites access was not granted, so record mode stayed on Only allowed.');
      return;
    }
  }
  accessConfig = await setConfig({ recordMode: 'all' });
  await refreshAccessUI();
});

async function grantCurrentSite() {
  const site = accessState.site;
  if (!site?.pattern) return;
  currentGrantPending = true;
  renderAccessUI();
  setInlineFeedback(accessFeedback, '');

  try {
    // The request runs directly under this click's user gesture.
    const granted = await chrome.permissions.request({ origins: [site.pattern] });
    if (granted) {
      setInlineFeedback(accessFeedback, `Access to ${site.host} was granted.`, 'ok');
      // Collapse once granted; the summary now shows the granted state.
      accessSection.open = false;
    } else {
      setInlineFeedback(accessFeedback, `Access to ${site.host} was not granted.`);
    }
  } catch (err) {
    setInlineFeedback(accessFeedback, `Access to ${site.host} could not be requested.`);
    await showError(err);
  } finally {
    currentGrantPending = false;
    await refreshAccessUI();
  }
}

grantCurrentAccessBtn.addEventListener('click', grantCurrentSite);

// Quick-grant "+" in the collapsed summary: grant without expanding the card.
quickGrantBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  grantCurrentSite();
});

// "Grant all-sites access" button shown in All-sites mode when not yet granted.
grantAccessBtn.addEventListener('click', async () => {
  allSitesGrantPending = true;
  renderAccessUI();
  setInlineFeedback(accessFeedback, '');
  try {
    // The request runs directly under this click's user gesture.
    const granted = await chrome.permissions.request(ALL_SITES_PERMISSION);
    setInlineFeedback(
      accessFeedback,
      granted ? 'All-sites access was granted.' : 'All-sites access was not granted.',
      granted ? 'ok' : 'warn',
    );
  } catch (err) {
    setInlineFeedback(accessFeedback, 'All-sites access could not be requested.');
    await showError(err);
  } finally {
    allSitesGrantPending = false;
    await refreshAccessUI();
  }
});

async function removeGrantedOrigin(origin, button) {
  button.disabled = true;
  try {
    const removed = await chrome.permissions.remove({ origins: [origin] });
    if (removed) {
      setInlineFeedback(
        accessFeedback,
        origin === ALL_SITES_PATTERN ? 'All-sites access was removed.' : `${origin} was removed.`,
        'ok',
      );
    } else {
      setInlineFeedback(accessFeedback, `${origin} was not removed.`);
    }
  } catch (err) {
    setInlineFeedback(accessFeedback, `${origin} could not be removed.`);
    await showError(err);
  } finally {
    button.disabled = accessInteractionPending();
    await refreshAccessUI();
  }
}

scopeRevoke.addEventListener('click', () => {
  // Per-site removal only. All-sites is revoked from the features box.
  const pattern = accessState.site?.pattern;
  if (pattern && !accessState.hasAllSites && accessState.grantedOrigins.includes(pattern)) {
    removeGrantedOrigin(pattern, scopeRevoke);
  }
});

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    refreshAccessUI();
  });
}
if (chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => {
    refreshAccessUI();
  });
}

if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => {
    refreshAccessForCurrentTab();
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab?.active && (changeInfo.url || changeInfo.status === 'complete')) {
      refreshAccessForCurrentTab();
    }
  });
}

function refreshAccessForCurrentTab() {
  accessState.loading = true;
  accessState.site = null;
  setInlineFeedback(accessFeedback, '');
  renderAccessUI();
  refreshAccessUI();
}

// ── Allowed-sites list: truncation + bulk textarea editor ──────────────
allowlistMore.addEventListener('click', () => {
  allowlistExpanded = !allowlistExpanded;
  renderGrantedOrigins();
});

allowlistEdit.addEventListener('click', () => {
  const perSite = accessState.grantedOrigins.filter((o) => o !== ALL_SITES_PATTERN);
  allowlistText.value = perSite.join('\n');
  allowlistEditor.classList.remove('hidden');
  allowlistEdit.classList.add('hidden');
  allowlistText.focus();
});

allowlistCancel.addEventListener('click', () => {
  allowlistEditor.classList.add('hidden');
  allowlistEdit.classList.remove('hidden');
});

allowlistSave.addEventListener('click', async () => {
  const desired = [];
  for (const line of allowlistText.value.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try { desired.push(canonicalize(line)); } catch { /* skip invalid line */ }
  }
  const desiredSet = new Set(desired);
  const current = accessState.grantedOrigins.filter((o) => o !== ALL_SITES_PATTERN);
  const toAdd = desired.filter((o) => !current.includes(o));
  const toRemove = current.filter((o) => !desiredSet.has(o));

  currentGrantPending = true;
  renderAccessUI();
  try {
    // request must be the first awaited call so Chrome sees the Save gesture;
    // one prompt covers every new origin.
    if (toAdd.length) {
      const granted = await chrome.permissions.request({ origins: toAdd });
      if (!granted) setInlineFeedback(accessFeedback, 'New sites were not granted.');
    }
    if (toRemove.length) await chrome.permissions.remove({ origins: toRemove });
    allowlistEditor.classList.add('hidden');
    allowlistEdit.classList.remove('hidden');
  } catch (err) {
    setInlineFeedback(accessFeedback, 'The allowed sites could not be updated.');
    await showError(err);
  } finally {
    currentGrantPending = false;
    await refreshAccessUI();
  }
});

// ── Denylist: truncation + bulk textarea editor (config only) ──────────
denylistMore.addEventListener('click', () => {
  denylistExpanded = !denylistExpanded;
  renderDenylist();
});

denylistEdit.addEventListener('click', () => {
  denylistText.value = (accessConfig.denylist || []).join('\n');
  denylistEditor.classList.remove('hidden');
  denylistEdit.classList.add('hidden');
  denylistText.focus();
});

denylistCancel.addEventListener('click', () => {
  denylistEditor.classList.add('hidden');
  denylistEdit.classList.remove('hidden');
});

denylistSave.addEventListener('click', async () => {
  const patterns = denylistText.value
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((p) => isValidPattern(p));
  accessConfig = await setConfig({ denylist: patterns });
  denylistEditor.classList.add('hidden');
  denylistEdit.classList.remove('hidden');
  renderDenylist();
});

denylistReset.addEventListener('click', async () => {
  accessConfig = await setConfig({ denylist: [...BUILTIN_DENYLIST] });
  denylistText.value = BUILTIN_DENYLIST.join('\n');
  renderDenylist();
});

// ───────────────────────────────────────────────────────────────────────
// Start / Stop
// ───────────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const site = accessState.site;
  const needsAllSites = Boolean(accessConfig.captureShots || accessConfig.followTabs);
  startPending = true;
  renderAccessUI();
  try {
    if (!site?.pattern) {
      throw new Error(site?.reason || 'Open an http or https site before starting a recording.');
    }

    // Start records with access that is ALREADY granted; it never requests
    // access itself (that is what the grant buttons are for). The button is
    // disabled without access, so this is a defensive re-check against the tab
    // changing between render and click.
    await refreshAccessUI();
    if (!accessState.site?.pattern || !accessState.currentGranted) {
      throw new Error(`Grant access to ${site.host} before recording.`);
    }
    if (needsAllSites && !accessState.hasAllSites) {
      throw new Error('Screenshots and following across tabs need all-sites access. Grant it under Additional features, or turn those options off.');
    }
    // Folder permission FIRST: ensureMicPermission may open a tab, which
    // consumes the click's user-gesture token and would make a later
    // requestPermission() prompt fail.
    const ap = activeProject();
    if (ap) {
      const state = await requestPermission(ap.dirHandle);
      projectState.permission = state;
      renderProjectUI();
      if (state !== 'granted') {
        showProjectBanner(
          `Can't write to "${ap.name}" folder: permission ${state === 'denied' ? 'denied' : 'not granted'}. Recording will save as a zip download instead.`,
        );
      } else {
        hideProjectBanner();
      }
    }
    if (micInput.checked) {
      await ensureMicPermission();
    }

    await refreshAccessUI();
    const finalNeedsAllSites = Boolean(accessConfig.captureShots || accessConfig.followTabs);
    if (accessState.site?.pattern !== site.pattern) {
      throw new Error('The active tab changed before recording started. Check its access and try again.');
    }
    if (!accessState.currentGranted) {
      throw new Error(`Access to ${site.host} was removed before recording started.`);
    }
    if (finalNeedsAllSites && !accessState.hasAllSites) {
      throw new Error('All-sites access is required by the enabled capture options.');
    }

    hidePostStopBanner();
    const res = await chrome.runtime.sendMessage({
      type: 'recorder:start',
      label: labelInput.value.trim() || null,
      description: descriptionInput.value.trim() || null,
      mic: micInput.checked,
      micDeviceId: micInput.checked ? (micDeviceSelect.value || null) : null,
      captureShots: Boolean(accessConfig.captureShots),
      captureNetwork: captureNetworkInput.checked,
      captureNetworkBody: captureNetworkInput.checked && captureNetworkBodyInput.checked,
    });
    const resErr = errFromResponse(res);
    if (resErr) throw resErr;
    await clearError();
    await refreshStatus();
  } catch (err) {
    await showError(err);
  } finally {
    startPending = false;
    renderAccessUI();
  }
});

pauseBtn.addEventListener('click', async () => {
  pauseBtn.disabled = true;
  try {
    const msgType = pauseBtn.dataset.paused === '1' ? 'recorder:resume' : 'recorder:pause';
    const res = await chrome.runtime.sendMessage({ type: msgType });
    const resErr = errFromResponse(res);
    if (resErr) throw resErr;
    await refreshStatus();
  } catch (err) {
    await showError(err);
  } finally {
    pauseBtn.disabled = false;
  }
});

markWaitingBtn.addEventListener('click', async () => {
  markWaitingBtn.disabled = true;
  try {
    const next = markWaitingBtn.dataset.active !== '1';
    const res = await chrome.runtime.sendMessage({ type: 'recorder:mark-waiting', active: next });
    const resErr = errFromResponse(res);
    if (resErr) throw resErr;
    await refreshStatus();
  } catch (err) {
    await showError(err);
  } finally {
    markWaitingBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    const ap = activeProject();
    const canWriteProject = ap && projectState.permission === 'granted';
    const target = canWriteProject ? 'project' : 'download';

    // The SW loads the directory handle from IDB itself (by project name)
    // and writes the bundle directly. chrome.runtime.sendMessage serializes
    // via JSON, so a DirectoryHandle sent through here loses its prototype.
    const res = await chrome.runtime.sendMessage({
      type: 'recorder:stop',
      target,
      projectName: canWriteProject ? ap.name : null,
    });
    const resErr = errFromResponse(res);
    if (resErr) throw resErr;
    await clearError();

    if (res?.target === 'project') {
      if (res.error) {
        // Write failed inside the SW; trigger a zip download fallback.
        showPostStopBanner(
          `Couldn't write to "${ap.name}" folder: ${res.error.message}. Falling back to zip download.`,
          [{
            label: 'Download zip now',
            onClick: async () => {
              try {
                const r = await chrome.runtime.sendMessage({ type: 'recorder:download-last' });
                if (r?.ok) hidePostStopBanner();
                else throw errFromResponse(r) || new Error('download failed');
              } catch (e) { await showError(e); }
            },
          }],
        );
        try { await chrome.runtime.sendMessage({ type: 'recorder:download-last' }); } catch {}
      } else {
        await touchProject(ap.name);
        projectState.list = await listProjects();
        renderProjectUI();
        showPostStopBanner(`Saved to ${ap.dirHandle.name}/${res.folder}/`);
      }
    }

    await refreshStatus();
  } catch (err) {
    await showError(err);
  } finally {
    stopBtn.disabled = false;
  }
});

// ───────────────────────────────────────────────────────────────────────
// Step markers & inline notes (active recording only)
// ───────────────────────────────────────────────────────────────────────
function sendMarker(rawLabel) {
  const label = (rawLabel || '').trim() || 'step';
  try { chrome.runtime.sendMessage({ type: 'recorder:marker', label }); } catch {}
}

function sendNote(rawText) {
  const text = (rawText || '').trim();
  if (!text) return false;
  try { chrome.runtime.sendMessage({ type: 'recorder:note', text }); } catch {}
  return true;
}

markStepBtn.addEventListener('click', () => {
  sendMarker(stepLabelInput.value);
  stepLabelInput.value = '';
  stepLabelInput.focus();
});

stepLabelInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.isComposing) {
    ev.preventDefault();
    sendMarker(stepLabelInput.value);
    stepLabelInput.value = '';
    stepLabelInput.focus();
  }
});

postNoteBtn.addEventListener('click', () => {
  if (sendNote(noteTextInput.value)) {
    noteTextInput.value = '';
    noteTextInput.focus();
  }
});

noteTextInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.isComposing) {
    ev.preventDefault();
    if (sendNote(noteTextInput.value)) {
      noteTextInput.value = '';
      noteTextInput.focus();
    }
  }
});

// Cmd/Ctrl+Enter anywhere (while recording, outside the note textbox) marks a step.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey)) return;
  if (activePanel.classList.contains('hidden')) return; // not recording
  const active = document.activeElement;
  if (active === noteTextInput) return; // notes are intentional; don't hijack
  ev.preventDefault();
  const fromField = active === stepLabelInput ? stepLabelInput.value : '';
  sendMarker(fromField);
  if (active === stepLabelInput) {
    stepLabelInput.value = '';
    stepLabelInput.focus();
  }
});

// ───────────────────────────────────────────────────────────────────────
// Recording state / counts / voice meter (fast poll while recording)
// ───────────────────────────────────────────────────────────────────────
let tickHandle = null;
let refreshHandle = null;
let lowMicSince = 0;

function renderMeter(s) {
  if (!s.mic) {
    meterWrap.classList.add('hidden');
    return;
  }
  meterWrap.classList.remove('hidden');
  const level = Math.max(0, Math.min(1, s.micLevel ?? 0));
  meterBar.style.width = Math.round(level * 100) + '%';
  meterBar.classList.remove('low', 'hot');
  if (level > 0.85) meterBar.classList.add('hot');
  else if (level < 0.04) meterBar.classList.add('low');
  const now = Date.now();
  if (level < 0.02) {
    if (!lowMicSince) lowMicSince = now;
    const silentMs = now - lowMicSince;
    meterWarning.textContent = silentMs > 5000 ? 'no signal, mic muted?' : (silentMs > 2000 ? 'silent…' : '');
  } else {
    lowMicSince = 0;
    meterWarning.textContent = level > 0.9 ? 'hot, reduce input' : '';
  }
}

// Holds the most-recent status snapshot so the local tick interval can
// interpolate the remaining time without waiting for the next poll.
let lastStatus = null;

function renderTimer(s) {
  // Wall-clock elapsed (shown in the main timer) and active elapsed (drives
  // the limit). activeMs comes from the service worker; while paused it
  // stops advancing. We recompute it here between polls so the UI doesn't
  // look frozen for 250ms at a stretch.
  const wall = Date.now() - s.startedAt;
  timerEl.textContent = fmt(wall);
  const max = s.maxMs ?? (10 * 60 * 1000);
  const warn = s.warnMs ?? (8 * 60 * 1000);
  // Freeze active-time tick while paused OR waiting: the SW already excludes
  // both from activeMs, so local interpolation should also stop.
  const activeMs = (s.paused || s.waiting)
    ? (s.activeMs ?? 0)
    : Math.min(max, (s.activeMs ?? 0) + (Date.now() - (s._sampledAt ?? Date.now())));
  const remaining = Math.max(0, max - activeMs);
  timerRemainingEl.textContent = `${fmt(remaining)} left`;
  timerRemainingEl.classList.remove('warn', 'danger', 'paused');
  if (s.paused || s.waiting) timerRemainingEl.classList.add('paused');
  else if (activeMs >= warn) timerRemainingEl.classList.add(remaining < 30 * 1000 ? 'danger' : 'warn');
}

function renderRecordingState(s) {
  if (s.recording) {
    idlePanel.classList.add('hidden');
    activePanel.classList.remove('hidden');
    const statusLabel = s.paused ? 'paused' : (s.waiting ? 'waiting' : 'recording');
    statusEl.textContent = statusLabel;
    statusEl.classList.toggle('recording', !s.paused && !s.waiting);
    statusEl.classList.toggle('paused', !!s.paused);
    statusEl.classList.toggle('waiting', !!s.waiting && !s.paused);
    pausedBanner.classList.toggle('hidden', !s.paused);
    waitingBanner.classList.toggle('hidden', !s.waiting || !!s.paused);
    pauseBtn.textContent = s.paused ? 'Resume' : 'Pause';
    pauseBtn.dataset.paused = s.paused ? '1' : '0';
    const manualWaiting = !!s.manualWaiting;
    markWaitingBtn.dataset.active = manualWaiting ? '1' : '0';
    markWaitingBtn.textContent = manualWaiting ? 'Still waiting (click to cancel)' : "I'm waiting for this";
    renderCoverage(s.coverage);
    // Sample wall time at snapshot moment for interpolation between polls.
    s._sampledAt = Date.now();
    lastStatus = s;
    tickHandle ??= setInterval(() => {
      if (lastStatus) renderTimer(lastStatus);
    }, 250);
    renderTimer(s);
    eventsEl.textContent = `${s.eventsCount ?? 0} events`;
    shotsEl.textContent = `${s.shotsCount ?? 0} shots`;
    consoleCountEl.textContent = `${s.consoleCount ?? 0} logs`;
    tabsCountEl.textContent = `${s.tabsCount ?? 1} tab${(s.tabsCount ?? 1) === 1 ? '' : 's'}`;
    renderMeter(s);
  } else {
    idlePanel.classList.remove('hidden');
    activePanel.classList.add('hidden');
    statusEl.textContent = 'idle';
    statusEl.classList.remove('recording', 'paused', 'waiting');
    pausedBanner.classList.add('hidden');
    waitingBanner.classList.add('hidden');
    coverageLine.classList.add('hidden');
    meterWrap.classList.add('hidden');
    lowMicSince = 0;
    lastStatus = null;
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }
}

function renderCoverage(cov) {
  if (!cov || !cov.total) { coverageLine.classList.add('hidden'); coverageLine.textContent = ''; return; }
  coverageLine.textContent = `visited ${cov.visited} / ${cov.total} primary nav items`;
  coverageLine.classList.remove('hidden');
}

async function refreshStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'recorder:status' });
    const st = s || { recording: false };
    renderRecordingState(st);
    const target = st.recording ? 150 : 1000;
    scheduleRefresh(target);
  } catch {
    scheduleRefresh(1000);
  }
}
function scheduleRefresh(ms) {
  if (refreshHandle) clearTimeout(refreshHandle);
  refreshHandle = setTimeout(() => refreshStatus(), ms);
}

// ───────────────────────────────────────────────────────────────────────
// Activity feed (live via long-lived port)
// ───────────────────────────────────────────────────────────────────────
const MAX_RENDERED = 2000;
const feed = {
  entries: [],
  expanded: new Set(),
};

function summaryHTML(e) {
  switch (e.kind) {
    case 'click':
    case 'dblclick':
    case 'focus': {
      const t = e.target;
      const label = targetLabel(t);
      return `<span>${escapeHTML(label)}</span>`;
    }
    case 'input':
    case 'change': {
      const t = e.target;
      const label = targetLabel(t);
      const val = e.is_masked
        ? `<span class="masked">masked (${e.value_length ?? '?'}ch)</span>`
        : `<span class="muted">= </span>"${escapeHTML((e.value ?? '').slice(0, 80))}"`;
      return `<span>${escapeHTML(label)}</span> ${val}`;
    }
    case 'submit': {
      return `<span>${escapeHTML(targetLabel(e.target) || 'form')} submitted</span>`;
    }
    case 'key': {
      const mods = e.modifiers?.length ? e.modifiers.join('+') + '+' : '';
      return `<span class="muted">${escapeHTML(mods)}</span>${escapeHTML(e.key)}`;
    }
    case 'scroll': {
      return `<span class="muted">to (${e.x ?? 0}, ${e.y ?? 0})</span>`;
    }
    case 'navigation':
      return `<span class="muted">→</span> ${escapeHTML(e.to || '')}`;
    case 'tab_switch':
      return `<span class="muted">tab →</span> ${escapeHTML(e.toUrl || '')}`;
    case 'console': {
      const args = (e.args || []).join(' ');
      return `<span class="muted">[${escapeHTML(e.level)}]</span> ${escapeHTML(args.slice(0, 240))}`;
    }
    case 'screenshot':
      return `<span class="muted">screenshot · ${escapeHTML(e.reason || '')}</span>`;
    case 'marker':
      return `<span>▶ ${escapeHTML(e.label || 'step')}</span>`;
    case 'note':
      return `<span>${escapeHTML((e.text || '').slice(0, 240))}</span>`;
    case 'idle':
      return `<span class="muted">idle ${Math.round((e.duration_ms || 0) / 100) / 10}s</span>`;
    case 'pause':
      return `<span class="muted">⏸ paused</span>`;
    case 'resume':
      return `<span class="muted">▶ resumed · paused ${Math.round((e.paused_ms || 0) / 1000)}s</span>`;
    case 'timeout':
      return `<span>⏱ time limit reached · ${Math.round((e.limit_ms || 0) / 60000)}min cap</span>`;
    case 'network': {
      const status = e.status == null ? '-' : String(e.status);
      const method = escapeHTML(e.method || '?');
      const url = escapeHTML(e.url || '');
      const dur = e.duration_ms != null ? `<span class="muted"> ${Math.round(e.duration_ms)}ms</span>` : '';
      return `<span class="muted">${method} ${status}</span> ${url}${dur}`;
    }
    case 'assertion': {
      const k = e.assertion_kind;
      const who = targetLabel(e.target);
      if (k === 'visible') return `<span>assert visible: ${escapeHTML(who)}</span>`;
      if (k === 'text_equals') return `<span>assert ${escapeHTML(who)} text = ${escapeHTML(JSON.stringify(e.expected))}</span>`;
      if (k === 'text_contains') return `<span>assert ${escapeHTML(who)} text contains ${escapeHTML(JSON.stringify(e.expected))}</span>`;
      if (k === 'count') return `<span>assert count(${escapeHTML(who)}) = ${escapeHTML(String(e.expected))}</span>`;
      if (k === 'attr_equals') return `<span>assert ${escapeHTML(who)} [${escapeHTML(e.attr_name || '?')}] = ${escapeHTML(JSON.stringify(e.expected))}</span>`;
      return `<span>assert ${escapeHTML(who)}</span>`;
    }
    case 'waiting_start':
      return `<span class="muted">⏳ waiting · ${escapeHTML((e.reasons || []).join('+') || 'idle')}</span>`;
    case 'waiting_end': {
      const d = Math.round((e.duration_ms || 0) / 100) / 10;
      return `<span class="muted">▶ waited ${d}s · ${escapeHTML((e.reasons || []).join('+') || 'idle')}</span>`;
    }
    case 'landmark_snapshot':
      return `<span class="muted">landmark · ${escapeHTML(e.title || e.url || '')}</span>`;
    default:
      return `<span class="muted">${escapeHTML(e.kind)}</span>`;
  }
}

function targetLabel(t) {
  if (!t) return 'unknown';
  if (t.accessible_name) return `${t.role || t.tag || '?'} "${t.accessible_name}"`;
  if (t.test_id) return `[data-testid="${t.test_id}"]`;
  if (t.label) return `${t.role || t.tag || '?'} "${t.label}"`;
  if (t.text) return `${t.tag || '?'} "${t.text}"`;
  if (t.placeholder) return `${t.tag || '?'} (placeholder "${t.placeholder}")`;
  if (t.id) return `${t.tag || '?'}#${t.id}`;
  if (t.name) return `${t.tag || '?'}[name="${t.name}"]`;
  return t.tag || 'element';
}

function badgeFor(e) {
  if (e.kind === 'console') {
    const sub = e.level || 'log';
    return `<span class="badge console ${escapeHTML(sub)}">${escapeHTML(sub)}</span>`;
  }
  if (e.kind === 'network') {
    const err = (typeof e.status === 'number' && e.status >= 400) || !!e.error;
    return `<span class="badge network${err ? ' err' : ''}">net</span>`;
  }
  return `<span class="badge ${escapeHTML(e.kind)}">${escapeHTML(e.kind)}</span>`;
}

function detailsHTML(e) {
  const preview = e.thumb_url || e.dataUrl; // dataUrl kept for old entries in-memory
  if (e.kind === 'screenshot' && preview) {
    return `<div class="details has-shot">
      <img src="${escapeHTML(preview)}" alt="Screenshot" />
      <pre>${escapeHTML(JSON.stringify({ kind: e.kind, t: e.t, reason: e.reason, mime: e.mime, tab_id: e.tab_id, url: e.url }, null, 2))}</pre>
    </div>`;
  }
  const copy = { ...e };
  delete copy.dataUrl;
  delete copy.thumb_url;
  return `<pre class="details">${escapeHTML(JSON.stringify(copy, null, 2))}</pre>`;
}

function matchesFilter(e) {
  const typeFilter = filterType.value;
  if (typeFilter && e.kind !== typeFilter) return false;
  const text = filterText.value.trim().toLowerCase();
  if (!text) return true;
  const hay = [
    e.kind,
    e.target?.accessible_name, e.target?.label, e.target?.text, e.target?.test_id, e.target?.id, e.target?.name, e.target?.css,
    e.value,
    e.to, e.toUrl, e.url,
    e.reason,
    e.key,
    (e.args || []).join(' '),
    e.level,
    e.label,
    e.text,
    e.method, e.status, e.res_content_type,
    e.assertion_kind, e.expected, e.attr_name,
    e.title,
    (e.reasons || []).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(text);
}

function renderRow(e) {
  const li = document.createElement('li');
  li.className = 'row';
  if (feed.expanded.has(e.id)) li.classList.add('expanded');
  li.innerHTML = `
    <span class="time">${fmtRelTime(e.t ?? 0)}</span>
    ${badgeFor(e)}
    <span class="summary">${summaryHTML(e)}</span>
    ${feed.expanded.has(e.id) ? detailsHTML(e) : ''}
  `;
  li.addEventListener('click', (ev) => {
    if (ev.target.closest('img')) return; // let image click bubble
    if (feed.expanded.has(e.id)) feed.expanded.delete(e.id);
    else feed.expanded.add(e.id);
    renderFeed();
  });
  return li;
}

function renderFeed() {
  const filtered = feed.entries.filter(matchesFilter);
  emptyEl.classList.toggle('hidden', filtered.length > 0);
  feedCountsEl.textContent = `${filtered.length} / ${feed.entries.length} entries`;
  const frag = document.createDocumentFragment();
  const slice = filtered.slice(-MAX_RENDERED);
  for (const e of slice) frag.appendChild(renderRow(e));
  feedEl.replaceChildren(frag);
  if (autoscrollEl.checked) {
    const wrap = document.querySelector('.feed-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

filterText.addEventListener('input', renderFeed);
filterType.addEventListener('change', renderFeed);
clearActivityBtn.addEventListener('click', () => {
  feed.entries = [];
  feed.expanded.clear();
  renderFeed();
});

let port = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: 'sidepanel' });
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'activity:init') {
        feed.entries = Array.isArray(msg.entries) ? msg.entries.slice() : [];
        renderFeed();
      } else if (msg?.type === 'activity:append') {
        if (Array.isArray(msg.entries)) {
          for (const e of msg.entries) feed.entries.push(e);
          if (feed.entries.length > 20000) feed.entries.splice(0, feed.entries.length - 20000);
          renderFeed();
        }
      } else if (msg?.type === 'recording:state') {
        // Refresh status immediately so counts/panels swap without waiting a tick.
        refreshStatus();
      } else if (msg?.type === 'waiting:state') {
        refreshStatus();
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
  } catch {
    setTimeout(connect, 1000);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Boot
// ───────────────────────────────────────────────────────────────────────
restoreError();
restoreCaptureSettings();
renderCaptureConfig();
loadAccessConfig();
refreshStatus();
refreshAccessUI();
refreshMicStatus();
updateMicDeviceVisibility();
refreshMicDevices();
loadProjects();
connect();
renderFeed();
