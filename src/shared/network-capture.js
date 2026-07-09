// Network capture: monkey-patches window.fetch and XMLHttpRequest so the
// recorder can emit one `network` activity entry per request. Lives in the
// content script (page-side): only there can we see the page's actual
// fetch/XHR. Service-worker-side webRequest is deliberately not used; this
// extension has no host permissions and we want zero network-related
// permission surface.
//
// Safety contract: every code path that runs inside the patched fetch/XHR
// must be try/catch'd. A bug in this file must never reject the host page's
// request or throw in its microtask. When in doubt, fall through to the
// original implementation and swallow the telemetry.

import { scrubUrl, redactConsoleArg } from './privacy.js';

// Headers we never want to see in captured metadata. Not captured today,
// listed defensively in case a later version adds header capture and forgets.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]);

const DEFAULT_OPTIONS = {
  captureBody: false,
  maxBodyBytes: 4096,
  bodyMimeAllowlist: ['application/json', 'text/plain'],
};

// Module-level state. Singleton on purpose; waiting-mode detector imports
// getInFlightCount directly and expects one shared counter.
let installed = false;
let inFlight = 0;
let originalFetch = null;
let originalXhrOpen = null;
let originalXhrSend = null;

export function getInFlightCount() {
  return inFlight;
}

// Strip sensitive entries from a header-like map before it ever hits an
// event. Not used right now (we don't capture headers), exported for the
// integration layer if it ever wants request/response header summaries.
export function filterSensitiveHeaders(headers) {
  const out = {};
  if (!headers) return out;
  try {
    const entries = typeof headers.forEach === 'function'
      ? headersToEntries(headers)
      : Object.entries(headers);
    for (const [k, v] of entries) {
      if (typeof k !== 'string') continue;
      if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
      out[k] = v;
    }
  } catch {}
  return out;
}

function headersToEntries(headers) {
  const entries = [];
  try { headers.forEach((v, k) => { entries.push([k, v]); }); } catch {}
  return entries;
}

export function installNetworkCapture({ onEvent, options } = {}) {
  if (installed) {
    // Match installConsoleHook idempotence: second call is a no-op with a
    // warning rather than throwing, so double-start() doesn't brick the page.
    /* node:coverage ignore next */
    try { console.warn('[recaptain] network capture already installed'); } catch {}
    return () => {};
  }
  if (typeof onEvent !== 'function') {
    /* node:coverage ignore next */
    try { console.warn('[recaptain] network capture: onEvent is required'); } catch {}
    return () => {};
  }
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };

  const emit = (entry) => {
    // Never let a consumer error bubble back into the patched function.
    try { onEvent(entry); } catch {}
  };

  installed = true;
  const uninstallFetch = patchFetch(emit, opts);
  const uninstallXhr = patchXhr(emit, opts);

  return function uninstall() {
    if (!installed) return;
    installed = false;
    /* node:coverage ignore next */
    try { uninstallFetch(); } catch {}
    /* node:coverage ignore next */
    try { uninstallXhr(); } catch {}
    // Don't reset inFlight here; outstanding requests will still settle and
    // decrement through their already-captured closures; zeroing now would
    // underflow.
    originalFetch = null;
    originalXhrOpen = null;
    originalXhrSend = null;
  };
}

// --- fetch -------------------------------------------------------------

