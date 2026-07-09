// Unit tests for the waiting-mode detector.
//
// The module reaches into: document.addEventListener/removeEventListener,
// document.querySelectorAll, document.body, window.innerWidth/innerHeight,
// setInterval/clearInterval, Date.now, and MutationObserver. We stub just
// enough of each to drive state transitions from the node test runner, and
// use a fake timer to step through ticks deterministically.
//
// We deliberately do NOT exercise the real DOM; the detector's behavior is
// defined by what these surfaces return, so a small surface stub is enough
// and keeps tests fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installNetworkCapture,
  __resetForTests as resetNetworkCaptureForTests,
} from '../../src/shared/network-capture.js';
import {
  installWaitingDetector,
  getState,
  __resetForTests as resetWaitingDetectorForTests,
} from '../../src/shared/waiting-mode.js';

const REAL_DATE = Date;

// --- DOM stubs ---------------------------------------------------------

function installDom() {
  const listeners = new Map(); // event -> Set of handlers
  let throwOnAdd = false;
  let throwOnRemove = false;
  const doc = {
    addEventListener(ev, fn) {
      if (throwOnAdd) throw new Error('add failed');
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) {
      if (throwOnRemove) throw new Error('remove failed');
      listeners.get(ev)?.delete(fn);
    },
    querySelectorAll() { return []; },
    body: {},
    documentElement: { clientWidth: 1024, clientHeight: 768 },
    _listeners: listeners,
    _dispatch(ev, detail) {
      for (const fn of listeners.get(ev) || []) fn(detail || {});
    },
    _setSpinner(visible) {
      doc.querySelectorAll = () => visible ? [{
        getBoundingClientRect: () => ({ width: 20, height: 20, top: 10, left: 10, bottom: 30, right: 30 }),
      }] : [];
    },
    _setSpinnerRect(rect) {
      doc.querySelectorAll = () => [{
        getBoundingClientRect: () => rect,
      }];
    },
    _throwOnSpinnerQuery() {
      doc.querySelectorAll = () => { throw new Error('query failed'); };
    },
    _throwOnAddEventListener() {
      throwOnAdd = true;
    },
    _throwOnRemoveEventListener() {
      throwOnRemove = true;
    },
  };

  globalThis.document = doc;
  globalThis.window = { innerWidth: 1024, innerHeight: 768 };
  // Minimal MutationObserver: captures the callback so tests can push
  // synthetic mutation batches.
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  globalThis.__observers = observers;

  // Fake timers. setInterval returns an id; we keep a ledger of handles so
  // tests can advance time by firing each due callback.
  let nextId = 1;
  const intervals = new Map(); // id -> { fn, period, last }
  const now = { t: 1_000_000 };
  globalThis.setInterval = (fn, period) => {
    const id = nextId++;
    intervals.set(id, { fn, period, last: now.t });
    return id;
  };
  globalThis.clearInterval = (id) => { intervals.delete(id); };
  globalThis.__advance = (ms) => {
    const end = now.t + ms;
    // Fire intervals in time order until we reach `end`.
    while (true) {
      let next = null;
      for (const [id, rec] of intervals) {
        const due = rec.last + rec.period;
        if (due <= end && (next == null || due < next.due)) next = { id, due, rec };
      }
      if (!next) break;
      now.t = next.due;
      next.rec.last = next.due;
      try { next.rec.fn(); } catch {}
    }
    now.t = end;
  };
  globalThis.__setNow = (t) => { now.t = t; };
  globalThis.__now = () => now.t;

  // Override Date.now to follow our fake clock.
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    static now() { return now.t; }
  };

  return { doc, observers, intervals, now };
}

function teardownDom() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.MutationObserver;
  delete globalThis.setInterval;
  delete globalThis.clearInterval;
  delete globalThis.__observers;
  delete globalThis.__advance;
  delete globalThis.__setNow;
  delete globalThis.__now;
  globalThis.Date = REAL_DATE;
  resetNetworkCaptureForTests();
  resetWaitingDetectorForTests();
}

