import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrubUrl,
  scrubUrlRelative,
  shouldMaskField,
  shouldRedactElement,
  scrubCssPath,
  redactConsoleArg,
  REDACT_SELECTOR,
  REDACT_SOURCES,
  PRIVACY_MANIFEST,
} from '../../src/shared/privacy.js';

test('scrubUrl redacts well-known secret query params', () => {
  const input = 'https://example.com/cb?code=abc123def456&keep=hi&state=zzz';
  const out = scrubUrl(input);
  assert.match(out, /code=\*\*\*/);
  assert.match(out, /state=\*\*\*/);
  assert.match(out, /keep=hi/);
});

test('scrubUrl redacts JWT-shaped values in arbitrary keys', () => {
  const jwt = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';
  const out = scrubUrl(`https://example.com/x?foo=${jwt}`);
  assert.match(out, /foo=\*\*\*/);
});

test('scrubUrl redacts long high-entropy values', () => {
  const tok = 'A'.repeat(48);
  const out = scrubUrl(`https://example.com/x?anything=${tok}`);
  assert.match(out, /anything=\*\*\*/);
});

test('scrubUrl leaves short values alone', () => {
  const out = scrubUrl('https://example.com/x?q=hello&p=1');
  assert.equal(out, 'https://example.com/x?q=hello&p=1');
});

test('scrubUrl returns input for invalid URLs', () => {
  assert.equal(scrubUrl('not a url'), 'not a url');
  assert.equal(scrubUrl(''), '');
  assert.equal(scrubUrl(null), null);
});

test('scrubUrlRelative resolves relative URLs against a base', () => {
  const out = scrubUrlRelative('/cb?token=secret', 'https://example.com/app');
  assert.match(out, /https:\/\/example\.com\/cb\?token=\*\*\*/);
});

test('scrubUrlRelative redacts high-entropy values and leaves clean URLs alone', () => {
  const jwt = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';
  const jwtOut = scrubUrlRelative(`/x?session=${jwt}`, 'https://example.com/app');
  assert.match(jwtOut, /session=\*\*\*/);

  const token = 'A'.repeat(40);
  const tokenOut = scrubUrlRelative(`/x?opaque=${token}`, 'https://example.com/app');
  assert.match(tokenOut, /opaque=\*\*\*/);

  assert.equal(scrubUrlRelative('/x?q=hello', 'https://example.com/app'), '/x?q=hello');
  assert.equal(scrubUrlRelative('', 'https://example.com/app'), '');
  assert.equal(scrubUrlRelative(null, 'https://example.com/app'), null);
  assert.equal(scrubUrlRelative('/x?token=secret', 'not a base'), '/x?token=secret');
});

test('shouldMaskField masks sensitive input types', () => {
  const el = makeEl({ type: 'password' });
  assert.equal(shouldMaskField(el), true);
  assert.equal(shouldMaskField(makeEl({ type: 'email' })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'tel' })), true);
});

test('shouldMaskField masks by sensitive name/id', () => {
  assert.equal(shouldMaskField(makeEl({ name: 'user_password' })), true);
  assert.equal(shouldMaskField(makeEl({ id: 'api-key' })), true);
  assert.equal(shouldMaskField(makeEl({ name: 'otp-code' })), true);
});