function patchFetch(emit, opts) {
  if (typeof globalThis.fetch !== 'function') return () => {};
  originalFetch = globalThis.fetch.bind(globalThis);
  const patched = async function wbFetch(input, init) {
    const start = Date.now();
    let urlStr = '';
    let method = 'GET';
    try {
      if (typeof input === 'string') urlStr = input;
      else if (input && typeof input.url === 'string') urlStr = input.url;
      else urlStr = String(input);
      if (init && typeof init.method === 'string') method = init.method.toUpperCase();
      else if (input && typeof input.method === 'string') method = input.method.toUpperCase();
    /* node:coverage ignore next */
    } catch {}

    inFlight += 1;
    let settled = false;
    const settle = () => {
      /* node:coverage ignore next */
      if (settled) return;
      settled = true;
      if (inFlight > 0) inFlight -= 1;
    };

    let response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      settle();
      try {
        emit(buildEvent({
          start,
          url: urlStr,
          method,
          initiator: 'fetch',
          status: null,
          ok: false,
          res_content_type: null,
          res_body_size: null,
          res_body: null,
          res_body_truncated: false,
          error: err && err.message ? String(err.message) : String(err),
          req_body_size: estimateBodySize(init && init.body),
        }));
      /* node:coverage ignore next */
      } catch {}
      throw err;
    }

    // Capture metadata synchronously; capture body on a detached .clone() so
    // we never consume the caller's response. Body read is best-effort and
    // must not throw on opaque/streaming responses.
    try {
      const contentType = safeGetHeader(response.headers, 'content-type');
      const contentLength = safeGetHeader(response.headers, 'content-length');
      const resBodySize = contentLength != null ? Number(contentLength) : null;

      captureResponseBody(response, contentType, opts).then((bodyInfo) => {
        settle();
        try {
          emit(buildEvent({
            start,
            url: urlStr,
            method,
            initiator: 'fetch',
            status: response.status,
            ok: !!response.ok,
            res_content_type: contentType,
            res_body_size: Number.isFinite(resBodySize) ? resBodySize : null,
            res_body: bodyInfo.body,
            res_body_truncated: bodyInfo.truncated,
            error: null,
            req_body_size: estimateBodySize(init && init.body),
          }));
        /* node:coverage ignore next */
        } catch {}
      }).catch(() => {
        // Body read failed; still emit the event with null body rather than
        // losing the record entirely.
        settle();
        try {
          emit(buildEvent({
            start,
            url: urlStr,
            method,
            initiator: 'fetch',
            status: response.status,
            ok: !!response.ok,
            res_content_type: contentType,
            res_body_size: Number.isFinite(resBodySize) ? resBodySize : null,
            res_body: null,
            res_body_truncated: false,
            error: null,
            req_body_size: estimateBodySize(init && init.body),
          }));
        /* node:coverage ignore next */
        } catch {}
      });
    } catch {
      // Metadata path blew up; still decrement and emit a minimal event so
      // in-flight accounting stays honest.
      settle();
      try {
        emit(buildEvent({
          start,
          url: urlStr,
          method,
          initiator: 'fetch',
          status: response && response.status || null,
          ok: !!(response && response.ok),
          res_content_type: null,
          res_body_size: null,
          res_body: null,
          res_body_truncated: false,
          error: null,
          req_body_size: null,
        }));
      /* node:coverage ignore next */
      } catch {}
    }

    // Preserve Response identity for callers that check instanceof Response.
    return response;
  };

  /* node:coverage ignore next */
  try { globalThis.fetch = patched; } catch {}
  return function uninstallFetch() {
    /* node:coverage ignore next */
    try { if (globalThis.fetch === patched && originalFetch) globalThis.fetch = originalFetch; } catch {}
  };
}

function safeGetHeader(headers, name) {
  try {
    if (!headers || typeof headers.get !== 'function') return null;
    return headers.get(name);
  } catch { return null; }
}

async function captureResponseBody(response, contentType, opts) {
  const empty = { body: null, truncated: false };
  if (!opts.captureBody) return empty;
  if (!contentType) return empty;
  const mime = String(contentType).split(';')[0].trim().toLowerCase();
  if (!opts.bodyMimeAllowlist.some((m) => mime === m.toLowerCase())) return empty;
  // Streaming responses already consume their body when read; clone and
  // read on the copy. If cloning or reading throws (opaque, already used,
  // CORS), swallow it.
  let clone;
  try { clone = response.clone(); } catch { return empty; }
  let text;
  try {
    text = await clone.text();
  } catch { return empty; }
  if (typeof text !== 'string') return empty;
  let truncated = false;
  let out = text;
  if (out.length > opts.maxBodyBytes) {
    out = out.slice(0, opts.maxBodyBytes);
    truncated = true;
  }
  // Run through the same console-arg redactor; it catches token=XXX-style
  // leaks inside JSON error envelopes and log payloads.
  /* node:coverage ignore next */
  try { out = redactConsoleArg(out); } catch {}
  return { body: out, truncated };
}

function estimateBodySize(body) {
  if (body == null) return null;
  try {
    if (typeof body === 'string') return body.length;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
    // URLSearchParams / FormData / ReadableStream, not worth measuring.
  /* node:coverage ignore next */
  } catch {}
  return null;
}

// --- XHR ----------------------------------------------------------------

// Per-XHR state. WeakMap so garbage collection of the XHR instance cleans
// up automatically; we never leak state for aborted, never-started, or
// forgotten requests.
const xhrState = new WeakMap();

