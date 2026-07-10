import {
  BUILTIN_DENYLIST,
  DEFAULT_CONFIG,
  getConfig,
  onConfigChanged,
  setConfig,
  toPolicy,
} from '../shared/access-config.js';
import { canonicalize, isValidPattern } from '../shared/match-patterns.js';

const chromeApi = globalThis.chrome;
const permissionsApi = chromeApi?.permissions;
const storageAvailable = Boolean(
  chromeApi?.storage?.local?.get && chromeApi?.storage?.local?.set,
);

const $ = (id) => document.getElementById(id);

const pageStatus = $('page-status');
const allowlistList = $('allowlist-list');
const allowlistSummary = $('allowlist-summary');
const allowlistForm = $('allowlist-form');
const allowlistInput = $('allowlist-input');
const allowlistAdd = $('allowlist-add');
const allowlistPreview = $('allowlist-preview');
const allowlistError = $('allowlist-error');
const denylistList = $('denylist-list');
const denylistSummary = $('denylist-summary');
const denylistEnabled = $('denylist-enabled');
const denylistForm = $('denylist-form');
const denylistInput = $('denylist-input');
const denylistAdd = $('denylist-add');
const denylistPreview = $('denylist-preview');
const denylistError = $('denylist-error');
const denylistReset = $('denylist-reset');
const captureShots = $('capture-shots');
const followTabs = $('follow-tabs');

let config = cloneDefaultConfig();
let grantedOrigins = [];
let configReady = false;
let permissionReadAvailable = false;
let permissionRefreshId = 0;
let unsubscribeConfig = null;
let statusTimer = null;
let configWritePending = false;

function cloneDefaultConfig() {
  return { ...DEFAULT_CONFIG, denylist: [...DEFAULT_CONFIG.denylist] };
}

function normalizeConfig(value) {
  return {
    ...DEFAULT_CONFIG,
    ...(value && typeof value === 'object' ? value : {}),
    denylist: Array.isArray(value?.denylist)
      ? [...value.denylist]
      : [...DEFAULT_CONFIG.denylist],
  };
}

function showPageStatus(message, kind = '', persistent = false) {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  pageStatus.textContent = message;
  pageStatus.className = `page-status${kind ? ` ${kind}` : ''}`;
  pageStatus.hidden = false;
  if (!persistent) {
    statusTimer = setTimeout(() => {
      pageStatus.hidden = true;
      statusTimer = null;
    }, 5000);
  }
}

function setFieldError(input, errorElement, message) {
  input.setAttribute('aria-invalid', 'true');
  errorElement.textContent = message;
  errorElement.hidden = false;
  input.focus();
}

function clearFieldError(input, errorElement) {
  input.removeAttribute('aria-invalid');
  errorElement.textContent = '';
  errorElement.hidden = true;
}

function updatePatternPreview(input, preview) {
  const value = input.value.trim();
  preview.classList.remove('valid', 'invalid');
  if (!value) {
    preview.textContent = 'Canonical form appears here.';
    return;
  }
  if (!isValidPattern(value)) {
    preview.textContent = 'This is not a valid pattern yet.';
    preview.classList.add('invalid');
    return;
  }
  preview.textContent = `Canonical: ${canonicalize(value)}`;
  preview.classList.add('valid');
}

function canonicalOrNull(pattern) {
  try {
    return canonicalize(pattern);
  } catch {
    return null;
  }
}

function emptyRow(message) {
  const row = document.createElement('li');
  row.className = 'empty-row';
  row.textContent = message;
  return row;
}

