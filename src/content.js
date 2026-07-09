// Lightweight interaction capture. Emits one small event per user action
// with Playwright-friendly locators, instead of a full DOM trace. Output is
// orders of magnitude smaller than rrweb's FullSnapshot + StyleSheetRule flood
// and is still enough for a downstream consumer (Claude, Playwright) to
// reproduce or narrate the flow.
import {
  scrubUrlRelative,
  shouldMaskField,
  scrubCssPath,
  redactConsoleArg,
  SENSITIVE_ATTR_RE,
} from './shared/privacy.js';
import { collectRedactRects } from './shared/redaction.js';
import { installNetworkCapture } from './shared/network-capture.js';
import { installWaitingDetector } from './shared/waiting-mode.js';
import { installAssertionCapture } from './shared/assertion-capture.js';
import { captureLandmarkSnapshot, detectPrimaryNav } from './shared/landmarks.js';

if (window.__recaptainRecorderInstalled__) {
  // No-op — another copy of this script is already running in this page.
} else {
  window.__recaptainRecorderInstalled__ = true;
  install();
}

// Page-side scrubUrl always resolves relative URLs against the current location.
function scrubUrl(u) { return scrubUrlRelative(u, location.href); }

function install() {

const INPUT_DEBOUNCE_MS = 250;
const ACTIVITY_BATCH_MS = 400;
const MAX_TEXT_LEN = 80;

let recording = false;
let consoleInstalled = false;
let networkUninstall = null;
let waitingUninstall = null;
let assertionUninstall = null;
const activityQueue = [];
let flushTimer = null;
const inputDebounce = new WeakMap(); // element → timeout id
const inputLastSent = new WeakMap(); // element → last value string (for change detection)

// --- element description & selectors -----------------------------------

// Minimal ARIA role inference for tags where the implicit role is well-defined
// enough to be useful as a locator. Incomplete on purpose — falls back to
// tag-name locators when nothing matches.
function impliedRole(el) {
  const t = el.tagName?.toLowerCase();
  if (el.getAttribute('role')) return el.getAttribute('role');
  if (t === 'a' && el.href) return 'link';
  if (t === 'button') return 'button';
  if (t === 'input') {
    const type = (el.type || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date'].includes(type)) return 'textbox';
  }
  if (t === 'textarea') return 'textbox';
  if (t === 'select') return 'combobox';
  if (t === 'nav') return 'navigation';
  if (t === 'main') return 'main';
  if (t === 'aside') return 'complementary';
  if (t === 'header') return 'banner';
  if (t === 'footer') return 'contentinfo';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'ul' || t === 'ol') return 'list';
  if (t === 'li') return 'listitem';
  if (t === 'dialog') return 'dialog';
  return null;
}

function accessibleName(el) {
  const al = el.getAttribute?.('aria-label');
  if (al) return al.trim();
  const labelledBy = el.getAttribute?.('aria-labelledby');
  if (labelledBy) {
    const ref = document.getElementById(labelledBy);
    if (ref?.textContent) return ref.textContent.trim().slice(0, MAX_TEXT_LEN);
  }
  if (el.labels && el.labels.length) {
    return el.labels[0].textContent?.trim().slice(0, MAX_TEXT_LEN) || null;
  }
  // Buttons / links prefer their visible text as the name
  const tag = el.tagName?.toLowerCase();
  if (tag === 'button' || tag === 'a' || el.getAttribute?.('role') === 'button' || el.getAttribute?.('role') === 'link') {
    const text = el.textContent?.trim();
    if (text) return text.slice(0, MAX_TEXT_LEN);
  }
  // Input with placeholder, when nothing else
  if (el.placeholder) return null; // placeholder isn't a real accessible name
  return null;
}

function cssPathFor(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.body) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`${part}#${cur.id}`);
      break;
    }
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

const SAFE_ROLE_SET = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'dialog']);

