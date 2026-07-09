import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installNetworkCapture,
  getInFlightCount,
  filterSensitiveHeaders,
  __resetForTests,
} from '../../src/shared/network-capture.js';

// Helper: capture events into an array and return the uninstall fn.
function setup({ options } = {}) {
  const events = [];
  const uninstall = installNetworkCapture({
    onEvent: (e) => events.push(e),
    options,
  });
  return { events, uninstall };
}

// Restore globals between tests. node's test runner doesn't sandbox, so any
// leak here would bleed into the next case.
function restoreGlobals(savedFetch, savedXhr) {
  if (savedFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = savedFetch;
  if (savedXhr === undefined) delete globalThis.XMLHttpRequest;
  else globalThis.XMLHttpRequest = savedXhr;
  __resetForTests();
}

// Minimal fetch stub. Accepts an options table: { status, contentType, body }.
function stubFetch(resTable) {
  globalThis.fetch = async function stubbedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const key = (init && init.method ? init.method.toUpperCase() : 'GET') + ' ' + url;
    const cfg = resTable[key] || resTable[url] || { status: 200, contentType: 'application/json', body: '{}' };
    if (cfg.throw) throw new Error(cfg.throw);
    const headers = new Map();
    if (cfg.contentType) headers.set('content-type', cfg.contentType);
    if (cfg.body != null) headers.set('content-length', String(cfg.body.length));
    const responseBody = cfg.body == null ? '' : cfg.body;
    // A just-enough Response-like object. fetch() patch uses .status, .ok,
    // .headers.get, .clone(), .text(); we provide those.
    const response = {
      status: cfg.status,
      ok: cfg.status >= 200 && cfg.status < 300,
      headers: { get: (n) => headers.get(String(n).toLowerCase()) || null },
      clone() {
        return {
          async text() {
            if (cfg.bodyThrows) throw new Error('body read failed');
            return responseBody;
          },
        };
      },
      async text() { return responseBody; },
    };
    return response;
  };
}