function removeButton(label, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remove';
  button.textContent = 'Remove';
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function rowIndex(list, button) {
  return Array.from(list.children).indexOf(button.closest('li'));
}

function restoreRemovalFocus(list, index, fallback) {
  const buttons = list.querySelectorAll('button.remove');
  const target = buttons[Math.min(Math.max(index, 0), buttons.length - 1)] || fallback;
  target.focus();
}

function renderAllowlist() {
  allowlistList.replaceChildren();
  const canRequest = typeof permissionsApi?.request === 'function';
  const canRemove = typeof permissionsApi?.remove === 'function';
  allowlistAdd.disabled = !canRequest || !permissionReadAvailable;

  if (!permissionReadAvailable) {
    allowlistSummary.textContent = 'Permission API unavailable';
    allowlistList.appendChild(emptyRow('Chrome permission data is unavailable in this context.'));
    return;
  }

  const sorted = [...grantedOrigins].sort((a, b) => {
    if (a === '<all_urls>') return -1;
    if (b === '<all_urls>') return 1;
    return a.localeCompare(b);
  });
  const hasAllSites = sorted.includes('<all_urls>');
  allowlistSummary.textContent = hasAllSites
    ? 'All sites granted'
    : `${sorted.length} ${sorted.length === 1 ? 'origin' : 'origins'} granted`;

  if (sorted.length === 0) {
    allowlistList.appendChild(emptyRow('No site access has been granted.'));
    return;
  }

  for (const origin of sorted) {
    const row = document.createElement('li');
    row.className = `pattern-row${origin === '<all_urls>' ? ' all-sites' : ''}`;

    const details = document.createElement('div');
    details.className = 'pattern-details';
    const title = document.createElement('div');
    title.className = 'pattern-title';
    const value = document.createElement('code');
    value.className = 'pattern-value';
    value.textContent = origin;
    title.appendChild(value);

    if (origin === '<all_urls>') {
      const badge = document.createElement('span');
      badge.className = 'all-sites-badge';
      badge.textContent = 'All sites';
      title.appendChild(badge);
    }

    details.appendChild(title);
    row.appendChild(details);
    row.appendChild(removeButton(
      origin === '<all_urls>'
        ? 'Remove all-sites access'
        : `Remove access for ${origin}`,
      (event) => removeOrigin(origin, event.currentTarget),
      !canRemove,
    ));
    allowlistList.appendChild(row);
  }
}

function renderDenylist() {
  denylistList.replaceChildren();
  const patterns = Array.isArray(config.denylist) ? config.denylist : [];
  const controlsDisabled = !storageAvailable || !configReady || configWritePending;
  denylistEnabled.checked = Boolean(config.denylistEnabled);
  denylistEnabled.disabled = controlsDisabled;
  denylistAdd.disabled = controlsDisabled;
  denylistReset.disabled = controlsDisabled;
  captureShots.checked = Boolean(config.captureShots);
  captureShots.disabled = controlsDisabled;
  followTabs.checked = Boolean(config.followTabs);
  followTabs.disabled = controlsDisabled;

  denylistSummary.textContent = config.denylistEnabled
    ? `${patterns.length} ${patterns.length === 1 ? 'pattern' : 'patterns'} active`
    : `${patterns.length} ${patterns.length === 1 ? 'pattern' : 'patterns'}, protection off`;

  if (patterns.length === 0) {
    denylistList.appendChild(emptyRow('No destinations are denied.'));
    return;
  }

  patterns.forEach((pattern, index) => {
    const row = document.createElement('li');
    row.className = 'pattern-row';
    const details = document.createElement('div');
    details.className = 'pattern-details';
    const value = document.createElement('code');
    value.className = 'pattern-value';
    value.textContent = String(pattern);
    const hint = document.createElement('span');
    hint.className = 'canonical-hint';
    const canonical = canonicalOrNull(pattern);
    if (canonical) {
      hint.textContent = `Canonical: ${canonical}`;
    } else {
      hint.textContent = 'Invalid saved pattern';
      hint.classList.add('invalid');
    }
    details.append(value, hint);
    row.appendChild(details);
    row.appendChild(removeButton(
      `Remove denied pattern ${pattern}`,
      (event) => removeDeniedPattern(index, event.currentTarget),
      controlsDisabled,
    ));
    denylistList.appendChild(row);
  });
}

async function refreshPermissions() {
  const refreshId = ++permissionRefreshId;
  if (typeof permissionsApi?.getAll !== 'function') {
    permissionReadAvailable = false;
    grantedOrigins = [];
    renderAllowlist();
    return;
  }
  try {
    const permissions = await permissionsApi.getAll();
    if (refreshId !== permissionRefreshId) return;
    grantedOrigins = Array.isArray(permissions?.origins)
      ? permissions.origins.filter((origin) => typeof origin === 'string')
      : [];
    permissionReadAvailable = true;
  } catch {
    if (refreshId !== permissionRefreshId) return;
    grantedOrigins = [];
    permissionReadAvailable = false;
  }
  renderAllowlist();
}

async function refreshConfig() {
  if (!storageAvailable) {
    config = cloneDefaultConfig();
    configReady = false;
    renderDenylist();
    showPageStatus('Settings storage is unavailable in this context.', 'error', true);
    return;
  }
  try {
    config = normalizeConfig(await getConfig());
    configReady = true;
  } catch {
    config = cloneDefaultConfig();
    configReady = false;
    showPageStatus('Recaptain could not read saved settings.', 'error', true);
  }
  renderDenylist();
}

async function persistConfig(patch, successMessage) {
  if (!storageAvailable) {
    renderDenylist();
    showPageStatus('Settings storage is unavailable in this context.', 'error', true);
    return false;
  }
  if (!configReady) {
    showPageStatus('Wait for Recaptain to finish loading settings.', 'error');
    return false;
  }
  if (configWritePending) return false;
  configWritePending = true;
  renderDenylist();
  try {
    await setConfig(patch);
    config = normalizeConfig(await getConfig());
    const persisted = Object.entries(patch).every(([key, expected]) => {
      const actual = config[key];
      if (!Array.isArray(expected)) return Object.is(actual, expected);
      return Array.isArray(actual)
        && actual.length === expected.length
        && actual.every((value, index) => Object.is(value, expected[index]));
    });
    if (!persisted) throw new Error('config write was not persisted');
    showPageStatus(successMessage, 'success');
    return true;
  } catch {
    showPageStatus('Recaptain could not save that change.', 'error');
    return false;
  } finally {
    configWritePending = false;
    renderDenylist();
  }
}

async function removeOrigin(origin, button) {
  if (typeof permissionsApi?.remove !== 'function') {
    showPageStatus('Chrome cannot remove permissions in this context.', 'error');
    return;
  }
  const index = rowIndex(allowlistList, button);
  button.disabled = true;
  try {
    const removed = await permissionsApi.remove({ origins: [origin] });
    await refreshPermissions();
    showPageStatus(
      removed ? `Removed access for ${origin}.` : `Access for ${origin} was already absent.`,
      removed ? 'success' : '',
    );
    restoreRemovalFocus(allowlistList, index, allowlistInput);
  } catch {
    showPageStatus(`Chrome could not remove access for ${origin}.`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function removeDeniedPattern(index, button) {
  button.disabled = true;
  const next = [...config.denylist];
  const [removed] = next.splice(index, 1);
  await persistConfig({ denylist: next }, `Removed ${removed}.`);
  restoreRemovalFocus(denylistList, index, denylistInput);
  button.disabled = false;
}

allowlistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldError(allowlistInput, allowlistError);
  const pattern = allowlistInput.value.trim();
  if (!isValidPattern(pattern)) {
    setFieldError(allowlistInput, allowlistError, 'Enter a valid host or Chrome match pattern.');
    return;
  }
  const canonical = canonicalize(pattern);
  if (grantedOrigins.includes('<all_urls>')) {
    setFieldError(allowlistInput, allowlistError, 'All-sites access already covers this origin.');
    return;
  }
  if (grantedOrigins.includes(canonical)) {
    setFieldError(allowlistInput, allowlistError, 'That origin has already been granted.');
    return;
  }
  if (typeof permissionsApi?.request !== 'function') {
    setFieldError(allowlistInput, allowlistError, 'Chrome cannot request permissions in this context.');
    return;
  }
  if (!permissionReadAvailable) {
    setFieldError(allowlistInput, allowlistError, 'Wait for Chrome to finish checking existing access.');
    return;
  }

  allowlistAdd.disabled = true;
  try {
    // Request immediately so Chrome still recognizes the form submission gesture.
    const granted = await permissionsApi.request({ origins: [canonical] });
    if (!granted) {
      setFieldError(allowlistInput, allowlistError, 'Chrome did not grant that origin.');
      return;
    }
    allowlistInput.value = '';
    updatePatternPreview(allowlistInput, allowlistPreview);
    await refreshPermissions();
    showPageStatus(`Granted access for ${canonical}.`, 'success');
  } catch {
    setFieldError(
      allowlistInput,
      allowlistError,
      'Chrome rejected that request. Use a supported pattern under the optional all-sites declaration.',
    );
  } finally {
    allowlistAdd.disabled = !permissionReadAvailable
      || typeof permissionsApi?.request !== 'function';
  }
});

denylistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldError(denylistInput, denylistError);
  const pattern = denylistInput.value.trim();
  if (!isValidPattern(pattern)) {
    setFieldError(denylistInput, denylistError, 'Enter a valid host or match pattern.');
    return;
  }
  const canonical = canonicalize(pattern);
  const duplicate = config.denylist.some((saved) => canonicalOrNull(saved) === canonical);
  if (duplicate) {
    setFieldError(denylistInput, denylistError, 'That destination is already denied.');
    return;
  }

  denylistAdd.disabled = true;
  const saved = await persistConfig(
    { denylist: [...config.denylist, pattern] },
    `Added ${pattern} to the denylist.`,
  );
  if (saved) {
    denylistInput.value = '';
    updatePatternPreview(denylistInput, denylistPreview);
  }
});