function patchXhr(emit, opts) {
  if (typeof globalThis.XMLHttpRequest === 'undefined') return () => {};
  const XHR = globalThis.XMLHttpRequest;
  const proto = XHR.prototype;
  originalXhrOpen = proto.open;
  originalXhrSend = proto.send;

  const patchedOpen = function wbXhrOpen(method, url, ...rest) {
    try {
      xhrState.set(this, {
        method: typeof method === 'string' ? method.toUpperCase() : 'GET',
        url: typeof url === 'string' ? url : String(url),
        start: 0,
        settled: false,
        listenersAttached: false,
      });
    /* node:coverage ignore next */
    } catch {}
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const patchedSend = function wbXhrSend(body) {
    let state;
    /* node:coverage ignore next */
    try { state = xhrState.get(this); } catch {}
    if (!state) {
      // open() wasn't tracked; fall through without telemetry.
      return originalXhrSend.call(this, body);
    }
    state.start = Date.now();
    state.reqBodySize = estimateBodySize(body);
    inFlight += 1;

    const settle = (errMsg) => {
      /* node:coverage ignore next */
      if (state.settled) return;
      state.settled = true;
      if (inFlight > 0) inFlight -= 1;
      try {
        const status = safeReadNumber(this, 'status') || null;
        const contentType = safeGetXhrHeader(this, 'content-type');
        const contentLength = safeGetXhrHeader(this, 'content-length');
        const resBodySize = contentLength != null ? Number(contentLength) : null;
        const { body: resBody, truncated } = captureXhrResponseBody(this, contentType, opts);
        emit(buildEvent({
          start: state.start,
          url: state.url,
          method: state.method,
          initiator: 'xhr',
          status: status,
          ok: status != null && status >= 200 && status < 400,
          res_content_type: contentType,
          res_body_size: Number.isFinite(resBodySize) ? resBodySize : null,
          res_body: resBody,
          res_body_truncated: truncated,
          error: errMsg || null,
          req_body_size: state.reqBodySize,
        }));
      /* node:coverage ignore next */
      } catch {}
    };

    // loadend fires for success / error / abort. We still listen to error
    // and abort so we can capture an accurate error message, since loadend
    // by itself doesn't tell us *how* the request ended.
    if (!state.listenersAttached) {
      state.listenersAttached = true;
      try {
        this.addEventListener('loadend', () => settle(null));
        this.addEventListener('error', () => settle('network error'));
        this.addEventListener('abort', () => settle('aborted'));
        this.addEventListener('timeout', () => settle('timeout'));
      } catch {
        // If addEventListener is unusable, emit now so we don't leak an
        // in-flight count.
        settle('listener attach failed');
      }
    }

    try {
      return originalXhrSend.call(this, body);
    } catch (err) {
      settle(err && err.message ? String(err.message) : 'send failed');
      throw err;
    }
  };

  /* node:coverage ignore next */
  try { proto.open = patchedOpen; } catch {}
  /* node:coverage ignore next */
  try { proto.send = patchedSend; } catch {}

  return function uninstallXhr() {
    /* node:coverage ignore next */
    try { if (proto.open === patchedOpen && originalXhrOpen) proto.open = originalXhrOpen; } catch {}
    /* node:coverage ignore next */
    try { if (proto.send === patchedSend && originalXhrSend) proto.send = originalXhrSend; } catch {}
  };
}

function safeReadNumber(obj, prop) {
  try { const v = obj[prop]; return typeof v === 'number' ? v : null; } catch { return null; }
}

function safeGetXhrHeader(xhr, name) {
  try {
    if (!xhr || typeof xhr.getResponseHeader !== 'function') return null;
    return xhr.getResponseHeader(name);
  } catch { return null; }
}

function captureXhrResponseBody(xhr, contentType, opts) {
  const empty = { body: null, truncated: false };
  if (!opts.captureBody) return empty;
  if (!contentType) return empty;
  const mime = String(contentType).split(';')[0].trim().toLowerCase();
  if (!opts.bodyMimeAllowlist.some((m) => mime === m.toLowerCase())) return empty;
  let text;
  try {
    // responseType '' or 'text' → .responseText. For arraybuffer/blob we'd
    // need to decode; not worth the complexity for v1, emit metadata only.
    const rt = xhr.responseType;
    if (rt && rt !== 'text') return empty;
    text = xhr.responseText;
  } catch { return empty; }
  if (typeof text !== 'string') return empty;
  let truncated = false;
  let out = text;
  if (out.length > opts.maxBodyBytes) {
    out = out.slice(0, opts.maxBodyBytes);
    truncated = true;
  }
  /* node:coverage ignore next */
  try { out = redactConsoleArg(out); } catch {}
  return { body: out, truncated };
}

// --- event shape --------------------------------------------------------

function buildEvent({
  start,
  url,
  method,
  initiator,
  status,
  ok,
  res_content_type,
  res_body_size,
  res_body,
  res_body_truncated,
  error,
  req_body_size,
}) {
  const end = Date.now();
  let scrubbed = url;
  /* node:coverage ignore next */
  try { scrubbed = scrubUrl(url); } catch {}
  return {
    kind: 'network',
    ts: start,
    // background.js stamps `t` relative to state.startedAt via
    // normalizeIncomingEvent; leave null so the SW is the single source of
    // truth for recording-relative timestamps.
    t: null,
    url: scrubbed,
    method,
    status: status == null ? null : status,
    ok: !!ok,
    duration_ms: Math.max(0, end - start),
    initiator,
    req_body_size: req_body_size == null ? null : req_body_size,
    res_body_size: res_body_size == null ? null : res_body_size,
    res_content_type: res_content_type || null,
    res_body: res_body == null ? null : res_body,
    res_body_truncated: !!res_body_truncated,
    error: error || null,
  };
}

// Test-only: reset module state between test cases. Not exported from the
// package's public barrel; the tests import it directly.
export function __resetForTests() {
  installed = false;
  inFlight = 0;
  originalFetch = null;
  originalXhrOpen = null;
  originalXhrSend = null;
}