async function freshImport() {
  return {
    installWaitingDetector,
    getState,
    __resetForTests: resetWaitingDetectorForTests,
  };
}

// --- tests -------------------------------------------------------------

test('getState is idle before any install', async () => {
  installDom();
  try {
    const mod = await freshImport();
    assert.equal(mod.getState(), 'idle');
  } finally { teardownDom(); }
});

test('enters waiting after idleMs with a spinner visible', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      onWaitingEnd: (p) => ends.push(p),
      thresholds: { idleMs: 5_000, quiesceMs: 2_000, tickMs: 1_000, spinnerPollMs: 2_000 },
    });

    doc._setSpinner(true);
    // Advance past idle threshold so waiting can arm.
    globalThis.__advance(6_000);

    assert.equal(starts.length, 1, 'waiting_start fired');
    assert.ok(starts[0].reasons.includes('spinner_visible'));
    assert.equal(mod.getState(), 'waiting');

    uninstall();
  } finally { teardownDom(); }
});

test('exits waiting on user input', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      onWaitingEnd: (p) => ends.push(p),
      thresholds: { idleMs: 5_000, quiesceMs: 2_000, tickMs: 1_000, spinnerPollMs: 2_000 },
    });

    doc._setSpinner(true);
    globalThis.__advance(6_000);
    assert.equal(mod.getState(), 'waiting');

    // Dispatch a click, should exit immediately.
    doc._dispatch('click');
    assert.equal(mod.getState(), 'idle');
    assert.equal(ends.length, 1);
    assert.ok(ends[0].duration_ms > 0);

    uninstall();
  } finally { teardownDom(); }
});

test('exits waiting after quiesceMs when signals go silent', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      onWaitingEnd: (p) => ends.push(p),
      thresholds: { idleMs: 5_000, quiesceMs: 2_000, tickMs: 1_000, spinnerPollMs: 2_000 },
    });

    doc._setSpinner(true);
    globalThis.__advance(6_000);
    assert.equal(mod.getState(), 'waiting');

    // Remove spinner; advance past quiesce window. No input fired, so exit
    // is by quiesce path.
    doc._setSpinner(false);
    globalThis.__advance(4_000);
    assert.equal(mod.getState(), 'idle');
    assert.equal(ends.length, 1);

    uninstall();
  } finally { teardownDom(); }
});

test('manual override enters waiting regardless of signals', async () => {
  installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      onWaitingEnd: () => {},
    });

    uninstall.setManualWaiting(true);
    assert.equal(mod.getState(), 'waiting');
    assert.deepEqual(starts[0].reasons, ['manual']);

    uninstall();
  } finally { teardownDom(); }
});

test('manual override blocks auto-exit on input, clears cleanly', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: () => {},
      onWaitingEnd: (p) => ends.push(p),
    });

    uninstall.setManualWaiting(true);
    // User input should NOT drop us out while manual is engaged.
    doc._dispatch('click');
    assert.equal(mod.getState(), 'waiting');
    assert.equal(ends.length, 0);

    // Explicit release. No busy signals → auto path exits.
    uninstall.setManualWaiting(false);
    assert.equal(mod.getState(), 'idle');
    assert.equal(ends.length, 1);

    uninstall();
  } finally { teardownDom(); }
});

test('second install is a no-op (singleton guard)', async () => {
  installDom();
  try {
    const mod = await freshImport();
    const u1 = mod.installWaitingDetector({});
    const u2 = mod.installWaitingDetector({});
    // The second install returns a no-op uninstall, but getState still
    // reflects the first. This mirrors network-capture.js semantics.
    assert.equal(typeof u1, 'function');
    assert.equal(typeof u2, 'function');
    u1();
    u2();
  } finally { teardownDom(); }
});