// Minimal XHR stub. Fires loadend asynchronously on send().
class FakeXHR {
  constructor() {
    this._listeners = new Map();
    this.readyState = 0;
    this.status = 0;
    this.responseType = '';
    this.responseText = '';
    this._headers = new Map();
  }
  open(method, url) {
    this._method = method;
    this._url = url;
  }
  setResponse({ status, contentType, body, fireEvent = 'loadend' }) {
    this._response = { status, contentType, body, fireEvent };
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  _emit(type) {
    const fns = this._listeners.get(type) || [];
    for (const fn of fns) { try { fn({ type }); } catch {} }
  }
  getResponseHeader(name) {
    return this._headers.get(String(name).toLowerCase()) || null;
  }
  send(_body) {
    // Simulate async completion. Use queueMicrotask so tests can await a
    // single microtask turn.
    queueMicrotask(() => {
      const r = this._response || { status: 200, contentType: 'application/json', body: '{}', fireEvent: 'loadend' };
      this.status = r.status;
      if (r.contentType) this._headers.set('content-type', r.contentType);
      if (r.body != null) this._headers.set('content-length', String(r.body.length));
      this.responseText = r.body != null ? r.body : '';
      if (r.fireEvent === 'error') this._emit('error');
      else if (r.fireEvent === 'abort') this._emit('abort');
      else if (r.fireEvent === 'timeout') this._emit('timeout');
      this._emit('loadend');
    });
  }
}

test('installNetworkCapture emits a fetch event with scrubbed url + metadata', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({
    'GET https://api.example.com/me?token=abcdefghijklmnopqrstuvwxyz012345': {
      status: 200, contentType: 'application/json', body: '{"id":1}',
    },
  });
  const { events, uninstall } = setup();
  try {
    const res = await globalThis.fetch('https://api.example.com/me?token=abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(res.status, 200);
    // Fetch emits via a .then chain after the await; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.kind, 'network');
    assert.equal(e.initiator, 'fetch');
    assert.equal(e.method, 'GET');
    assert.equal(e.status, 200);
    assert.equal(e.ok, true);
    assert.match(e.url, /token=\*\*\*/);
    assert.equal(e.t, null);
    assert.equal(typeof e.ts, 'number');
    assert.equal(typeof e.duration_ms, 'number');
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('captureBody=false leaves res_body null even for JSON', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({ 'https://api.example.com/x': { status: 200, contentType: 'application/json', body: '{"secret":"s"}' } });
  const { events, uninstall } = setup({ options: { captureBody: false } });
  try {
    await globalThis.fetch('https://api.example.com/x');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events[0].res_body, null);
    assert.equal(events[0].res_body_truncated, false);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('captureBody=true captures JSON body and truncates past maxBodyBytes', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  const bigBody = '{"x":"' + 'A'.repeat(20) + '"}';
  stubFetch({ 'https://api.example.com/x': { status: 200, contentType: 'application/json', body: bigBody } });
  const { events, uninstall } = setup({ options: { captureBody: true, maxBodyBytes: 10 } });
  try {
    await globalThis.fetch('https://api.example.com/x');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(typeof events[0].res_body, 'string');
    assert.equal(events[0].res_body.length, 10);
    assert.equal(events[0].res_body_truncated, true);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('captured body is run through redactConsoleArg', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  const leaky = 'token=abcdef1234567890leaky';
  stubFetch({ 'https://api.example.com/x': { status: 200, contentType: 'text/plain', body: leaky } });
  const { events, uninstall } = setup({ options: { captureBody: true, maxBodyBytes: 4096, bodyMimeAllowlist: ['text/plain', 'application/json'] } });
  try {
    await globalThis.fetch('https://api.example.com/x');
    await new Promise((r) => setTimeout(r, 0));
    assert.match(events[0].res_body, /<redacted>/);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('in-flight count rises on send and falls on settle (fetch)', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  // Gate the response on a manual promise so we can observe the counter
  // while the request is mid-flight.
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async function () {
    await gate;
    return {
      status: 200, ok: true,
      headers: { get: () => null },
      clone: () => ({ text: async () => '' }),
    };
  };
  const { uninstall } = setup();
  try {
    assert.equal(getInFlightCount(), 0);
    const p = globalThis.fetch('https://api.example.com/x');
    assert.equal(getInFlightCount(), 1);
    release();
    await p;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getInFlightCount(), 0);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch network error still decrements in-flight and emits error event', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const { events, uninstall } = setup();
  try {
    assert.equal(getInFlightCount(), 0);
    await assert.rejects(() => globalThis.fetch('https://api.example.com/x'), /offline/);
    assert.equal(getInFlightCount(), 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, null);
    assert.match(events[0].error, /offline/);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR lifecycle: open/send/loadend emits a network event', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  const { events, uninstall } = setup();
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/submit');
    xhr.setResponse({ status: 201, contentType: 'application/json', body: '{"ok":true}' });
    assert.equal(getInFlightCount(), 0);
    xhr.send('payload');
    assert.equal(getInFlightCount(), 1);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getInFlightCount(), 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].initiator, 'xhr');
    assert.equal(events[0].method, 'POST');
    assert.equal(events[0].status, 201);
    assert.equal(events[0].ok, true);
    assert.equal(events[0].req_body_size, 'payload'.length);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR error event emits event with error message', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  const { events, uninstall } = setup();
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/fail');
    xhr.setResponse({ status: 0, contentType: null, body: '', fireEvent: 'error' });
    xhr.send();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].error, 'network error');
    assert.equal(getInFlightCount(), 0);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('double install logs a warn and no-ops', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({ 'https://api.example.com/x': { status: 200, contentType: 'application/json', body: '{}' } });
  const { events, uninstall } = setup();
  // Second install should return a no-op uninstall and not double-wrap.
  const secondUninstall = installNetworkCapture({ onEvent: () => {} });
  try {
    await globalThis.fetch('https://api.example.com/x');
    await new Promise((r) => setTimeout(r, 0));
    // Only one event should land (one subscription).
    assert.equal(events.length, 1);
    // secondUninstall should be a safe no-op.
    secondUninstall();
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('filterSensitiveHeaders strips auth-shaped entries', () => {
  const out = filterSensitiveHeaders({
    Authorization: 'Bearer x',
    Cookie: 'a=b',
    'X-Api-Key': 'k',
    'X-Auth-Token': 't',
    'Proxy-Authorization': 'Basic y',
    'Content-Type': 'application/json',
  });
  assert.equal(out.Authorization, undefined);
  assert.equal(out.Cookie, undefined);
  assert.equal(out['X-Api-Key'], undefined);
  assert.equal(out['X-Auth-Token'], undefined);
  assert.equal(out['Proxy-Authorization'], undefined);
  assert.equal(out['Content-Type'], 'application/json');
});

test('consumer onEvent that throws does not break the request', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({ 'https://api.example.com/x': { status: 200, contentType: 'application/json', body: '{}' } });
  const uninstall = installNetworkCapture({
    onEvent: () => { throw new Error('consumer bug'); },
  });
  try {
    const res = await globalThis.fetch('https://api.example.com/x');
    assert.equal(res.status, 200);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('install without onEvent is a no-op', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  const original = async () => ({ status: 204, ok: true, headers: { get: () => null }, clone: () => ({ text: async () => '' }) });
  globalThis.fetch = original;
  const uninstall = installNetworkCapture();
  try {
    assert.equal(globalThis.fetch, original);
    assert.equal(getInFlightCount(), 0);
    uninstall();
  } finally {
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('install works when fetch and XHR are unavailable', () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  delete globalThis.fetch;
  delete globalThis.XMLHttpRequest;
  const events = [];
  const uninstall = installNetworkCapture({ onEvent: (e) => events.push(e) });
  try {
    assert.equal(getInFlightCount(), 0);
    assert.deepEqual(events, []);
    uninstall();
    uninstall();
  } finally {
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('filterSensitiveHeaders accepts Headers-like objects and ignores bad keys', () => {
  const headers = {
    forEach(fn) {
      fn('application/json', 'content-type');
      fn('Bearer x', 'authorization');
      fn('value', 123);
    },
  };
  assert.deepEqual(filterSensitiveHeaders(headers), { 'content-type': 'application/json' });
  assert.deepEqual(filterSensitiveHeaders({ forEach() { throw new Error('nope'); } }), {});
  assert.deepEqual(filterSensitiveHeaders(new Proxy({}, { ownKeys() { throw new Error('entries failed'); } })), {});
  assert.deepEqual(filterSensitiveHeaders(null), {});
});

test('install warnings tolerate throwing console.warn', () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  const savedWarn = console.warn;
  stubFetch({ 'https://api.example.com/x': { status: 200, contentType: 'application/json', body: '{}' } });
  const { uninstall } = setup();
  console.warn = () => { throw new Error('warn failed'); };
  try {
    installNetworkCapture({ onEvent: () => {} })();
    installNetworkCapture()();
  } finally {
    console.warn = savedWarn;
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch captures request-like inputs, methods, and request body sizes', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(input);
    return {
      status: 202,
      ok: true,
      headers: { get: () => null },
      clone: () => ({ text: async () => '' }),
    };
  };
  const { events, uninstall } = setup();
  try {
    const requestLike = { url: 'https://api.example.com/put', method: 'patch' };
    await globalThis.fetch(requestLike, { body: new Uint8Array([1, 2, 3]) });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls[0], requestLike);
    assert.equal(events[0].url, 'https://api.example.com/put');
    assert.equal(events[0].method, 'PATCH');
    assert.equal(events[0].req_body_size, 3);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch uses init.method and ArrayBuffer body size when provided', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({
    'POST https://api.example.com/post': {
      status: 200, contentType: 'application/json', body: '{}',
    },
  });
  const { events, uninstall } = setup();
  try {
    await globalThis.fetch('https://api.example.com/post', {
      method: 'post',
      body: new ArrayBuffer(4),
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events[0].method, 'POST');
    assert.equal(events[0].req_body_size, 4);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch handles String(input) fallback and unknown body size', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    clone: () => ({ text: async () => '' }),
  });
  const { events, uninstall } = setup();
  try {
    const input = { toString: () => 'https://api.example.com/stringified' };
    await globalThis.fetch(input, { body: new URLSearchParams('a=1') });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events[0].url, 'https://api.example.com/stringified');
    assert.equal(events[0].req_body_size, null);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch URL extraction failures and thrown strings are safe', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => { throw 'offline string'; };
  const { events, uninstall } = setup();
  try {
    const badInput = { toString() { throw new Error('stringify failed'); } };
    await assert.rejects(() => globalThis.fetch(badInput), /offline string/);
    assert.equal(events.length, 1);
    assert.equal(events[0].url, '');
    assert.equal(events[0].error, 'offline string');
    assert.equal(events[0].req_body_size, null);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch error captures request body size when the failing request had a body', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => { throw new Error('boom'); };
  const { events, uninstall } = setup();
  try {
    await assert.rejects(
      () => globalThis.fetch('https://api.example.com/fail-with-body', { method: 'POST', body: 'payload' }),
      /boom/,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].error, 'boom');
    assert.equal(events[0].req_body_size, 7);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch body read failures still emit metadata', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({
    'https://api.example.com/body-fails': {
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
      bodyThrows: true,
    },
  });
  const { events, uninstall } = setup({ options: { captureBody: true } });
  try {
    await globalThis.fetch('https://api.example.com/body-fails');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 200);
    assert.equal(events[0].res_body, null);
    assert.equal(events[0].res_body_truncated, false);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch body capture handles clone failures and non-string text', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  let mode = 'clone';
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: (name) => (name === 'content-type' ? 'text/plain' : null) },
    clone() {
      if (mode === 'clone') throw new Error('clone failed');
      return { text: async () => 42 };
    },
  });
  const { events, uninstall } = setup({ options: { captureBody: true, bodyMimeAllowlist: ['text/plain'] } });
  try {
    await globalThis.fetch('https://api.example.com/clone-fail');
    mode = 'number';
    await globalThis.fetch('https://api.example.com/non-string');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(events.map((e) => e.res_body), [null, null]);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch body capture promise rejection still emits metadata', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({
    'https://api.example.com/reject-body': {
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    },
  });
  const { events, uninstall } = setup({
    options: { captureBody: true, bodyMimeAllowlist: [null] },
  });
  try {
    await globalThis.fetch('https://api.example.com/reject-body');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 200);
    assert.equal(events[0].res_body, null);
    assert.equal(events[0].res_body_truncated, false);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch body capture rejection preserves fallback metadata branches', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    headers: {
      get: (name) => {
        if (name === 'content-type') return 'application/json';
        if (name === 'content-length') return 'unknown';
        return null;
      },
    },
    clone: () => ({ text: async () => '{"ok":true}' }),
  });
  const { events, uninstall } = setup({
    options: { captureBody: true, bodyMimeAllowlist: [null] },
  });
  try {
    await globalThis.fetch('https://api.example.com/reject-body-with-fallbacks', { body: 'payload' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].res_body_size, null);
    assert.equal(events[0].req_body_size, 7);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch metadata failures emit a minimal event and settle', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => ({
    status: 299,
    ok: true,
    get headers() { throw new Error('headers unavailable'); },
    clone: () => ({ text: async () => '{}' }),
  });
  const { events, uninstall } = setup({ options: { captureBody: true } });
  try {
    await globalThis.fetch('https://api.example.com/metadata-fails');
    assert.equal(getInFlightCount(), 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 299);
    assert.equal(events[0].res_content_type, null);
    assert.equal(events[0].req_body_size, null);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch metadata fallback handles an undefined response defensively', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => undefined;
  const { events, uninstall } = setup();
  try {
    const res = await globalThis.fetch('https://api.example.com/undefined-response');
    assert.equal(res, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, null);
    assert.equal(events[0].ok, false);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch metadata handles missing and throwing headers', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  let mode = 'missing';
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    headers: mode === 'missing' ? null : { get() { throw new Error('header failed'); } },
    clone: () => ({ text: async () => '' }),
  });
  const { events, uninstall } = setup();
  try {
    await globalThis.fetch('https://api.example.com/no-headers');
    mode = 'throwing';
    await globalThis.fetch('https://api.example.com/throwing-headers');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(events.map((e) => e.res_content_type), [null, null]);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('fetch skipped body capture for missing and disallowed content types', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  stubFetch({
    'https://api.example.com/no-type': { status: 200, body: 'secret' },
    'https://api.example.com/html': { status: 200, contentType: 'text/html', body: '<p>x</p>' },
  });
  const { events, uninstall } = setup({ options: { captureBody: true, bodyMimeAllowlist: ['application/json'] } });
  try {
    await globalThis.fetch('https://api.example.com/no-type');
    await globalThis.fetch('https://api.example.com/html');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(events.map((e) => e.res_body), [null, null]);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR send without tracked open falls through without telemetry', () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  let sent = false;
  class NoOpenXHR extends FakeXHR {
    send(body) {
      sent = body === 'payload';
    }
  }
  globalThis.XMLHttpRequest = NoOpenXHR;
  const { events, uninstall } = setup();
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.send('payload');
    assert.equal(sent, true);
    assert.equal(events.length, 0);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR listener attach failure emits and clears in-flight count', () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  class ListenerFailXHR extends FakeXHR {
    addEventListener() { throw new Error('no listeners'); }
  }
  globalThis.XMLHttpRequest = ListenerFailXHR;
  const { events, uninstall } = setup();
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/listener-fail');
    xhr.send();
    assert.equal(events.length, 1);
    assert.equal(events[0].error, 'listener attach failed');
    assert.equal(getInFlightCount(), 0);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR send exceptions emit and rethrow', () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  class ThrowSendXHR extends FakeXHR {
    send() { throw new Error('send boom'); }
  }
  globalThis.XMLHttpRequest = ThrowSendXHR;
  const { events, uninstall } = setup();
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/throws');
    assert.throws(() => xhr.send(new Blob(['abc'])), /send boom/);
    assert.equal(events.length, 1);
    assert.equal(events[0].error, 'send boom');
    assert.equal(events[0].req_body_size, 3);
    assert.equal(getInFlightCount(), 0);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR send exceptions without Error objects use generic send failure', () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  class ThrowStringSendXHR extends FakeXHR {
    send() { throw 'string boom'; }
  }
  globalThis.XMLHttpRequest = ThrowStringSendXHR;
  const { events, uninstall } = setup();
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/throws-string');
    assert.throws(() => xhr.send('payload'), /string boom/);
    assert.equal(events.length, 1);
    assert.equal(events[0].error, 'send failed');
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR body capture handles allowlist, truncation, and redaction', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  const { events, uninstall } = setup({
    options: { captureBody: true, maxBodyBytes: 22, bodyMimeAllowlist: ['text/plain'] },
  });
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/text');
    xhr.setResponse({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: 'token=abcdefghijklmnopqrstuvwxyz',
    });
    xhr.send();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].res_body, 'token=<redacted>');
    assert.equal(events[0].res_body_truncated, true);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR body capture skips missing/disallowed/non-text responses', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  const { events, uninstall } = setup({
    options: { captureBody: true, bodyMimeAllowlist: ['application/json'] },
  });
  try {
    const missing = new globalThis.XMLHttpRequest();
    missing.open('GET', 'https://api.example.com/missing-type');
    missing.setResponse({ status: 200, contentType: null, body: '{"a":1}' });
    missing.send();

    const disallowed = new globalThis.XMLHttpRequest();
    disallowed.open('GET', 'https://api.example.com/html');
    disallowed.setResponse({ status: 200, contentType: 'text/html', body: '<p>x</p>' });
    disallowed.send();

    const binary = new globalThis.XMLHttpRequest();
    binary.open('GET', 'https://api.example.com/binary');
    binary.responseType = 'arraybuffer';
    binary.setResponse({ status: 200, contentType: 'application/json', body: '{"a":1}' });
    binary.send();

    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(events.map((e) => e.res_body), [null, null, null]);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR handles non-string open args and throwing response surfaces', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  class OddXHR extends FakeXHR {
    get status() { throw new Error('status failed'); }
    set status(_v) {}
    getResponseHeader() { throw new Error('header failed'); }
    get responseText() { throw new Error('text failed'); }
    set responseText(_v) {}
  }
  globalThis.XMLHttpRequest = OddXHR;
  const { events, uninstall } = setup({ options: { captureBody: true } });
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open(123, { toString: () => 'https://api.example.com/object-url' });
    xhr.send();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].method, 'GET');
    assert.equal(events[0].url, 'https://api.example.com/object-url');
    assert.equal(events[0].status, null);
    assert.equal(events[0].res_content_type, null);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR metadata handles non-number status, missing headers, and non-string body', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  class OddMetadataXHR extends FakeXHR {
    constructor() {
      super();
      this.getResponseHeader = undefined;
    }
    send() {
      queueMicrotask(() => {
        this.status = '201';
        this.responseText = 42;
        this._emit('loadend');
      });
    }
  }
  globalThis.XMLHttpRequest = OddMetadataXHR;
  const { events, uninstall } = setup({ options: { captureBody: true } });
  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/odd-metadata');
    xhr.send();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, null);
    assert.equal(events[0].res_content_type, null);
    assert.equal(events[0].res_body, null);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR body capture handles throwing and non-string responseText', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  class OddBodyXHR extends FakeXHR {
    constructor() {
      super();
      this._throwResponseText = OddBodyXHR.throwResponseText;
    }
    get responseText() {
      if (this._throwResponseText) throw new Error('text failed');
      return this._responseText;
    }
    set responseText(value) {
      this._responseText = value;
    }
  }
  globalThis.XMLHttpRequest = OddBodyXHR;
  const { events, uninstall } = setup({
    options: { captureBody: true, bodyMimeAllowlist: ['application/json'] },
  });
  try {
    OddBodyXHR.throwResponseText = true;
    const throwing = new globalThis.XMLHttpRequest();
    throwing.open('GET', 'https://api.example.com/throwing-text');
    throwing.setResponse({ status: 200, contentType: 'application/json', body: '{"a":1}' });
    throwing.send();

    OddBodyXHR.throwResponseText = false;
    const nonString = new globalThis.XMLHttpRequest();
    nonString.open('GET', 'https://api.example.com/non-string-text');
    nonString.setResponse({ status: 200, contentType: 'application/json', body: 42 });
    nonString.send();

    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(events.map((e) => e.res_body), [null, null]);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});

test('XHR abort and timeout events preserve terminal reason once', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  const { events, uninstall } = setup();
  try {
    const aborted = new globalThis.XMLHttpRequest();
    aborted.open('GET', 'https://api.example.com/abort');
    aborted.setResponse({ status: 0, body: '', fireEvent: 'abort' });
    aborted.send();

    const timedOut = new globalThis.XMLHttpRequest();
    timedOut.open('GET', 'https://api.example.com/timeout');
    timedOut.setResponse({ status: 0, body: '', fireEvent: 'timeout' });
    timedOut.send();

    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(events.map((e) => e.error), ['aborted', 'timeout']);
    assert.equal(getInFlightCount(), 0);
  } finally {
    uninstall();
    restoreGlobals(savedFetch, savedXhr);
  }
});
