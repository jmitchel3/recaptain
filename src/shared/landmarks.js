// Content-script-side landmark capture. One synchronous walk per navigation;
// returns a structured snapshot the SW packages into pages.json + RECAP.md.
//
// Design constraints:
//  - Fast. Runs on the hot navigation path; a single heavy querySelectorAll
//    per section is fine, recursive walks are not.
//  - Privacy-respecting. Anything flagged by shouldRedactElement is dropped
//    entirely, not just emptied — we don't want stub placeholders leaking
//    the *presence* of sensitive data into the digest.
//  - Minimal. Landmarks are a navigational overview, not a DOM dump. Caps on
//    counts + string lengths keep bundle size bounded even on giant pages.
import { scrubUrlRelative, shouldRedactElement } from './privacy.js';

const MAX_NAME_LEN = 200;
const MAX_HEADINGS = 20;
const MAX_ACTIONS = 15;
const MAX_FORMS = 5;
const MAX_FIELDS_PER_FORM = 15;
const MAX_NAV_ITEMS = 50;

// ARIA landmark roles we report, in the order we'd want them surfaced. Only
// these get a slot in the landmarks[] array — decorative sectioning elements
// are intentionally skipped.
const LANDMARK_ROLES = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'region', 'form'];

// Tags with implicit landmark roles (HTML5 sectioning). Everything else needs
// an explicit role="" to qualify.
const IMPLICIT_LANDMARK_TAG = {
  header: 'banner',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  footer: 'contentinfo',
  section: 'region',
  form: 'form',
};

// Query params stripped when canonicalizing nav/anchor hrefs for dedup. We
// don't scrub these everywhere (they're valuable signal in events.json) —
// only when deciding "did the operator already visit this link."
const TRACKING_PARAM_RE = /^(utm_.*|fbclid|gclid|ref|mc_cid|mc_eid|_ga|_gl)$/i;

function scrubUrl(u) { return scrubUrlRelative(u, location.href); }

function trim(s, n = MAX_NAME_LEN) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  return str.length > n ? str.slice(0, n) : str;
}

function accessibleName(el) {
  if (!el) return null;
  const al = el.getAttribute?.('aria-label');
  if (al) return trim(al);
  const labelledBy = el.getAttribute?.('aria-labelledby');
  if (labelledBy) {
    const ref = document.getElementById(labelledBy);
    if (ref?.textContent) return trim(ref.textContent);
  }
  if (el.labels && el.labels.length) {
    return trim(el.labels[0].textContent);
  }
  const tag = el.tagName?.toLowerCase();
  if (tag === 'button' || tag === 'a' || el.getAttribute?.('role') === 'button' || el.getAttribute?.('role') === 'link') {
    return trim(el.textContent);
  }
  return null;
}

function impliedRole(el) {
  if (!el) return null;
  const explicit = el.getAttribute?.('role');
  if (explicit) return explicit;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'a' && el.href) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'nav') return 'navigation';
  if (tag === 'main') return 'main';
  if (tag === 'header') return 'banner';
  if (tag === 'aside') return 'complementary';
  if (tag === 'footer') return 'contentinfo';
  return null;
}

// Canonicalize an href for dedup: strip hash + known tracking params. Keeps
// the remaining query string intact; a `/dashboard?team=1` is a distinct
// destination from `/dashboard`.
export function canonicalizeHref(href) {
  if (!href) return null;
  try {
    const url = new URL(href, location.href);
    url.hash = '';
    const params = url.searchParams;
    for (const key of Array.from(params.keys())) {
      if (TRACKING_PARAM_RE.test(key)) params.delete(key);
    }
    return scrubUrl(url.toString());
  } catch {
    return scrubUrl(href);
  }
}

// Find the page's primary nav region. Order matches the spec: <nav> first,
// then role=navigation, then aria-label heuristics, then class heuristics.
// Returns the element, not a selector string — the caller wants to query
// inside it.
function findPrimaryNavEl() {
  const nav = document.querySelector('nav');
  if (nav) return { el: nav, selector: 'nav' };

  const roleNav = document.querySelector('[role="navigation"]');
  if (roleNav) return { el: roleNav, selector: '[role="navigation"]' };

  // aria-label heuristics — case-insensitive substring match against a short
  // list of conventional "primary nav" labels.
  const labelled = document.querySelectorAll('[aria-label]');
  for (const el of labelled) {
    const v = (el.getAttribute('aria-label') || '').toLowerCase();
    if (/main|primary|global|navigation/.test(v)) {
      return { el, selector: `[aria-label="${el.getAttribute('aria-label')}"]` };
    }
  }

  const classHit = document.querySelector('.navbar, .nav, .sidebar, .menu');
  if (classHit) return { el: classHit, selector: classHit.className ? `.${classHit.className.split(/\s+/)[0]}` : null };

  return null;
}

// Top-2 Playwright locators for a CTA. Mirrors the content.js describeElement
// shape but shorter — the digest only needs a stable primary + one fallback.
function topLocators(el) {
  const out = [];
  const testId = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id') || el.getAttribute?.('data-qa');
  if (testId) out.push(`getByTestId(${JSON.stringify(testId)})`);
  const role = impliedRole(el);
  const name = accessibleName(el);
  if (role && name) out.push(`getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`);
  else if (role) out.push(`getByRole(${JSON.stringify(role)})`);
  const tag = el.tagName?.toLowerCase();
  if (out.length < 2 && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) {
    const text = trim(el.textContent, 80);
    if (text) out.push(`getByText(${JSON.stringify(text)})`);
  }
  return out.slice(0, 2);
}

