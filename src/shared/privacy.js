// Privacy contract shared by content.js (page-side) and background.js
// (service worker). Single source of truth for what gets masked, scrubbed,
// or redacted before it lands in the bundle.

export const SCRUB_QUERY_KEYS = /^(code|token|state|access[_-]?token|id[_-]?token|refresh[_-]?token|sig|signature|nonce|secret|api[_-]?key|apikey|auth|bearer|jwt|x-amz-.*|X-Amz-.*)$/i;

export const SENSITIVE_ATTR_RE = /(password|passwd|pwd|secret|token|api[_-]?key|ssn|social|credit|card|cvv|cvc|pin|email|login|username|user[_-]?name|account[_-]?number|auth|otp|passcode|mfa|2fa|totp|one[_-]?time|session|bearer|jwt|refresh|access[_-]?token|id[_-]?token|signed|hash|sig|nonce|cookie|private[_-]?key)/i;

export const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code',
  'username', 'email', 'tel', 'tel-national', 'tel-local',
  'cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'cc-given-name', 'cc-family-name',
  'bday', 'bday-day', 'bday-month', 'bday-year',
]);

export const CONSOLE_REDACT = /(token|key|secret|bearer|auth|password|session|jwt)[^\s]{0,4}[:=][^\s]{8,}/gi;

// Third-party session-replay ecosystems have each evolved their own "don't
// record this" opt-out conventions. We honor the common ones so operators
// who've already annotated their app for LogRocket / FullStory / PostHog /
// Hotjar / Heap / Mixpanel / Amplitude don't need to re-annotate for us.
// Source for each convention is documented in REDACT_SOURCES below.
export const REDACT_SOURCES = [
  { vendor: 'recaptain', selectors: ['.recaptain-mask', '[data-recaptain-mask]', '[data-sensitive]'] },
  { vendor: 'logrocket', selectors: ['[data-private]', '.private'] },
  { vendor: 'fullstory', selectors: ['.fs-mask', '.fs-exclude', '.fs-hide', '[data-fs-mask]', '[data-fs-exclude]', '[data-fs-hide]'] },
  { vendor: 'posthog',   selectors: ['.ph-no-capture', '[ph-no-capture]'] },
  { vendor: 'hotjar',    selectors: ['[data-hj-suppress]'] },
  { vendor: 'heap',      selectors: ['[data-heap-redact-text]'] },
  { vendor: 'mixpanel',  selectors: ['.mp-mask', '[data-mp-mask]'] },
  { vendor: 'amplitude', selectors: ['.amp-block', '.amp-mask'] },
];

// Precompiled selector covering every vendor convention above. Used by
// shouldRedactElement + collectRedactRects — a single querySelectorAll can
// light up every flagged element in the page in one pass.
export const REDACT_SELECTOR = REDACT_SOURCES
  .flatMap((s) => s.selectors)
  .join(', ');

// Scrub well-known secret query parameters and long high-entropy values from
// a URL string. Returns the input unchanged (same reference) if nothing was
// scrubbed, so callers can compare identity if they care.
export function scrubUrl(u) {
  if (!u || typeof u !== 'string') return u;
  try {
    const url = new URL(u);
    let changed = false;
    const params = url.searchParams;
    for (const key of Array.from(params.keys())) {
      if (SCRUB_QUERY_KEYS.test(key)) { params.set(key, '***'); changed = true; continue; }
      const val = params.get(key);
      if (val && val.length >= 32 && (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(val) || /^[A-Za-z0-9+/=._-]{32,}$/.test(val))) {
        params.set(key, '***'); changed = true;
      }
    }
    return changed ? url.toString() : u;
  } catch { return u; }
}

// Page-side variant that accepts relative URLs by resolving against a base.
// Used by content.js where anchor.href may be relative.
export function scrubUrlRelative(u, base) {
  if (!u || typeof u !== 'string') return u;
  try {
    const url = new URL(u, base);
    let changed = false;
    const params = url.searchParams;
    for (const key of Array.from(params.keys())) {
      if (SCRUB_QUERY_KEYS.test(key)) { params.set(key, '***'); changed = true; continue; }
      const val = params.get(key);
      if (val && val.length >= 32 && (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(val) || /^[A-Za-z0-9+/=._-]{32,}$/.test(val))) {
        params.set(key, '***'); changed = true;
      }
    }
    return changed ? url.toString() : u;
  } catch { return u; }
}