denylistReset.addEventListener('click', async () => {
  denylistReset.disabled = true;
  await persistConfig(
    { denylist: [...BUILTIN_DENYLIST] },
    'Restored the built-in denylist.',
  );
});

denylistEnabled.addEventListener('change', async () => {
  denylistEnabled.disabled = true;
  await persistConfig(
    { denylistEnabled: denylistEnabled.checked },
    denylistEnabled.checked ? 'Denylist protection enabled.' : 'Denylist protection disabled.',
  );
});

captureShots.addEventListener('change', async () => {
  captureShots.disabled = true;
  await persistConfig(
    { captureShots: captureShots.checked },
    captureShots.checked ? 'Screenshot capture enabled.' : 'Screenshot capture disabled.',
  );
});

followTabs.addEventListener('change', async () => {
  followTabs.disabled = true;
  await persistConfig(
    { followTabs: followTabs.checked },
    followTabs.checked ? 'Follow-across-tabs enabled.' : 'Follow-across-tabs disabled.',
  );
});

allowlistInput.addEventListener('input', () => {
  clearFieldError(allowlistInput, allowlistError);
  updatePatternPreview(allowlistInput, allowlistPreview);
});

denylistInput.addEventListener('input', () => {
  clearFieldError(denylistInput, denylistError);
  updatePatternPreview(denylistInput, denylistPreview);
});

