// Waiting-mode detector. Lives on the page side and heuristically decides
// when the operator is "waiting for the app", i.e. not interacting, but the
// page is busy (network in flight, spinner painted, DOM churning). When this
// holds, the recorder can throttle screenshots, pause mic, and exclude the
// wait from the session time budget, so a flow with a 15-minute report
// render doesn't burn the whole 10-minute active cap.
//
// This module is pure detection: it emits `waiting_start` / `waiting_end`
// through caller-supplied callbacks and exposes a `getState()`. It does NOT
// call chrome.runtime.sendMessage itself; the caller (content.js) is
// responsible for forwarding to the SW. Keeping the module transport-free
// makes it trivially unit-testable and lets us reuse it from tests without
// stubbing the extension runtime.
//
// Signals (any subset active while user input is absent → busy):
//   - network_active  : getInFlightCount() > 0  (network-capture.js; optional)
//   - spinner_visible : aria-busy / progressbar / common spinner selectors
//                       visible in the viewport
//   - dom_churn       : MutationObserver rate sustained above threshold
//
// Entering WAITING requires: no user input for >=idleMs AND at least one
// other busy signal present. Leaving WAITING happens on any input event,
// OR when every busy signal has been absent for quiesceMs (page genuinely
// went idle and the operator walked away).
//
// Safety: every selector query / callback invocation is try/catch'd. A bug
// here must never break the host page; the worst failure mode is silently
// not detecting a wait.

// Optional dependency. We import at module load but guard the call site in
// case the network-capture module is absent or was never installed: the
// barrel re-exports `getInFlightCount` which returns 0 when nothing was
// patched, so this is safe even when no fetch/XHR is in flight.
import { getInFlightCount as _getInFlightCount } from './network-capture.js';

const DEFAULT_THRESHOLDS = {
  // Inactivity required before WAITING can arm. Operators naturally pause
  // between clicks while reading; 10s is long enough to avoid flagging
  // ordinary reading as a wait.
  idleMs: 10_000,
  // All-signals-absent duration needed to leave WAITING when the user hasn't
  // interacted. Short so we exit quickly once the app quiesces.
  quiesceMs: 2_000,
  // DOM mutation rate threshold: mutations per 1s window. 20/s sustained
  // for >=1s is about where "app re-rendering" starts, below which most
  // pages sit at normal idle.
  mutationsPerSecond: 20,
  // Rolling window tick interval for DOM mutation counting (and also the
  // cadence at which transitions are evaluated). 1000ms keeps the detector
  // cheap and the transitions responsive enough.
  tickMs: 1000,
  // Spinner / busy-indicator poll. Selector queries are the most expensive
  // part of detection, so we do them on their own slower cadence instead of
  // per-mutation. 2000ms feels instant for a wait that lasts minutes.
  spinnerPollMs: 2000,
};

// Common spinner selectors. Matching is visibility-gated: a hidden spinner
// in the DOM doesn't count. Attribute-based selectors (aria-busy,
// progressbar) are intentionally first so role-based components light up
// before generic class-name heuristics.
const SPINNER_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '.spinner',
  '.loading',
  '.loader',
  '[class*="spinner"]',
  '[class*="loading"]',
];
const SPINNER_SELECTOR = SPINNER_SELECTORS.join(', ');

// User-input events that reset the "last input" timer. Capture phase so we
// see them before any app handler can stop propagation. Passive listeners
// where the DOM allows; we never prevent default, only observe.
const INPUT_EVENTS = ['click', 'keydown', 'input', 'scroll', 'pointermove'];

// Module-level singleton guard. Like installNetworkCapture, second install
// is a warning-and-noop so a double start() doesn't brick the page. The
// live accessor below is updated on each install/uninstall so getState()
// reads from the currently-installed detector.
let installed = false;
let _getStateImpl = () => 'idle';