test('uninstall mid-wait closes the window', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: () => {},
      onWaitingEnd: (p) => ends.push(p),
      thresholds: { idleMs: 1_000, quiesceMs: 2_000, tickMs: 500, spinnerPollMs: 500 },
    });

    doc._setSpinner(true);
    globalThis.__advance(2_000);
    assert.equal(mod.getState(), 'waiting');

    uninstall();
    assert.equal(ends.length, 1, 'pending waiting window was closed on uninstall');
  } finally { teardownDom(); }
});

test('getState returns idle after uninstall', async () => {
  installDom();
  try {
    const mod = await freshImport();
    const uninstall = mod.installWaitingDetector({});
    assert.equal(mod.getState(), 'idle');
    uninstall();
    assert.equal(mod.getState(), 'idle');
  } finally { teardownDom(); }
});

test('network activity alone can enter waiting and records peak requests', async () => {
  installDom();
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => {
    await gate;
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      clone: () => ({ text: async () => '' }),
    };
  };

  const netUninstall = installNetworkCapture({ onEvent: () => {} });
  try {
    const mod = await freshImport();
    const starts = [];
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      onWaitingEnd: (p) => ends.push(p),
      thresholds: { idleMs: 1_000, quiesceMs: 1_000, tickMs: 500, spinnerPollMs: 10_000 },
    });

    const req = globalThis.fetch('https://api.example.com/slow');
    globalThis.__advance(1_500);
    assert.equal(mod.getState(), 'waiting');
    assert.deepEqual(starts[0].reasons, ['network_active']);

    release();
    await req;
    await new Promise((r) => setTimeout(r, 0));
    globalThis.__advance(2_000);
    assert.equal(mod.getState(), 'idle');
    assert.equal(ends[0].peak_reqs, 1);
    uninstall();
  } finally {
    netUninstall();
    if (savedFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = savedFetch;
    if (savedXhr === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = savedXhr;
    teardownDom();
  }
});

test('spinner query failures and invisible candidates are treated as not busy', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      thresholds: { idleMs: 1_000, tickMs: 500, spinnerPollMs: 500 },
    });

    doc._throwOnSpinnerQuery();
    globalThis.__advance(1_500);
    assert.equal(starts.length, 0);

    doc._setSpinnerRect({ width: 0, height: 20, top: 10, left: 10, bottom: 30, right: 30 });
    globalThis.__advance(1_000);
    assert.equal(starts.length, 0);

    doc._setSpinnerRect({ width: 10, height: 10, top: 900, left: 10, bottom: 920, right: 20 });
    globalThis.__advance(1_000);
    assert.equal(starts.length, 0);

    doc._setSpinnerRect({ get width() { throw new Error('rect failed'); } });
    globalThis.__advance(1_000);
    assert.equal(starts.length, 0);

    uninstall();
  } finally { teardownDom(); }
});

test('spinner visibility uses document viewport fallbacks', async () => {
  const { doc } = installDom();
  try {
    globalThis.window.innerWidth = 0;
    globalThis.window.innerHeight = 0;
    doc.documentElement.clientWidth = 200;
    doc.documentElement.clientHeight = 100;

    const mod = await freshImport();
    const starts = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      thresholds: { idleMs: 1_000, tickMs: 500, spinnerPollMs: 500 },
    });

    doc._setSpinnerRect({ width: 10, height: 10, top: 20, left: 20, bottom: 30, right: 30 });
    globalThis.__advance(1_500);
    assert.equal(mod.getState(), 'waiting');
    assert.ok(starts[0].reasons.includes('spinner_visible'));

    uninstall();
  } finally { teardownDom(); }
});

test('spinner visibility treats missing viewport dimensions as hidden', async () => {
  const { doc } = installDom();
  try {
    globalThis.window.innerWidth = 0;
    globalThis.window.innerHeight = 0;
    doc.documentElement.clientWidth = 0;
    doc.documentElement.clientHeight = 0;

    const mod = await freshImport();
    const starts = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      thresholds: { idleMs: 1_000, tickMs: 500, spinnerPollMs: 500 },
    });

    doc._setSpinnerRect({ width: 10, height: 10, top: 0, left: 0, bottom: 10, right: 10 });
    globalThis.__advance(1_500);
    assert.equal(starts.length, 0);

    uninstall();
  } finally { teardownDom(); }
});