function handlePermissionChange() {
  refreshPermissions();
  renderGrants();
}

function registerPermissionListeners() {
  if (typeof permissionsApi?.onAdded?.addListener === 'function') {
    try { permissionsApi.onAdded.addListener(handlePermissionChange); } catch {}
  }
  if (typeof permissionsApi?.onRemoved?.addListener === 'function') {
    try { permissionsApi.onRemoved.addListener(handlePermissionChange); } catch {}
  }
}

function unregisterPermissionListeners() {
  if (typeof permissionsApi?.onAdded?.removeListener === 'function') {
    try { permissionsApi.onAdded.removeListener(handlePermissionChange); } catch {}
  }
  if (typeof permissionsApi?.onRemoved?.removeListener === 'function') {
    try { permissionsApi.onRemoved.removeListener(handlePermissionChange); } catch {}
  }
}

function subscribeToConfig() {
  if (typeof chromeApi?.storage?.onChanged?.addListener !== 'function') return;
  try {
    unsubscribeConfig = onConfigChanged((next) => {
      config = normalizeConfig(next);
      configReady = true;
      renderDenylist();
    });
  } catch {
    unsubscribeConfig = null;
  }
}

window.addEventListener('beforeunload', () => {
  if (typeof unsubscribeConfig === 'function') {
    try { unsubscribeConfig(); } catch {}
  }
  unregisterPermissionListeners();
});