// Content-script-only: whether a form field should have its value masked.
// Takes a DOM element. Not used in the service worker (no DOM).
//
// This is the *input masking* predicate — it replaces a captured value with
// null + value_length. It's strictly narrower than shouldRedactElement:
// only form controls are considered, and a non-input ancestor with
// [data-private] does NOT cause input masking on its own (the surrounding
// screenshot rect handles that case).
export function shouldMaskField(el) {
  if (!el || !el.getAttribute) return false;
  const type = (el.type || '').toLowerCase();
  if (type === 'password' || type === 'email' || type === 'tel') return true;
  const ac = (el.autocomplete || '').toLowerCase().split(/\s+/);
  if (ac.some((a) => SENSITIVE_AUTOCOMPLETE.has(a))) return true;
  const hay = [
    el.name, el.id, el.placeholder,
    el.getAttribute('aria-label'),
    el.getAttribute('data-testid'),
  ].filter(Boolean).join(' ');
  if (SENSITIVE_ATTR_RE.test(hay)) return true;
  const labels = el.labels;
  if (labels && labels.length) {
    for (const l of labels) {
      if (l.textContent && SENSITIVE_ATTR_RE.test(l.textContent)) return true;
    }
  }
  // Explicit opt-outs. We check both our own marker + every vendor marker
  // so an operator who already tagged `data-private` for LogRocket gets
  // field masking here for free.
  if (el.classList?.contains('recaptain-mask')) return true;
  if (el.classList?.contains('private')) return true;
  if (el.classList?.contains('fs-mask') || el.classList?.contains('fs-exclude') || el.classList?.contains('fs-hide')) return true;
  if (el.classList?.contains('ph-no-capture')) return true;
  if (el.classList?.contains('mp-mask')) return true;
  if (el.classList?.contains('amp-block') || el.classList?.contains('amp-mask')) return true;
  if (el.hasAttribute('data-recaptain-mask') || el.hasAttribute('data-sensitive')) return true;
  if (el.hasAttribute('data-private')) return true;
  if (el.hasAttribute('data-fs-mask') || el.hasAttribute('data-fs-exclude') || el.hasAttribute('data-fs-hide')) return true;
  if (el.hasAttribute('ph-no-capture')) return true;
  if (el.hasAttribute('data-hj-suppress')) return true;
  if (el.hasAttribute('data-heap-redact-text')) return true;
  if (el.hasAttribute('data-mp-mask')) return true;
  return false;
}

// Content-script-only: whether a screenshot should paint over an element's
// bounding box. Broader than shouldMaskField — applies to any element (not
// just form fields), and walks ancestors so a `<table data-private>` hides
// every cell inside it.
//
// Accessibility-only markers (aria-hidden, .sr-only, .visually-hidden) are
// deliberately NOT treated as privacy signals.
export function shouldRedactElement(el) {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest(REDACT_SELECTOR)) return true;
  // Form-field input masking is a superset reason for redaction — if we'd
  // null out the value, we shouldn't leave the rendered text on screen.
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (shouldMaskField(el)) return true;
  }
  return false;
}

// Strip a sensitive `#<id>` segment from a CSS path, leaving just the tag.
// e.g. `form > input#password:nth-of-type(1)` → `form > input:nth-of-type(1)`.
export function scrubCssPath(path) {
  if (!path || typeof path !== 'string') return path;
  return path.replace(/([A-Za-z][\w-]*)?#([A-Za-z][\w-]*)/g, (m, tag, id) => {
    if (SENSITIVE_ATTR_RE.test(id)) return tag || '';
    return m;
  });
}

// Redact a single console argument (string) — replaces token-like substrings.
export function redactConsoleArg(s) {
  if (typeof s !== 'string') return s;
  return s.replace(CONSOLE_REDACT, (match) => match.replace(/([:=])(.*)/, '$1<redacted>'));
}

// Human-readable summary of the privacy policy. Written into manifest.json
// so consumers know exactly what was filtered.
export const PRIVACY_MANIFEST = {
  input_masking: 'sensitive-by-default',
  masked_fields: 'password, email, tel; autocomplete of cc-*/username/one-time-code/etc; any input whose name/id/label matches /password|email|login|ssn|cc|cvv|otp|secret|token/; elements opted out via any honored session-replay convention (see redaction_sources)',
  url_scrubbing: 'URL query-param values for well-known secret keys (code, token, state, sig, nonce, auth, bearer, jwt, api_key, x-amz-*, etc.) and high-entropy JWT-shaped values are replaced with ***',
  screenshot_redaction: 'Elements matching REDACT_SELECTOR (or any ancestor matching it), plus any form field that would be input-masked, have their bounding box painted over in each screenshot. Mode (black/blur/off) is operator-configurable. Per-screenshot rects are persisted in screenshots/index.json under mask_rects.',
  redaction_sources: REDACT_SOURCES.map((s) => s.vendor),
  notes: 'Masked field values are replaced with null + value_length. Screenshot redaction is best-effort — it only covers elements present in the viewport at capture time and relies on the vendor conventions above, so operators should still avoid flows where un-tagged secrets are on screen.',
};
