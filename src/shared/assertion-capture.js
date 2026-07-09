// Assertion capture — a hotkey-driven overlay that turns the recording from
// a passive trace into a test. Operator hovers an element, presses
// Cmd/Ctrl+Shift+A, picks an assertion kind in a small Shadow-DOM overlay,
// and an `assertion` activity event is emitted alongside the usual trace.
//
// The module is deliberately decoupled from content.js: the caller injects
// its own describeElement (which lives inside content.js's install() closure)
// and the onAssertion callback forwards the entry into the activity stream.
//
// While the overlay is open we set window.__recaptainAssertionActive = true so
// content.js's recording listeners can early-return and avoid capturing the
// operator's interactions with the overlay itself as real page events.

import { scrubUrlRelative } from './privacy.js';

const FLAG = '__recaptainAssertionActive';
const MAX_EXPECTED_LEN = 200;
const MAX_CONTAINS_LEN = 50;

export function installAssertionCapture({ onAssertion, describeElement }) {
  if (typeof onAssertion !== 'function') throw new Error('onAssertion required');
  if (typeof describeElement !== 'function') throw new Error('describeElement required');

  let lastMouseX = -1;
  let lastMouseY = -1;
  let overlayHost = null;   // outer <div> attached to document.body
  let uninstalled = false;

  function scrubUrl(u) { return scrubUrlRelative(u, location.href); }

  function isMac() {
    try {
      if (navigator.userAgentData?.platform) return /mac/i.test(navigator.userAgentData.platform);
    } catch {}
    return /Mac|iPhone|iPad/.test(navigator.platform || '');
  }

  function onMouseMove(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }

  function pickTarget() {
    let el = null;
    if (lastMouseX >= 0 && lastMouseY >= 0) {
      try { el = document.elementFromPoint(lastMouseX, lastMouseY); } catch {}
    }
    if (!el || el === document.body || el === document.documentElement) {
      el = document.activeElement;
    }
    if (!el || el === document.body || el === document.documentElement) return null;
    // Don't allow targeting nodes inside the overlay host.
    if (overlayHost && overlayHost.contains(el)) return null;
    return el;
  }

  function onKeyDown(e) {
    const mac = isMac();
    const modOk = mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    if (!modOk || !e.shiftKey) return;
    // Match 'A' (case-insensitive — shift may upper-case it in .key)
    if (e.key !== 'A' && e.key !== 'a') return;
    e.preventDefault();
    e.stopPropagation();
    if (overlayHost) return; // already open
    const target = pickTarget();
    if (!target) return;
    openOverlay(target);
  }

  // --- overlay ---------------------------------------------------------

  // Tiny version of sidepanel's targetLabel — just enough for a title.
  function shortLabel(t) {
    if (!t) return 'element';
    if (t.accessible_name) return `${t.role || t.tag || '?'} "${t.accessible_name}"`;
    if (t.test_id) return `[data-testid="${t.test_id}"]`;
    if (t.label) return `${t.role || t.tag || '?'} "${t.label}"`;
    if (t.text) return `${t.tag || '?'} "${t.text}"`;
    if (t.placeholder) return `${t.tag || '?'} (placeholder "${t.placeholder}")`;
    if (t.id) return `${t.tag || '?'}#${t.id}`;
    return t.tag || 'element';
  }

  // Best-effort CSS selector from the describeElement output — used to pre-fill
  // the count field. We accept any match count; the operator can overwrite.
  function primarySelector(desc) {
    if (!desc) return null;
    if (desc.test_id) return `[data-testid="${cssEsc(desc.test_id)}"]`;
    if (desc.css) return desc.css;
    return null;
  }

  function cssEsc(v) {
    try { return CSS.escape(v); } catch { return String(v).replace(/["\\]/g, '\\$&'); }
  }

  function computeActual(kind, target, el, expected, attrName) {
    try {
      if (kind === 'visible') {
        const r = el.getBoundingClientRect();
        return !!(r.width > 0 && r.height > 0);
      }
      if (kind === 'text_equals' || kind === 'text_contains') {
        return (el.textContent || '').trim().slice(0, MAX_EXPECTED_LEN);
      }
      if (kind === 'count') {
        const sel = primarySelector(target);
        if (!sel) return null;
        try { return document.querySelectorAll(sel).length; } catch { return null; }
      }
      if (kind === 'attr_equals') {
        if (!attrName) return null;
        return el.getAttribute(attrName);
      }
    } catch {}
    return null;
  }

  function openOverlay(targetEl) {
    window[FLAG] = true;
    const desc = describeElement(targetEl);
    const labelText = shortLabel(desc);

    overlayHost = document.createElement('div');
    overlayHost.setAttribute('data-recaptain-assertion-overlay', '');
    // Outer host is positioned absolutely; shadow root holds the UI.
    overlayHost.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;';
    const shadow = overlayHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; }
      .panel {
        position: fixed;
        width: 300px;
        max-width: calc(100vw - 16px);
        background: #1a1a1a;
        color: #fff;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        border: 1px solid #333;
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        padding: 10px 12px;
      }
      .title {
        font-weight: 600;
        margin-bottom: 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      label { display: block; margin-top: 8px; font-size: 11px; color: #bbb; }
      select, input {
        width: 100%;
        margin-top: 3px;
        background: #0f0f0f;
        color: #fff;
        border: 1px solid #333;
        border-radius: 4px;
        padding: 5px 6px;
        font: inherit;
      }
      select:focus, input:focus { outline: 1px solid #4b9fff; border-color: #4b9fff; }
      .row { display: flex; gap: 6px; }
      .row > * { flex: 1; }
      .buttons { margin-top: 10px; display: flex; gap: 6px; justify-content: flex-end; }
      button {
        background: #2a2a2a;
        color: #fff;
        border: 1px solid #444;
        border-radius: 4px;
        padding: 5px 10px;
        font: inherit;
        cursor: pointer;
      }
      button.primary { background: #2b6cb0; border-color: #2b6cb0; }
      button:hover { filter: brightness(1.15); }
      .hint { margin-top: 6px; font-size: 11px; color: #888; }
    `;
    shadow.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="title"></div>
      <label>Assertion</label>
      <select data-kind>
        <option value="visible">Visible</option>
        <option value="text_equals">Text equals</option>
        <option value="text_contains">Text contains</option>
        <option value="count">Count (N matching)</option>
        <option value="attr_equals">Attribute equals</option>
      </select>
      <div data-fields></div>
      <div class="buttons">
        <button data-cancel>Cancel</button>
        <button class="primary" data-save>Save</button>
      </div>
      <div class="hint">Enter saves - Esc cancels</div>
    `;
    shadow.appendChild(panel);

    panel.querySelector('.title').textContent = `Assert on ${labelText}`;

    const kindSel = panel.querySelector('[data-kind]');
    const fields = panel.querySelector('[data-fields]');
    const saveBtn = panel.querySelector('[data-save]');
    const cancelBtn = panel.querySelector('[data-cancel]');

    function renderFields() {
      const kind = kindSel.value;
      fields.innerHTML = '';
      if (kind === 'visible') {
        // no inputs
        return;
      }
      if (kind === 'text_equals') {
        const full = (targetEl.textContent || '').trim().slice(0, MAX_EXPECTED_LEN);
        fields.innerHTML = `<label>Expected text</label><input data-expected type="text" />`;
        fields.querySelector('[data-expected]').value = full;
        return;
      }
      if (kind === 'text_contains') {
        const snippet = (targetEl.textContent || '').trim().slice(0, MAX_CONTAINS_LEN);
        fields.innerHTML = `<label>Expected substring</label><input data-expected type="text" />`;
        fields.querySelector('[data-expected]').value = snippet;
        return;
      }
      if (kind === 'count') {
        const sel = primarySelector(desc);
        let n = '';
        if (sel) {
          try { n = String(document.querySelectorAll(sel).length); } catch {}
        }
        fields.innerHTML = `
          <label>Expected count${sel ? '' : ' (no selector available)'}</label>
          <input data-expected type="number" min="0" step="1" />
        `;
        fields.querySelector('[data-expected]').value = n;
        return;
      }
      if (kind === 'attr_equals') {
        const defaultAttr = targetEl.hasAttribute?.('data-testid') ? 'data-testid' : '';
        const defaultVal = defaultAttr ? targetEl.getAttribute(defaultAttr) || '' : '';
        fields.innerHTML = `
          <div class="row">
            <div>
              <label>Attribute</label>
              <input data-attr type="text" placeholder="data-testid" />
            </div>
            <div>
              <label>Value</label>
              <input data-expected type="text" />
            </div>
          </div>
        `;
        fields.querySelector('[data-attr]').value = defaultAttr;
        fields.querySelector('[data-expected]').value = defaultVal;
        return;
      }
    }

    function readInputs() {
      const kind = kindSel.value;
      let expected = null;
      let attrName = null;
      if (kind === 'visible') {
        expected = true;
      } else if (kind === 'text_equals' || kind === 'text_contains') {
        expected = fields.querySelector('[data-expected]')?.value ?? '';
      } else if (kind === 'count') {
        const raw = fields.querySelector('[data-expected]')?.value ?? '';
        const n = Number.parseInt(raw, 10);
        expected = Number.isFinite(n) ? n : 0;
      } else if (kind === 'attr_equals') {
        attrName = fields.querySelector('[data-attr]')?.value.trim() || null;
        expected = fields.querySelector('[data-expected]')?.value ?? '';
      }
      return { kind, expected, attrName };
    }

    function save() {
      const { kind, expected, attrName } = readInputs();
      const actual = computeActual(kind, desc, targetEl, expected, attrName);
      const entry = {
        kind: 'assertion',
        ts: Date.now(),
        url: scrubUrl(location.href),
        target: desc,
        assertion_kind: kind,
        expected,
        attr_name: kind === 'attr_equals' ? attrName : null,
        actual,
      };
      closeOverlay();
      try { onAssertion(entry); } catch {}
    }

    function onPanelKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeOverlay();
        return;
      }
      if (e.key === 'Enter') {
        // Don't swallow Enter on the select dropdown itself — it might be open.
        if (e.target?.tagName === 'SELECT' && e.target.matches(':focus')) {
          // selects submit naturally; still proceed
        }
        e.preventDefault(); e.stopPropagation();
        save();
      }
    }

    kindSel.addEventListener('change', renderFields);
    saveBtn.addEventListener('click', (e) => { e.preventDefault(); save(); });
    cancelBtn.addEventListener('click', (e) => { e.preventDefault(); closeOverlay(); });
    panel.addEventListener('keydown', onPanelKey);

    document.body.appendChild(overlayHost);
    renderFields();
    positionPanel(panel, targetEl);

    // Focus something sensible — the first input, or the kind select.
    queueMicrotask(() => {
      const first = panel.querySelector('input, select');
      first?.focus();
      if (first?.select) { try { first.select(); } catch {} }
    });
  }

  function positionPanel(panel, targetEl) {
    let rect = null;
    try { rect = targetEl.getBoundingClientRect(); } catch {}
    const panelW = 300;
    const panelH = panel.offsetHeight || 180;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    let top, left;
    if (!rect) {
      top = margin;
      left = Math.max(margin, vw - panelW - margin);
    } else {
      const spaceAbove = rect.top;
      const spaceBelow = vh - rect.bottom;
      if (spaceAbove > 200 || spaceAbove > spaceBelow) {
        top = rect.top - panelH - margin;
      } else {
        top = rect.bottom + margin;
      }
      left = rect.left;
    }
    // Clamp to viewport.
    if (left + panelW > vw - margin) left = vw - panelW - margin;
    if (left < margin) left = margin;
    if (top + panelH > vh - margin) top = vh - panelH - margin;
    if (top < margin) top = margin;

    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function closeOverlay() {
    if (overlayHost) {
      try { overlayHost.remove(); } catch {}
      overlayHost = null;
    }
    try { delete window[FLAG]; } catch { window[FLAG] = false; }
  }

  // --- install ---------------------------------------------------------

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });

  return function uninstall() {
    if (uninstalled) return;
    uninstalled = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('mousemove', onMouseMove, true);
    closeOverlay();
  };
}