test('shouldMaskField masks autocomplete, aria/data attributes, labels, and placeholders', () => {
  assert.equal(shouldMaskField(makeEl({ autocomplete: 'section-blue cc-number' })), true);
  assert.equal(shouldMaskField(makeEl({ attrs: { 'aria-label': 'Session token' } })), true);
  assert.equal(shouldMaskField(makeEl({ attrs: { 'data-testid': 'login-email' } })), true);
  assert.equal(shouldMaskField(makeEl({ placeholder: 'One-time passcode' })), true);
  assert.equal(shouldMaskField(makeEl({ labels: [{ textContent: 'Private-key' }] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', name: 'q', labels: [{ textContent: 'Search' }] })), false);
});

test('shouldMaskField respects explicit opt-out class + data attrs', () => {
  const el = makeEl({
    type: 'text',
    classList: new Set(['recaptain-mask']),
    attrs: {},
  });
  el.classList.contains = (c) => el.classList.has(c);
  el.hasAttribute = (n) => n in (el.attrs || {});
  assert.equal(shouldMaskField(el), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-sensitive': '' } })), true);
});

test('shouldMaskField leaves normal text fields alone', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', name: 'q' })), false);
});

test('scrubCssPath strips sensitive #id segments, keeps tag', () => {
  assert.equal(
    scrubCssPath('form > input#password:nth-of-type(1)'),
    'form > input:nth-of-type(1)',
  );
  assert.equal(
    scrubCssPath('form > input#email'),
    'form > input',
  );
  assert.equal(scrubCssPath('#password'), '');
});

test('scrubCssPath leaves non-sensitive ids alone', () => {
  assert.equal(
    scrubCssPath('#root > div.main > button#submit-order'),
    '#root > div.main > button#submit-order',
  );
});

test('redactConsoleArg redacts token-like assignments', () => {
  // Regex pattern: keyword + ≤4 chars + `:` or `=` + a long contiguous value
  // (no whitespace after the separator).
  assert.match(redactConsoleArg('token=abcdef1234567890'), /<redacted>/);
  assert.match(redactConsoleArg('secret:abcdef1234567890'), /<redacted>/);
  assert.match(redactConsoleArg('api_key=abcdef1234567890'), /<redacted>/);
});

test('redactConsoleArg leaves normal strings alone', () => {
  const out = redactConsoleArg('hello world');
  assert.equal(out, 'hello world');
  assert.equal(redactConsoleArg({ token: 'abc' }).token, 'abc');
});

test('privacy helpers return safe defaults for unsupported inputs', () => {
  assert.equal(shouldMaskField(null), false);
  assert.equal(shouldRedactElement(null), false);
  assert.equal(scrubCssPath(null), null);
});

// Minimal DOM element stub for shouldMaskField: the function only reaches
// for a handful of properties. Pass through attrs via getAttribute.
function makeEl(opts) {
  let classList;
  if (opts.classList instanceof Set) {
    // Preserve the Set so older tests can still monkey-patch .contains.
    classList = opts.classList;
  } else if (Array.isArray(opts.classes)) {
    const set = new Set(opts.classes);
    classList = { contains: (c) => set.has(c) };
  } else {
    classList = opts.classList || null;
  }
  const el = {
    tagName: (opts.tag || 'INPUT').toUpperCase(),
    type: opts.type,
    name: opts.name || null,
    id: opts.id || null,
    placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || '',
    labels: opts.labels || null,
    classList,
    attrs: opts.attrs || {},
    parent: opts.parent || null,
  };
  el.getAttribute = (n) => {
    if (el.attrs && n in el.attrs) return el.attrs[n];
    return null;
  };
  el.hasAttribute = (n) => !!(el.attrs && n in el.attrs);
  // Minimal closest(selector): walks up the stub chain. Only supports the
  // subset of selectors in REDACT_SELECTOR (comma list of `.class`,
  // `[attr]`, `[attr=value]`). Good enough for shouldRedactElement.
  el.closest = (selector) => {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    let cur = el;
    while (cur) {
      for (const p of parts) {
        if (matchSimple(cur, p)) return cur;
      }
      cur = cur.parent;
    }
    return null;
  };
  return el;
}

function matchSimple(el, sel) {
  if (sel.startsWith('.')) {
    return el.classList?.contains(sel.slice(1));
  }
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    const eq = inner.indexOf('=');
    if (eq === -1) return el.hasAttribute?.(inner);
    const name = inner.slice(0, eq);
    let val = inner.slice(eq + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return el.getAttribute?.(name) === val;
  }
  return false;
}

// --- new convention coverage -------------------------------------------

test('shouldMaskField honors LogRocket data-private + .private', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-private': '' } })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['private'] })), true);
});

test('shouldMaskField honors FullStory fs-mask / fs-exclude / fs-hide', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['fs-mask'] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['fs-exclude'] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['fs-hide'] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-fs-mask': '' } })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-fs-exclude': '' } })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-fs-hide': '' } })), true);
});

test('shouldMaskField honors PostHog ph-no-capture (attr + class)', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['ph-no-capture'] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'ph-no-capture': '' } })), true);
});

test('shouldMaskField honors Hotjar data-hj-suppress', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-hj-suppress': '' } })), true);
});

test('shouldMaskField honors Heap data-heap-redact-text', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-heap-redact-text': '' } })), true);
});

test('shouldMaskField honors Mixpanel mp-mask', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['mp-mask'] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', attrs: { 'data-mp-mask': '' } })), true);
});

test('shouldMaskField honors Amplitude amp-block / amp-mask', () => {
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['amp-block'] })), true);
  assert.equal(shouldMaskField(makeEl({ type: 'text', classes: ['amp-mask'] })), true);
});

test('REDACT_SELECTOR covers every vendor listed in REDACT_SOURCES', () => {
  // Sanity: every selector shows up in the compiled string so the one-shot
  // querySelectorAll in content.js lights up all of them.
  for (const src of REDACT_SOURCES) {
    for (const sel of src.selectors) {
      assert.ok(REDACT_SELECTOR.includes(sel), `missing ${src.vendor}:${sel}`);
    }
  }
});

test('shouldRedactElement true on element itself matching convention', () => {
  const el = makeEl({ tag: 'div', type: null, classes: ['fs-mask'] });
  assert.equal(shouldRedactElement(el), true);
});

test('shouldRedactElement true when an ancestor carries the convention', () => {
  const parent = makeEl({ tag: 'div', type: null, attrs: { 'data-private': '' } });
  const child = makeEl({ tag: 'span', type: null, parent });
  assert.equal(shouldRedactElement(child), true);
});

test('shouldRedactElement true for a sensitive form field even without marker', () => {
  const el = makeEl({ type: 'password' });
  assert.equal(shouldRedactElement(el), true);
});

test('shouldRedactElement false for plain elements', () => {
  const parent = makeEl({ tag: 'div', type: null });
  const child = makeEl({ tag: 'span', type: null, parent });
  assert.equal(shouldRedactElement(child), false);
});

test('shouldRedactElement does NOT fire on aria-hidden / .sr-only / .visually-hidden', () => {
  // Accessibility semantics are not privacy signals.
  assert.equal(shouldRedactElement(makeEl({ tag: 'div', type: null, attrs: { 'aria-hidden': 'true' } })), false);
  assert.equal(shouldRedactElement(makeEl({ tag: 'div', type: null, classes: ['sr-only'] })), false);
  assert.equal(shouldRedactElement(makeEl({ tag: 'div', type: null, classes: ['visually-hidden'] })), false);
});

test('PRIVACY_MANIFEST advertises redaction_sources for every vendor', () => {
  const vendors = REDACT_SOURCES.map((s) => s.vendor);
  assert.deepEqual(PRIVACY_MANIFEST.redaction_sources, vendors);
  assert.ok(PRIVACY_MANIFEST.screenshot_redaction, 'manifest describes screenshot redaction');
});