function matchCountForLocator(kind, args) {
  try {
    if (kind === 'testid') {
      const v = args[0];
      return document.querySelectorAll(`[data-testid="${CSS.escape(v)}"],[data-test-id="${CSS.escape(v)}"],[data-qa="${CSS.escape(v)}"]`).length;
    }
    if (kind === 'role') {
      const r = args[0];
      const hasName = args[1];
      if (hasName) return null;
      if (!SAFE_ROLE_SET.has(r)) return null;
      if (r === 'button') return document.querySelectorAll('[role="button"], button').length;
      if (r === 'link') return document.querySelectorAll('[role="link"], a[href]').length;
      if (r === 'textbox') return document.querySelectorAll('[role="textbox"], input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="tel"], input[type="email"], input[type="password"], input[type="number"], textarea').length;
      if (r === 'checkbox') return document.querySelectorAll('[role="checkbox"], input[type="checkbox"]').length;
      if (r === 'radio') return document.querySelectorAll('[role="radio"], input[type="radio"]').length;
      if (r === 'combobox') return document.querySelectorAll('[role="combobox"], select').length;
      if (r === 'dialog') return document.querySelectorAll('[role="dialog"], dialog').length;
      return null;
    }
    if (kind === 'css') {
      try { return document.querySelectorAll(args[0]).length; } catch { return null; }
    }
    return null;
  } catch {
    return null;
  }
}

function describeElement(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName?.toLowerCase() || null;
  const role = impliedRole(el);
  const name = accessibleName(el);
  const testId = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id') || el.getAttribute?.('data-qa');
  const labelText = el.labels?.[0]?.textContent?.trim().slice(0, MAX_TEXT_LEN) || null;
  const placeholder = el.placeholder || null;
  const text = tag === 'button' || tag === 'a' || role === 'button' || role === 'link'
    ? el.textContent?.trim().slice(0, MAX_TEXT_LEN) || null
    : null;
  const css = scrubCssPath(cssPathFor(el));

  // Playwright-style locator suggestions, ordered by preferred stability.
  const locators = [];
  const locatorKinds = []; // parallel array: [kind, ...args] used to derive match counts
  if (testId) {
    locators.push(`getByTestId(${JSON.stringify(testId)})`);
    locatorKinds.push(['testid', testId]);
  }
  if (role && name) {
    locators.push(`getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`);
    locatorKinds.push(['role', role, name]);
  } else if (role) {
    locators.push(`getByRole(${JSON.stringify(role)})`);
    locatorKinds.push(['role', role, null]);
  }
  if (labelText) {
    locators.push(`getByLabel(${JSON.stringify(labelText)})`);
    locatorKinds.push(['label', labelText]);
  }
  if (placeholder) {
    locators.push(`getByPlaceholder(${JSON.stringify(placeholder)})`);
    locatorKinds.push(['placeholder', placeholder]);
  }
  if (text && !name) {
    locators.push(`getByText(${JSON.stringify(text)})`);
    locatorKinds.push(['text', text]);
  }
  if (css) {
    locators.push(`locator(${JSON.stringify(css)})`);
    locatorKinds.push(['css', css]);
  }

  // Best-effort parallel match counts. Fully guarded — must never break emission.
  let locator_matches = null;
  try {
    locator_matches = locators.map((str, i) => {
      const kind = locatorKinds[i];
      const n = matchCountForLocator(kind[0], kind.slice(1));
      return { str, n: typeof n === 'number' ? n : null };
    });
  } catch {
    locator_matches = null;
  }

  const idIsSensitive = !!(el.id && SENSITIVE_ATTR_RE.test(el.id));

  const out = {
    tag,
    id: idIsSensitive ? null : (el.id || null),
    name: el.getAttribute?.('name') || null,
    type: el.type || null,
    role,
    accessible_name: name,
    text,
    label: labelText,
    placeholder,
    test_id: testId || null,
    href: tag === 'a' ? scrubUrl(el.getAttribute('href')) : null,
    css,
    locators,
  };
  if (locator_matches) out.locator_matches = locator_matches;
  return out;
}

