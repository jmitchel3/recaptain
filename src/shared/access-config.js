// Persistent access configuration (capture toggles + denylist) shared by the
// service worker, sidepanel, and options page. Stored in chrome.storage.local
// so it survives browser restarts.
//
// The ALLOWLIST is intentionally NOT stored here: it is the live set of granted
// host permissions (chrome.permissions.getAll), managed through the permissions
// API. This module owns only what the user configures independently of a grant.
//
// Config changes propagate through chrome.storage.onChanged, which every
// extension context observes, so no custom runtime messages are needed: the SW
// re-derives content-script registration on change, and any open UI re-renders.

const STORAGE_KEY = 'recaptain_access_config';

// Built-in denylist: conservative, clearly-credential/identity domains that are
// suppressed by default even under all-sites access. Short form (see
// match-patterns.js). Editable by the user; this constant is the reset target.
export const BUILTIN_DENYLIST = [
  'accounts.google.com/*',
  'login.microsoftonline.com/*',
  'login.live.com/*',
  '*.okta.com/*',
  '*.auth0.com/*',
  '*.onelogin.com/*',
  '*.pingidentity.com/*',
  '*.duosecurity.com/*',
  'signin.aws.amazon.com/*',
  'id.atlassian.com/*',
  'github.com/login*',
  'github.com/session',
  'checkout.stripe.com/*',
  '*.paypal.com/*',
];

// Record policy is separate from Chrome host permission: "can Recaptain touch a
// site" (permission) vs "should it record a site" (this config).
//   recordMode 'all'     - record every site (needs all-sites permission),
//                          minus the denylist.
//   recordMode 'allowed' - record only sites matching `allowlist`, minus the
//                          denylist. (default)
// Defaults: capture toggles OFF; denylist protection ON; record only allowed.
export const DEFAULT_CONFIG = {
  version: 1,
  recordMode: 'allowed',
  allowlist: [],
  captureShots: false,
  followTabs: false,
  denylistEnabled: true,
  denylist: [...BUILTIN_DENYLIST],
};

function withDefaults(stored) {
  if (!stored || typeof stored !== 'object') {
    return { ...DEFAULT_CONFIG, denylist: [...BUILTIN_DENYLIST], allowlist: [] };
  }
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    recordMode: stored.recordMode === 'all' ? 'all' : 'allowed',
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist : [],
    denylist: Array.isArray(stored.denylist) ? stored.denylist : [...BUILTIN_DENYLIST],
  };
}

// Config that can be shared as an org policy (Export/Import). Host GRANTS are not
// here: those always require each user's own consent.
export const POLICY_KEYS = ['recordMode', 'allowlist', 'denylistEnabled', 'denylist', 'captureShots', 'followTabs'];

export function toPolicy(config) {
  const out = {};
  for (const k of POLICY_KEYS) out[k] = config[k];
  return { recaptainPolicy: 1, ...out };
}

export async function getConfig() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return withDefaults(got?.[STORAGE_KEY]);
  } catch {
    return withDefaults(null);
  }
}

export async function setConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  try { await chrome.storage.local.set({ [STORAGE_KEY]: next }); } catch {}
  return next;
}

// Effective denylist: empty when disabled, else the configured patterns.
export async function getActiveDenylist() {
  const cfg = await getConfig();
  return cfg.denylistEnabled ? (cfg.denylist || []) : [];
}

// Subscribe to config changes across contexts. Returns an unsubscribe fn.
export function onConfigChanged(cb) {
  const handler = (changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(withDefaults(changes[STORAGE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