// Region classification for nav_items. We only need "where on the page is
// this link" to help the consumer tell chrome from content — not a precise
// DOM address.
function classifyRegion(el, primaryNavEl) {
  if (primaryNavEl && primaryNavEl.contains(el)) return 'primary-nav';
  if (el.closest?.('aside, [role="complementary"]')) return 'sidebar';
  if (el.closest?.('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [role="navigation"][aria-label*="breadcrumb" i]')) return 'breadcrumb';
  return 'secondary';
}

function collectHeadings() {
  const out = [];
  const nodes = document.querySelectorAll('h1, h2, h3');
  for (const el of nodes) {
    if (shouldRedactElement(el)) continue;
    const text = trim(el.textContent);
    if (!text) continue;
    out.push({ level: Number(el.tagName[1]), text });
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

function collectLandmarks() {
  const seen = new Set();
  const out = [];
  const candidates = document.querySelectorAll(
    'header, nav, main, aside, footer, section, form, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], [role="region"], [role="search"], [role="form"]',
  );
  for (const el of candidates) {
    const explicit = el.getAttribute('role');
    const implicit = IMPLICIT_LANDMARK_TAG[el.tagName.toLowerCase()];
    const role = explicit || implicit;
    if (!role || !LANDMARK_ROLES.includes(role)) continue;
    // `section` without an accessible name isn't a landmark per ARIA spec.
    const name = accessibleName(el);
    if (role === 'region' && !name) continue;
    // Dedup on role+name — multiple unnamed <nav>s collapse to one.
    const key = `${role}:${name || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

// Primary CTAs inside <main>. Skip any ancestor that's nav/footer/aside so
// we don't pollute the actions list with chrome. Masked/redacted elements
// are dropped whole.
function collectActions() {
  const mainEl = document.querySelector('main, [role="main"]') || document.body;
  if (!mainEl) return [];
  const out = [];
  const nodes = mainEl.querySelectorAll('button, [role="button"], a[href]');
  for (const el of nodes) {
    if (el.closest('nav, [role="navigation"], aside, [role="complementary"], footer, [role="contentinfo"]')) continue;
    if (shouldRedactElement(el)) continue;
    const tag = el.tagName.toLowerCase();
    const role = impliedRole(el) || (tag === 'a' ? 'link' : 'button');
    const name = accessibleName(el);
    if (!name) continue; // nameless CTAs aren't useful digest content
    const locators = topLocators(el);
    out.push({ tag, role, name, locators });
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

// Forms in the main region. Field labels only — values are intentionally
// omitted even if non-sensitive, because the form list is a schema, not a
// state dump.
function collectForms() {
  const mainEl = document.querySelector('main, [role="main"]') || document.body;
  if (!mainEl) return [];
  const out = [];
  const forms = mainEl.querySelectorAll('form');
  for (const form of forms) {
    if (shouldRedactElement(form)) continue;
    const name = accessibleName(form) || form.getAttribute('name') || form.getAttribute('id') || null;
    const fields = [];
    const inputs = form.querySelectorAll('input, textarea, select');
    for (const inp of inputs) {
      if (shouldRedactElement(inp)) continue;
      const type = (inp.tagName.toLowerCase() === 'textarea')
        ? 'textarea'
        : (inp.tagName.toLowerCase() === 'select' ? 'select' : (inp.type || 'text').toLowerCase());
      if (type === 'hidden') continue;
      const label = accessibleName(inp)
        || trim(inp.labels?.[0]?.textContent)
        || inp.getAttribute('placeholder')
        || inp.getAttribute('name')
        || null;
      if (!label) continue;
      fields.push({
        label,
        type,
        required: !!inp.required,
      });
      if (fields.length >= MAX_FIELDS_PER_FORM) break;
    }
    if (fields.length === 0) continue;
    out.push({ name: trim(name) || null, fields });
    if (out.length >= MAX_FORMS) break;
  }
  return out;
}

function collectNavItems(primaryNavEl) {
  const out = [];
  const seen = new Set();
  const links = document.querySelectorAll('a[href]');
  for (const a of links) {
    if (shouldRedactElement(a)) continue;
    const text = trim(a.textContent, 80);
    if (!text) continue;
    const href = canonicalizeHref(a.getAttribute('href'));
    if (!href) continue;
    // Dedup by href+text — same link appearing twice (e.g. logo + nav) only
    // counts once.
    const key = `${href}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const region = classifyRegion(a, primaryNavEl);
    out.push({ href, text, region });
    if (out.length >= MAX_NAV_ITEMS) break;
  }
  return out;
}

export function captureLandmarkSnapshot() {
  const primary = findPrimaryNavEl();
  const primaryNavEl = primary?.el || null;
  return {
    kind: 'landmark_snapshot',
    ts: Date.now(),
    url: scrubUrl(location.href),
    title: document.title || null,
    headings: collectHeadings(),
    landmarks: collectLandmarks(),
    actions: collectActions(),
    forms: collectForms(),
    nav_items: collectNavItems(primaryNavEl),
  };
}

// Used at recording start. Returns the primary-nav target list for the
// coverage widget, or null if no primary nav was found. Canonicalizes hrefs
// up front so later dedup against landmark_snapshot.nav_items is trivial.
export function detectPrimaryNav() {
  const primary = findPrimaryNavEl();
  if (!primary?.el) return null;
  const items = [];
  const seen = new Set();
  const links = primary.el.querySelectorAll('a[href]');
  for (const a of links) {
    if (shouldRedactElement(a)) continue;
    const text = trim(a.textContent, 80);
    if (!text) continue;
    const href = canonicalizeHref(a.getAttribute('href'));
    if (!href) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ href, text });
    if (items.length >= MAX_NAV_ITEMS) break;
  }
  if (items.length === 0) return null;
  return {
    region_selector: primary.selector || null,
    total: items.length,
    items,
  };
}