// --- event capture -----------------------------------------------------

function emitActivity(entry) {
  activityQueue.push(entry);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, ACTIVITY_BATCH_MS);
}

function flush() {
  if (activityQueue.length === 0) return;
  const batch = activityQueue.splice(0);
  try {
    chrome.runtime.sendMessage({ type: 'activity:push', entries: batch }).catch(() => {});
  } catch {
    // Extension context may be invalidated on reload
  }
}

function onClick(e) {
  if (!recording) return;
  if (window.__recaptainAssertionActive) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest?.('.recaptain-ignore, [data-recaptain-block]')) return;
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  const ts = target;
  const targetRect = (() => { try { return ts.getBoundingClientRect(); } catch { return null; } })();
  const targetState = {
    disabled: !!ts.disabled,
    aria_disabled: ts.getAttribute?.('aria-disabled') || null,
    readonly: !!ts.readOnly,
    visible: !!(targetRect && targetRect.width > 0 && targetRect.height > 0 && targetRect.bottom > 0 && targetRect.right > 0 && targetRect.top < innerHeight && targetRect.left < innerWidth),
    checked: typeof ts.checked === 'boolean' ? ts.checked : null,
  };
  emitActivity({
    kind: e.detail > 1 ? 'dblclick' : 'click',
    ts: Date.now(),
    url: scrubUrl(location.href),
    button,
    modifiers: modifierKeys(e),
    target: describeElement(target),
    target_state: targetState,
  });
}

function onAuxClick(e) {
  // Middle/right click
  if (e.button === 0) return;
  onClick(e);
}

function onKeyDown(e) {
  if (!recording) return;
  if (window.__recaptainAssertionActive) return;
  // Only meaningful keys — typing flow is captured via input events (debounced).
  const K = e.key;
  const meaningful = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', ' ']);
  if (!meaningful.has(K) && !(e.metaKey || e.ctrlKey)) return;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest?.('.recaptain-ignore, [data-recaptain-block]')) return;
  emitActivity({
    kind: 'key',
    ts: Date.now(),
    url: scrubUrl(location.href),
    key: K,
    code: e.code,
    modifiers: modifierKeys(e),
    target: target ? describeElement(target) : null,
  });
}

function modifierKeys(e) {
  const m = [];
  if (e.altKey) m.push('alt');
  if (e.ctrlKey) m.push('ctrl');
  if (e.metaKey) m.push('meta');
  if (e.shiftKey) m.push('shift');
  return m;
}

function sendInputSnapshot(el, final) {
  if (!(el instanceof Element)) return;
  if (el.closest?.('.recaptain-ignore, [data-recaptain-block]')) return;
  const baseMasked = shouldMaskField(el);
  const raw = el.value != null ? String(el.value) : '';
  // Secondary high-entropy masking — only triggers when the field wasn't
  // already masked by name/type heuristics. Tag with mask_reason so consumers
  // can distinguish from policy-based masking.
  const highEntropy = !baseMasked && raw.length >= 32 && /^[A-Za-z0-9+/=._-]{32,}$/.test(raw);
  const masked = baseMasked || highEntropy;
  const entry = {
    kind: 'input',
    ts: Date.now(),
    url: scrubUrl(location.href),
    target: describeElement(el),
    is_masked: masked,
    value_length: raw.length,
    final: !!final,
  };
  if (highEntropy) entry.mask_reason = 'high_entropy';
  if (!masked) entry.value = raw.slice(0, 200);
  // Dedup identical consecutive snapshots (final still emits)
  const last = inputLastSent.get(el);
  if (!final && last === raw) return;
  inputLastSent.set(el, raw);
  emitActivity(entry);
}