// ── Access grants (all-sites + microphone) ─────────────────────────────
const ALL_URLS = { origins: ['<all_urls>'] };
const allsitesState = $('allsites-state');
const allsitesGrant = $('allsites-grant');
const allsitesRevoke = $('allsites-revoke');
const micState = $('mic-state');
const micGrant = $('mic-grant');

async function renderGrants() {
  if (allsitesState) {
    let hasAll = false;
    try { hasAll = await permissionsApi.contains(ALL_URLS); } catch {}
    allsitesState.textContent = hasAll ? 'Granted' : 'Not granted';
    allsitesGrant.hidden = hasAll;
    allsitesGrant.disabled = !permissionsApi;
    allsitesRevoke.hidden = !hasAll;
  }
  if (micState) {
    let micS = 'unknown';
    try {
      const p = await navigator.permissions.query({ name: 'microphone' });
      micS = p.state;
      p.onchange = () => renderGrants();
    } catch {}
    micState.textContent = micS === 'granted' ? 'Granted' : (micS === 'denied' ? 'Blocked (unblock in browser settings)' : 'Not granted');
    micGrant.hidden = micS === 'granted';
  }
}

if (allsitesGrant && permissionsApi) {
  allsitesGrant.addEventListener('click', async () => {
    try { await permissionsApi.request(ALL_URLS); } catch {}
    renderGrants();
  });
  allsitesRevoke.addEventListener('click', async () => {
    try { await permissionsApi.remove(ALL_URLS); } catch {}
    // Broad capabilities are meaningless without all-sites; turn them off.
    try { await persistConfig({ captureShots: false, followTabs: false, recordMode: 'allowed' }); } catch {}
    renderGrants();
  });
}
if (micGrant) {
  micGrant.addEventListener('click', async () => {
    micState.textContent = 'Requesting...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      micState.textContent = 'Blocked or dismissed';
    }
    renderGrants();
  });
}

// ── Policy export / import ─────────────────────────────────────────────
const policyExport = $('policy-export');
const policyImport = $('policy-import');
const policyFile = $('policy-file');
const policyStatus = $('policy-status');

if (policyExport && policyImport && policyFile) {
  policyExport.addEventListener('click', () => {
    try {
      const blob = new Blob([JSON.stringify(toPolicy(config), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'recaptain-policy.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (policyStatus) policyStatus.textContent = 'Exported recaptain-policy.json.';
    } catch {
      if (policyStatus) policyStatus.textContent = 'Export failed.';
    }
  });

  policyImport.addEventListener('click', () => policyFile.click());

  policyFile.addEventListener('change', async () => {
    const file = policyFile.files?.[0];
    policyFile.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const patch = {};
      if (parsed.recordMode === 'all' || parsed.recordMode === 'allowed') patch.recordMode = parsed.recordMode;
      if (Array.isArray(parsed.allowlist)) {
        patch.allowlist = parsed.allowlist.filter((p) => typeof p === 'string' && isValidPattern(p));
      }
      if (Array.isArray(parsed.denylist)) {
        patch.denylist = parsed.denylist.filter((p) => typeof p === 'string' && isValidPattern(p));
      }
      if (typeof parsed.denylistEnabled === 'boolean') patch.denylistEnabled = parsed.denylistEnabled;
      if (typeof parsed.captureShots === 'boolean') patch.captureShots = parsed.captureShots;
      if (typeof parsed.followTabs === 'boolean') patch.followTabs = parsed.followTabs;
      if (!Object.keys(patch).length) {
        if (policyStatus) policyStatus.textContent = 'No recognizable policy in that file.';
        return;
      }
      await persistConfig(patch, 'Policy imported.');
      if (policyStatus) policyStatus.textContent = 'Policy imported.';
    } catch {
      if (policyStatus) policyStatus.textContent = 'Could not read that policy file.';
    }
  });
}

registerPermissionListeners();
subscribeToConfig();
await Promise.all([refreshConfig(), refreshPermissions(), renderGrants()]);