test('spinner candidates outside the leading viewport edge are ignored', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      thresholds: { idleMs: 1_000, tickMs: 500, spinnerPollMs: 500 },
    });

    doc._setSpinnerRect({ width: 10, height: 10, top: -20, left: -20, bottom: -10, right: -10 });
    globalThis.__advance(1_500);
    assert.equal(starts.length, 0);

    uninstall();
  } finally { teardownDom(); }
});

test('waiting detector tolerates throwing DOM listeners and observers', async () => {
  const { doc, observers } = installDom();
  const BaseObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class extends BaseObserver {
    observe() { throw new Error('observe failed'); }
    disconnect() { throw new Error('disconnect failed'); }
  };
  doc._throwOnAddEventListener();
  try {
    const mod = await freshImport();
    const uninstall = mod.installWaitingDetector({});
    assert.equal(observers.length, 1);
    doc._throwOnRemoveEventListener();
    uninstall();
    assert.equal(mod.getState(), 'idle');
  } finally { teardownDom(); }
});

test('waiting callbacks that throw do not break transitions', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: () => { throw new Error('start failed'); },
      onWaitingEnd: () => { throw new Error('end failed'); },
      thresholds: { idleMs: 500, quiesceMs: 500, tickMs: 500, spinnerPollMs: 500 },
    });

    doc._setSpinner(true);
    globalThis.__advance(1_000);
    assert.equal(mod.getState(), 'waiting');
    doc._setSpinner(false);
    globalThis.__advance(1_500);
    assert.equal(mod.getState(), 'idle');
    uninstall();
  } finally { teardownDom(); }
});

test('sustained DOM churn enters waiting', async () => {
  const { observers } = installDom();
  try {
    const mod = await freshImport();
    const starts = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: (p) => starts.push(p),
      thresholds: { idleMs: 0, mutationsPerSecond: 2, tickMs: 1_000, spinnerPollMs: 10_000 },
    });

    observers[0].cb([{}, {}]);
    globalThis.__advance(1_000);
    assert.equal(starts.length, 0, 'one busy window is not sustained churn');

    observers[0].cb([{}, {}]);
    globalThis.__advance(1_000);
    assert.equal(mod.getState(), 'waiting');
    assert.ok(starts[0].reasons.includes('dom_churn'));

    uninstall();
  } finally { teardownDom(); }
});

test('manual waiting tracks auto reasons and release stays waiting while busy', async () => {
  const { doc } = installDom();
  try {
    const mod = await freshImport();
    const ends = [];
    const uninstall = mod.installWaitingDetector({
      onWaitingStart: () => {},
      onWaitingEnd: (p) => ends.push(p),
      thresholds: { idleMs: 0, quiesceMs: 1_000, tickMs: 500, spinnerPollMs: 500 },
    });

    uninstall.setManualWaiting(true);
    doc._setSpinner(true);
    globalThis.__advance(500);
    uninstall.setManualWaiting(false);
    assert.equal(mod.getState(), 'waiting');

    doc._setSpinner(false);
    globalThis.__advance(2_000);
    assert.equal(mod.getState(), 'idle');
    assert.ok(ends[0].reasons.includes('manual'));
    assert.ok(ends[0].reasons.includes('spinner_visible'));

    uninstall();
  } finally { teardownDom(); }
});

test('__resetForTests returns module state to idle', async () => {
  installDom();
  try {
    const mod = await freshImport();
    const uninstall = mod.installWaitingDetector({});
    uninstall.setManualWaiting(true);
    assert.equal(mod.getState(), 'waiting');
    mod.__resetForTests();
    assert.equal(mod.getState(), 'idle');
    uninstall();
  } finally { teardownDom(); }
});