function onInput(e) {
  if (!recording) return;
  const el = e.target;
  if (!(el instanceof Element)) return;
  const tag = el.tagName?.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !el.isContentEditable) return;

  // Debounce typing — we don't want one entry per keystroke.
  const prev = inputDebounce.get(el);
  if (prev) clearTimeout(prev);
  inputDebounce.set(el, setTimeout(() => {
    sendInputSnapshot(el, false);
    inputDebounce.delete(el);
  }, INPUT_DEBOUNCE_MS));
}

function onChange(e) {
  if (!recording) return;
  const el = e.target;
  if (!(el instanceof Element)) return;
  // Fires on select change, checkbox toggle, blur after input change, etc.
  // Treat as final.
  const tag = el.tagName?.toLowerCase();
  if (tag === 'select' || tag === 'input' || tag === 'textarea') {
    sendInputSnapshot(el, true);
  }
}

function onSubmit(e) {
  if (!recording) return;
  const form = e.target instanceof Element ? e.target : null;
  emitActivity({
    kind: 'submit',
    ts: Date.now(),
    url: scrubUrl(location.href),
    target: form ? describeElement(form) : null,
  });
}

function onFocus(e) {
  if (!recording) return;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const tag = el.tagName?.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && tag !== 'button' && tag !== 'a') return;
  if (el.closest?.('.recaptain-ignore, [data-recaptain-block]')) return;
  emitActivity({
    kind: 'focus',
    ts: Date.now(),
    url: scrubUrl(location.href),
    target: describeElement(el),
  });
}

function onScrollEnd() {
  if (!recording) return;
  emitActivity({
    kind: 'scroll',
    ts: Date.now(),
    url: scrubUrl(location.href),
    x: window.scrollX,
    y: window.scrollY,
  });
}

let scrollTimer = null;
function onScroll() {
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(onScrollEnd, 500);
}

// --- console hook ------------------------------------------------------

function safeStringify(value, depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
  if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (t === 'symbol') return value.toString();
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value instanceof Element) return `[${value.tagName.toLowerCase()}${value.id ? '#' + value.id : ''}]`;
  if (depth > 3) return '[…]';
  try {
    return JSON.stringify(value, (k, v) => {
      if (v instanceof Element) return `[${v.tagName.toLowerCase()}]`;
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
      if (typeof v === 'bigint') return v.toString() + 'n';
      return v;
    });
  } catch {
    return String(value);
  }
}

const CONSOLE_CAPS = { error: 100, warn: 50, info: 20, log: 20, debug: 10, trace: 10 };
const consoleCount = { error: 0, warn: 0, info: 0, log: 0, debug: 0, trace: 0 };

function installConsoleHook() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (const level of levels) {
    const orig = console[level]?.bind(console);
    if (!orig) continue;
    console[level] = (...args) => {
      try {
        consoleCount[level] = (consoleCount[level] || 0) + 1;
        if (consoleCount[level] <= (CONSOLE_CAPS[level] || 0)) {
          chrome.runtime.sendMessage({
            type: 'console:entry',
            level,
            ts: Date.now(),
            url: scrubUrl(location.href),
            args: args.map((a) => redactConsoleArg(safeStringify(a))),
          }).catch(() => {});
        }
      } catch {}
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    try {
      consoleCount.error = (consoleCount.error || 0) + 1;
      if (consoleCount.error > CONSOLE_CAPS.error) return;
      chrome.runtime.sendMessage({
        type: 'console:entry',
        level: 'error',
        ts: Date.now(),
        url: scrubUrl(location.href),
        args: [
          redactConsoleArg(`Uncaught: ${e.message}`),
          `${e.filename}:${e.lineno}:${e.colno}`,
          redactConsoleArg(e.error?.stack || ''),
        ],
      }).catch(() => {});
    } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      consoleCount.error = (consoleCount.error || 0) + 1;
      if (consoleCount.error > CONSOLE_CAPS.error) return;
      chrome.runtime.sendMessage({
        type: 'console:entry',
        level: 'error',
        ts: Date.now(),
        url: scrubUrl(location.href),
        args: ['Unhandled promise rejection:', redactConsoleArg(safeStringify(e.reason))],
      }).catch(() => {});
    } catch {}
  });
}

