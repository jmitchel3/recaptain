// Screenshot redaction. Split into two halves:
//
//   - collectRedactRects (page-side): walks the DOM, returns CSS-pixel rects
//     for every element that should be hidden in a screenshot. Runs before
//     each captureVisibleTab; needs to be cheap.
//   - applyRedactionToBitmap (SW-side): takes an ImageBitmap + rects and
//     returns an OffscreenCanvas with the rects painted over (solid fill or
//     blur). The caller encodes the result.
//
// Kept self-contained so either half can be imported without pulling the
// other's environment (content script has DOM; SW has OffscreenCanvas).

import { REDACT_SELECTOR, shouldMaskField } from './privacy.js';

// --- content-script-side ------------------------------------------------

// Walk the DOM and return CSS-pixel rects for every element that should be
// obscured in the next screenshot. Only elements intersecting the viewport
// are included; anything offscreen is the SW's problem to clip anyway and
// we'd be wasting bytes shipping rects for it.
//
// `reason` is a short human-readable tag ('data-private', 'fs-mask',
// 'password', 'heuristic') so the bundle can document *why* each rect
// was redacted rather than just claiming "something was here."
export function collectRedactRects() {
  if (typeof document === 'undefined') return [];
  const rects = [];
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!vw || !vh) return [];

  const seen = new WeakSet();

  const push = (el, reason) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect?.();
    if (!r) return;
    // Clip to viewport, bail on zero-area.
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const right = Math.min(vw, r.right);
    const bottom = Math.min(vh, r.bottom);
    const w = right - x;
    const h = bottom - y;
    if (w <= 0 || h <= 0) return;
    rects.push({
      x: Math.floor(x),
      y: Math.floor(y),
      w: Math.ceil(w),
      h: Math.ceil(h),
      reason,
    });
  };

  // Pass 1: every element matching any opt-out convention.
  let flagged;
  try {
    flagged = document.querySelectorAll(REDACT_SELECTOR);
  } catch {
    flagged = [];
  }
  for (const el of flagged) {
    push(el, reasonForElement(el));
  }

  // Pass 2: sensitive form fields. shouldMaskField already covers
  // heuristics (input[type=password], autocomplete=cc-number, sensitive
  // name/id/label) so we don't have to reimplement them here.
  const fields = document.querySelectorAll('input, textarea, select');
  for (const el of fields) {
    if (seen.has(el)) continue;
    if (shouldMaskField(el)) push(el, fieldReason(el));
  }

  return rects;
}

// Derive a short reason label from whichever selector tagged the element.
// Cheap: only runs once per flagged element.
function reasonForElement(el) {
  if (el.hasAttribute?.('data-recaptain-mask') || el.classList?.contains?.('recaptain-mask')) return 'recaptain-mask';
  if (el.hasAttribute?.('data-sensitive')) return 'data-sensitive';
  if (el.hasAttribute?.('data-private') || el.classList?.contains?.('private')) return 'data-private';
  if (el.hasAttribute?.('data-fs-mask') || el.classList?.contains?.('fs-mask')) return 'fs-mask';
  if (el.hasAttribute?.('data-fs-exclude') || el.classList?.contains?.('fs-exclude')) return 'fs-exclude';
  if (el.hasAttribute?.('data-fs-hide') || el.classList?.contains?.('fs-hide')) return 'fs-hide';
  if (el.hasAttribute?.('ph-no-capture') || el.classList?.contains?.('ph-no-capture')) return 'ph-no-capture';
  if (el.hasAttribute?.('data-hj-suppress')) return 'data-hj-suppress';
  if (el.hasAttribute?.('data-heap-redact-text')) return 'data-heap-redact-text';
  if (el.hasAttribute?.('data-mp-mask') || el.classList?.contains?.('mp-mask')) return 'mp-mask';
  if (el.classList?.contains?.('amp-block')) return 'amp-block';
  if (el.classList?.contains?.('amp-mask')) return 'amp-mask';
  return 'redact-selector';
}

function fieldReason(el) {
  const type = (el.type || '').toLowerCase();
  if (type === 'password') return 'password';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'tel';
  return 'heuristic';
}

// --- service-worker-side ------------------------------------------------

// Paint `rects` over `imageBitmap` and return the resulting OffscreenCanvas.
// The caller is responsible for encoding (convertToBlob); we return the
// canvas so the caller can chain multiple passes (thumbnail, JPEG) without
// re-decoding.
//
// `rects` are in CSS pixels; the canvas is in device pixels. Scale by
// `devicePixelRatio` before drawing. For `blur` mode we re-draw the source
// bitmap through a blur filter clipped to the rect, which gives a cheap
// per-rect blur without blurring the whole image.
export function applyRedactionToBitmap(imageBitmap, rects, opts = {}) {
  const mode = opts.mode === 'blur' ? 'blur' : 'black';
  const dpr = Number(opts.devicePixelRatio) > 0 ? Number(opts.devicePixelRatio) : 1;

  // Empty-rect fast path: allocate nothing, hand back the bitmap wrapped in
  // a canvas so the caller's pipeline stays uniform.
  if (!rects || rects.length === 0) {
    const c = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    c.getContext('2d').drawImage(imageBitmap, 0, 0);
    return c;
  }

  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, 0, 0);

  if (mode === 'black') {
    ctx.fillStyle = '#000';
    for (const r of rects) {
      const x = Math.round(r.x * dpr);
      const y = Math.round(r.y * dpr);
      const w = Math.round(r.w * dpr);
      const h = Math.round(r.h * dpr);
      if (w <= 0 || h <= 0) continue;
      ctx.fillRect(x, y, w, h);
    }
    return canvas;
  }

  // Blur mode: clip to each rect and redraw the source with a blur filter.
  // The filter only applies to the drawImage inside the clip, so we don't
  // disturb the rest of the canvas. Save/restore around each rect because
  // clip() is sticky.
  for (const r of rects) {
    const x = Math.round(r.x * dpr);
    const y = Math.round(r.y * dpr);
    const w = Math.round(r.w * dpr);
    const h = Math.round(r.h * dpr);
    if (w <= 0 || h <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = 'blur(14px)';
    ctx.drawImage(imageBitmap, 0, 0);
    ctx.restore();
  }
  return canvas;
}