export function installWaitingDetector({
  onWaitingStart,
  onWaitingEnd,
  thresholds,
} = {}) {
  if (installed) {
    /* node:coverage disable */
    try { console.warn('[recaptain] waiting detector already installed'); } catch {}
    /* node:coverage enable */
    return () => {};
  }

  const T = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const safeStart = typeof onWaitingStart === 'function' ? onWaitingStart : () => {};
  const safeEnd = typeof onWaitingEnd === 'function' ? onWaitingEnd : () => {};

  installed = true;

  // --- state ---------------------------------------------------------
  let state = 'idle';                 // 'idle' | 'waiting'
  let manualOverride = false;         // sidepanel "I'm waiting" button
  let lastInputAt = Date.now();       // timestamp of most recent user input
  let waitingStartedAt = null;        // when the current WAITING window began
  let waitingReasons = new Set();     // reasons observed *this* window
  let peakInFlight = 0;               // max concurrent in-flight during window

  // Rolling-window mutation counter. Reset each tick; if the previous tick
  // was above threshold AND the current tick is above threshold (i.e.
  // sustained), we treat dom_churn as active.
  let mutationsThisWindow = 0;
  let lastWindowRate = 0;
  let churnActive = false;

  // Last observed value of each signal + the timestamp it last flipped to
  // active. quiesceMs is measured against the max of these timestamps.
  const signalLastActive = {
    network_active: 0,
    spinner_visible: 0,
    dom_churn: 0,
  };

  // --- signal probes -------------------------------------------------

  // Network signal. If network-capture never installed, getInFlightCount
  // returns 0 and this is effectively a no-op, exactly what we want (we
  // just lose that signal, the detector still works on spinner + churn).
  function probeNetwork() {
    try {
      const n = _getInFlightCount();
      const active = typeof n === 'number' && n > 0;
      if (active) {
        signalLastActive.network_active = Date.now();
        if (n > peakInFlight) peakInFlight = n;
      }
      return active;
    /* node:coverage disable */
    } catch {
      return false;
    }
    /* node:coverage enable */
  }

  // Visibility check for spinner candidates. getBoundingClientRect is
  // accurate enough; we don't need a full getComputedStyle per candidate,
  // and a 1px offscreen rect is fine to ignore.
  function isVisibleInViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (r.bottom <= 0 || r.right <= 0) return false;
      if (r.top >= vh || r.left >= vw) return false;
      return true;
    } catch { return false; }
  }

  function probeSpinner() {
    try {
      const nodes = document.querySelectorAll(SPINNER_SELECTOR);
      for (const el of nodes) {
        if (isVisibleInViewport(el)) {
          signalLastActive.spinner_visible = Date.now();
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  function probeChurn() {
    // Sustained means two consecutive windows both above threshold, avoids
    // flagging a one-frame render burst on e.g. SPA route change.
    const sustained = churnActive;
    if (sustained) signalLastActive.dom_churn = Date.now();
    return sustained;
  }

  // --- transitions ---------------------------------------------------

  function activeReasons() {
    const reasons = [];
    if (probeNetwork()) reasons.push('network_active');
    if (probeSpinner()) reasons.push('spinner_visible');
    if (probeChurn()) reasons.push('dom_churn');
    return reasons;
  }

  function tick() {
    // Roll the mutation window first; churnActive is read by probeChurn
    // via activeReasons() below. "Sustained" = last window AND this window
    // both above threshold.
    const rate = mutationsThisWindow;
    churnActive = (rate >= T.mutationsPerSecond) && (lastWindowRate >= T.mutationsPerSecond);
    lastWindowRate = rate;
    mutationsThisWindow = 0;

    const reasons = activeReasons();
    const now = Date.now();
    const idleFor = now - lastInputAt;

    if (state === 'idle') {
      if (idleFor >= T.idleMs && reasons.length > 0) {
        enterWaiting(reasons);
      }
      return;
    }

    // state === 'waiting'
    if (manualOverride) {
      // Still track reasons even while manual; downstream wants an honest
      // log of what the auto-detector would have said.
      for (const r of reasons) waitingReasons.add(r);
      return;
    }
    for (const r of reasons) waitingReasons.add(r);

    // Quiesce exit: all signals inactive for >= quiesceMs since they last
    // flipped. We measure from the latest last-active timestamp of any
    // signal: that's when the page most recently *stopped* being busy.
    const latestActive = Math.max(
      signalLastActive.network_active,
      signalLastActive.spinner_visible,
      signalLastActive.dom_churn,
    );
    if (reasons.length === 0 && latestActive > 0 && (now - latestActive) >= T.quiesceMs) {
      exitWaiting();
    }
  }

  function enterWaiting(initialReasons) {
    state = 'waiting';
    waitingStartedAt = Date.now();
    waitingReasons = new Set(initialReasons);
    peakInFlight = 0;
    // Seed peak from current network probe so the first tick inside
    // waiting already reflects the value that triggered entry.
    try {
      const n = _getInFlightCount();
      if (typeof n === 'number' && n > peakInFlight) peakInFlight = n;
    /* node:coverage disable */
    } catch {}
    /* node:coverage enable */
    try {
      safeStart({
        started_at: waitingStartedAt,
        reasons: Array.from(waitingReasons),
      });
    } catch {}
  }

  function exitWaiting() {
    const endedAt = Date.now();
    const started = waitingStartedAt;
    const payload = {
      ended_at: endedAt,
      duration_ms: endedAt - started,
      reasons: Array.from(waitingReasons),
      peak_reqs: peakInFlight,
    };
    state = 'idle';
    waitingStartedAt = null;
    waitingReasons = new Set();
    peakInFlight = 0;
    try { safeEnd(payload); } catch {}
  }

  // --- input listeners ----------------------------------------------

  function onUserInput() {
    lastInputAt = Date.now();
    // Any real user input exits waiting immediately; the operator is back.
    // Manual override stays sticky; only the explicit setManualWaiting(false)
    // can clear it.
    if (state === 'waiting' && !manualOverride) {
      exitWaiting();
    }
  }

  for (const ev of INPUT_EVENTS) {
    // Passive + capture: we observe, never consume. pointermove can fire
    // at 100+ Hz; throttling isn't strictly needed because the handler just
    // updates a timestamp and runs an O(1) state check.
    try {
      document.addEventListener(ev, onUserInput, { capture: true, passive: true });
    } catch {}
  }

  // --- mutation observer --------------------------------------------

  // document.body may not exist yet if content script ran before body parse
  // finished; in practice content.js is run_at=document_idle so body is
  // there, but guard anyway.
  const observer = new MutationObserver((mutations) => {
    // Only count. Heavy work per mutation is precisely what we're trying to
    // avoid; a page that is already churning should not get more expensive
    // to observe.
    mutationsThisWindow += mutations.length;
  });
  try {
    if (document.body) {
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
  } catch {}

  // --- timers --------------------------------------------------------

  const tickHandle = setInterval(() => {
    /* node:coverage disable */
    try { tick(); } catch {}
    /* node:coverage enable */
  }, T.tickMs);

  // Spinner poll fires the same tick() path; we just want an extra check
  // at spinner cadence so entering WAITING because of a visible spinner
  // isn't delayed by up to tickMs.
  const spinnerHandle = setInterval(() => {
    /* node:coverage disable */
    try { tick(); } catch {}
    /* node:coverage enable */
  }, T.spinnerPollMs);

  // --- uninstall / public API ---------------------------------------

  function uninstall() {
    if (!installed) return;
    installed = false;
    clearInterval(tickHandle);
    clearInterval(spinnerHandle);
    try { observer.disconnect(); } catch {}
    for (const ev of INPUT_EVENTS) {
      try { document.removeEventListener(ev, onUserInput, { capture: true }); } catch {}
    }
    // If we're torn down mid-wait, close the window so consumers aren't
    // left with an unmatched `waiting_start`.
    if (state === 'waiting') {
      /* node:coverage disable */
      try { exitWaiting(); } catch {}
      /* node:coverage enable */
    }
    _getStateImpl = () => 'idle';
  }

  // Expose the control surface on the uninstall function so the caller can
  // query state / drive manual override without needing a second handle.
  uninstall.getState = () => state;
  uninstall.setManualWaiting = (active) => {
    manualOverride = !!active;
    if (manualOverride && state === 'idle') {
      enterWaiting(['manual']);
    } else if (!manualOverride && state === 'waiting') {
      // Drop out unless the auto-detector would still hold us here.
      const reasons = activeReasons();
      const idleFor = Date.now() - lastInputAt;
      if (!(idleFor >= T.idleMs && reasons.length > 0)) {
        exitWaiting();
      }
    }
  };

  // Register the live accessor so the module-level getState() reflects
  // this detector instance. Cleared on uninstall.
  _getStateImpl = uninstall.getState;

  return uninstall;
}

// Standalone getState() so the SW (or tests) can peek without owning the
// uninstall handle. Returns 'idle' when no detector is installed.
export function getState() {
  /* node:coverage disable */
  try { return _getStateImpl(); } catch { return 'idle'; }
  /* node:coverage enable */
}

// Test-only hook: reset the module-level singleton guard between cases.
// Not part of the public API.
export function __resetForTests() {
  installed = false;
  _getStateImpl = () => 'idle';
}