// --- lifecycle ---------------------------------------------------------

function start(opts = {}) {
  if (recording) return;
  recording = true;
  installConsoleHook();
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onAuxClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('focus', onFocus, true);
  window.addEventListener('scroll', onScroll, { passive: true });

  if (opts.captureNetwork && !networkUninstall) {
    networkUninstall = installNetworkCapture({
      onEvent: (entry) => emitActivity(entry),
      options: { captureBody: !!opts.captureNetworkBody },
    });
  }

  if (!waitingUninstall) {
    waitingUninstall = installWaitingDetector({
      onWaitingStart: ({ started_at, reasons }) => {
        emitActivity({ kind: 'waiting_start', ts: started_at, url: scrubUrl(location.href), reasons });
      },
      onWaitingEnd: ({ ended_at, duration_ms, reasons, peak_reqs }) => {
        emitActivity({ kind: 'waiting_end', ts: ended_at, url: scrubUrl(location.href), duration_ms, reasons, peak_reqs });
      },
    });
  }

  if (!assertionUninstall) {
    assertionUninstall = installAssertionCapture({
      onAssertion: (entry) => emitActivity(entry),
      describeElement,
    });
  }

  // Broadcast the starting page's primary nav so the SW can drive the
  // sidepanel's coverage widget. Fire-and-forget; SW ignores when idle.
  try {
    const nav = detectPrimaryNav();
    if (nav) {
      chrome.runtime.sendMessage({ type: 'nav:detected', nav }).catch(() => {});
    }
  } catch {}

  // Initial landmark snapshot — captures the starting page even if the
  // operator never navigates. Subsequent navs re-trigger this path on
  // content-script re-install (full-page loads; SPA pushState is a known
  // limitation documented in .agent-notes/07-recap.md).
  try { emitActivity(captureLandmarkSnapshot()); } catch {}
}

function stop() {
  if (!recording) return;
  recording = false;
  if (networkUninstall) { try { networkUninstall(); } catch {} networkUninstall = null; }
  if (waitingUninstall) { try { waitingUninstall(); } catch {} waitingUninstall = null; }
  if (assertionUninstall) { try { assertionUninstall(); } catch {} assertionUninstall = null; }
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('auxclick', onAuxClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('input', onInput, true);
  document.removeEventListener('change', onChange, true);
  document.removeEventListener('submit', onSubmit, true);
  document.removeEventListener('focus', onFocus, true);
  window.removeEventListener('scroll', onScroll);
  flush();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'recorder:ping') { sendResponse({ ok: true }); return; }
  if (msg?.type === 'recorder:begin') {
    start({
      captureNetwork: !!msg.captureNetwork,
      captureNetworkBody: !!msg.captureNetworkBody,
    });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'recorder:end') { stop(); sendResponse({ ok: true }); return; }
  if (msg?.type === 'recorder:collect-mask-rects') {
    try {
      sendResponse({ rects: collectRedactRects(), devicePixelRatio: window.devicePixelRatio || 1 });
    } catch {
      sendResponse({ rects: [], devicePixelRatio: window.devicePixelRatio || 1 });
    }
    return true;
  }
  if (msg?.type === 'recorder:mark-waiting') {
    if (waitingUninstall?.setManualWaiting) {
      try { waitingUninstall.setManualWaiting(!!msg.active); } catch {}
    }
    sendResponse({ ok: true });
    return;
  }
});

chrome.runtime.sendMessage({ type: 'recorder:content-ready', url: scrubUrl(location.href) })
  .then((res) => {
    if (res?.recording) {
      start({
        captureNetwork: !!res.captureNetwork,
        captureNetworkBody: !!res.captureNetworkBody,
      });
    }
  })
  .catch(() => {});

window.addEventListener('pagehide', () => { stop(); });

} // end install()
