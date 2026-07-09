// recap-export.js — pure functions that turn a session's raw activity stream
// into the two digest artifacts we ship in each bundle:
//   - pages.json  : structured landmark snapshots, deduped by canonical URL
//   - RECAP.md    : dense LLM-readable session summary
//
// No chrome.*, no DOM, no fs. Safe for MV3 service worker context.
// The RECAP.md format is a product contract — downstream LLMs parse it; see
// `.agent-notes/07-recap.md` for the schema spec.

const NAV_CANONICAL_STRIP_QS = /^(utm_.*|fbclid|gclid|ref|mc_cid|mc_eid|_ga|_gl)$/i;
const SCREENSHOT_MATCH_WINDOW_MS = 2000;
const MAX_VALUE_REPR = 80;

// Canonicalize a URL for dedup: strip hash + tracking params. Returns the
// raw input unchanged on parse failure so unusual URLs still compare stably.
export function canonicalUrl(u) {
  if (!u || typeof u !== 'string') return u || '';
  try {
    const url = new URL(u);
    url.hash = '';
    const params = url.searchParams;
    for (const key of Array.from(params.keys())) {
      if (NAV_CANONICAL_STRIP_QS.test(key)) params.delete(key);
    }
    return url.toString();
  } catch {
    return u;
  }
}

// Turn landmark_snapshot events + screenshot index into pages.json. Dedup is
// first-visit-wins: re-entering a page mid-session keeps the earlier snapshot
// and timestamp. Screenshot matching is nearest-t within SCREENSHOT_MATCH_WINDOW_MS.
export function buildPagesJson(landmarkSnapshots, screenshotsIndex) {
  const snapshots = Array.isArray(landmarkSnapshots) ? landmarkSnapshots : [];
  const shots = Array.isArray(screenshotsIndex) ? screenshotsIndex : [];
  const seen = new Map();
  const pages = [];
  let counter = 0;
  for (const snap of snapshots) {
    if (!snap || snap.kind !== 'landmark_snapshot') continue;
    const url = snap.url || '';
    const canon = canonicalUrl(url);
    if (seen.has(canon)) continue;
    counter += 1;
    const id = `p${counter}`;
    seen.set(canon, id);
    const firstVisitT = Number.isFinite(snap.t) ? snap.t : null;
    const screenshot = pickScreenshot(shots, firstVisitT ?? snap.ts);
    pages.push({
      id,
      url,
      title: snap.title || null,
      headings: Array.isArray(snap.headings) ? snap.headings : [],
      landmarks: Array.isArray(snap.landmarks) ? snap.landmarks : [],
      actions: Array.isArray(snap.actions) ? snap.actions : [],
      forms: Array.isArray(snap.forms) ? snap.forms : [],
      nav_items: Array.isArray(snap.nav_items) ? snap.nav_items : [],
      screenshot,
      first_visit_t: firstVisitT,
    });
  }
  return pages;
}

// Match the screenshot whose `t` is closest to targetT, within the 2s window.
// A landmark snapshot usually trails its triggering navigation by a few ms;
// bounding the search prevents us from pulling an unrelated periodic shot.
function pickScreenshot(shots, targetT) {
  if (!Number.isFinite(targetT)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const s of shots) {
    if (!s || typeof s.file !== 'string') continue;
    const d = Math.abs(Number(s.t) - targetT);
    if (!Number.isFinite(d)) continue;
    if (d < bestDelta) { best = s; bestDelta = d; }
  }
  if (!best || bestDelta > SCREENSHOT_MATCH_WINDOW_MS) return null;
  return best.file;
}

// ---- RECAP.md builder ------------------------------------------------------

export function buildRecapMd({ manifest, events, pages, tabTimeline } = {}) {
  const m = manifest || {};
  const evs = Array.isArray(events) ? events : [];
  const pgs = Array.isArray(pages) ? pages : [];
  const _tabs = Array.isArray(tabTimeline) ? tabTimeline : [];

  const lines = [];
  lines.push('# Session');
  lines.push('');
  lines.push(`label: ${m.label || '(unlabeled)'}`);
  lines.push(`description: ${m.description || '(none)'}`);
  lines.push(`start_url: ${m.start_url || ''}`);
  lines.push(`started_at: ${m.started_at || ''}`);
  lines.push(`format: ${m.format || ''}`);
  lines.push(`duration_ms_active: ${num(m.duration_ms)}`);
  lines.push(`duration_ms_waiting: ${num(m.total_waiting_ms ?? 0)}`);
  lines.push(`events: ${num(m.events_count)}`);
  lines.push(`pages: ${pgs.length}`);
  lines.push(`markers: ${countKind(evs, 'marker')}`);
  lines.push(`assertions: ${countKind(evs, 'assertion')}`);
  lines.push(`masked_inputs: ${countMasked(evs)}`);
  lines.push(`hosts: [${(m.hosts || []).join(', ')}]`);
  lines.push('');

  lines.push('## Pages');
  lines.push('');
  if (pgs.length === 0) {
    lines.push('(no pages)');
    lines.push('');
  } else {
    for (const p of pgs) {
      pushPage(lines, p);
    }
  }

  // Timeline ----------------------------------------------------------------
  lines.push('## Timeline');
  lines.push('');
  if (evs.length === 0) {
    lines.push('(no events)');
    lines.push('');
  } else {
    pushTimeline(lines, evs, m);
  }

  // Masked section ----------------------------------------------------------
  const maskedLines = buildMaskedSection(evs);
  if (maskedLines.length) {
    lines.push('## Masked');
    lines.push('');
    lines.push(...maskedLines);
    lines.push('');
  }

  // Notes + Markers indexes (omit if empty).
  const noteLines = buildNoteSection(evs);
  if (noteLines.length) {
    lines.push('## Notes');
    lines.push('');
    lines.push(...noteLines);
    lines.push('');
  }
  const markerLines = buildMarkerSection(evs);
  if (markerLines.length) {
    lines.push('## Markers');
    lines.push('');
    lines.push(...markerLines);
    lines.push('');
  }

  // Strip trailing blank lines for a tidy output.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

// ---- section builders ------------------------------------------------------

function pushPage(lines, p) {
  lines.push(`[${p.id}] ${p.url || ''} — "${escQ(p.title || '')}"`);
  const headings = (p.headings || [])
    .map((h) => (typeof h === 'string' ? h : h?.text))
    .filter(Boolean)
    .join(', ');
  lines.push(`  headings: ${headings || '(none)'}`);
  const landmarks = (p.landmarks || [])
    .map((l) => l?.role)
    .filter(Boolean)
    .join(', ');
  lines.push(`  landmarks: ${landmarks || '(none)'}`);
  const actions = (p.actions || []).map((a) => {
    const primary = a?.locators?.[0] || '';
    return `${a?.tag || '?'} "${escQ(a?.name || '')}" -> ${primary}`;
  }).join(', ');
  lines.push(`  actions: ${actions || '(none)'}`);
  const forms = (p.forms || []).map((f) => {
    const fields = (f?.fields || []).map((fd) => {
      const req = fd?.required ? ' (required)' : '';
      return `${fd?.type || 'text'}:${fd?.label || ''}${req}`;
    }).join(', ');
    return `"${escQ(f?.name || '')}" [${fields}]`;
  }).join(', ');
  lines.push(`  forms: ${forms || '(none)'}`);
  lines.push(`  screenshot: ${p.screenshot || 'none'}`);
  lines.push('');
}

function pushTimeline(lines, evs, manifest) {
  const startHost = hostOf(manifest.start_url || '');
  const processed = collapseInputs(evs);
  for (const ev of processed) {
    const line = renderEvent(ev, startHost);
    if (line) lines.push(line);
  }
  lines.push('');
}

// Walk events; collapse any run of input/change events on the same primary
// locator into a single synthetic `_fill` entry. Uses the final event's
// value, the first event's timestamp.
function collapseInputs(evs) {
  const out = [];
  let i = 0;
  while (i < evs.length) {
    const e = evs[i];
    if (!e) { i++; continue; }
    if (e.kind === 'input' || e.kind === 'change') {
      const startT = e.t;
      const loc = primaryLocator(e);
      const group = [e];
      let j = i + 1;
      while (j < evs.length) {
        const n = evs[j];
        if (!n) break;
        if (n.kind !== 'input' && n.kind !== 'change') break;
        if (primaryLocator(n) !== loc) break;
        group.push(n);
        j++;
      }
      // Winning value: a `change` trumps any `input`; otherwise the last event.
      let winner = group[group.length - 1];
      const change = group.findLast?.((g) => g.kind === 'change');
      if (change) winner = change;
      out.push({
        _synthetic: 'fill',
        t: startT,
        locator: loc,
        value: winner.value,
        is_masked: group.some((g) => g.is_masked === true),
        value_length: winner.value_length ?? (typeof winner.value === 'string' ? winner.value.length : 0),
        mask_reason: winner.mask_reason || null,
      });
      i = j;
      continue;
    }
    out.push(e);
    i++;
  }
  return out;
}

function renderEvent(ev, startHost) {
  const ts = fmtTS(ev.t);
  if (ev._synthetic === 'fill') {
    return renderFill(ts, ev);
  }
  const k = ev.kind;

  if (k === 'focus' || k === 'scroll' || k === 'submit' || k === 'waiting_start' || k === 'landmark_snapshot' || k === 'screenshot') return null;

  if (k === 'idle') {
    const d = Number(ev.duration_ms || 0);
    if (d < 2000) return null;
    return `${ts} idle ${fmtDurationS(d)}s`;
  }

  if (k === 'pause') return `${ts} pause`;
  if (k === 'resume') {
    const ms = Number(ev.paused_ms || 0);
    return `${ts} resume (${fmtDurationS(ms)}s paused)`;
  }
  if (k === 'timeout') return `${ts} timeout (session cap)`;

  if (k === 'navigation') {
    return `${ts} ${renderNav(ev, startHost)}`;
  }

  if (k === 'click' || k === 'dblclick') {
    const loc = primaryLocator(ev) || '(no locator)';
    return `${ts} ${k === 'dblclick' ? 'dblclick' : 'click'} ${loc}`;
  }

  if (k === 'key') {
    const loc = primaryLocator(ev);
    const key = ev.key || '';
    if (!key) return null;
    return loc ? `${ts} press ${key} ${loc}` : `${ts} press ${key}`;
  }

  if (k === 'marker') {
    return `${ts} marker "${escQ(ev.label || '')}"`;
  }

  if (k === 'note') {
    return `${ts} note "${escQ(ev.text || '')}"`;
  }

  if (k === 'tab_switch') {
    return `${ts} tab_switch -> ${ev.toUrl || ''}`;
  }

  if (k === 'waiting_end') {
    const d = Number(ev.duration_ms || 0);
    const reasons = Array.isArray(ev.reasons) ? ev.reasons.join('+') : (ev.reason || '');
    return `${ts} waiting ${fmtDurationS(d)}s (reasons: ${reasons || 'unknown'})`;
  }

  if (k === 'assertion') {
    const loc = primaryLocator(ev) || '(no locator)';
    const akind = ev.assertion_kind || 'unknown';
    const expected = ev.expected;
    if (expected === undefined || expected === null || expected === '') {
      return `${ts} assert ${akind} ${loc}`;
    }
    return `${ts} assert ${akind} ${loc} = ${quoteValue(expected)}`;
  }

  if (k === 'network') {
    const status = Number(ev.status || 0);
    // Only surface errors; successful requests are too noisy for the digest.
    if (status < 400) return null;
    const method = ev.method || 'GET';
    const path = ev.url_path || pathOf(ev.url || '') || ev.url || '';
    return `${ts} net ${status} ${method} ${path}`;
  }

  if (k === 'console') {
    if (ev.level !== 'error') return null;
    const msg = Array.isArray(ev.args) ? ev.args.join(' ') : (ev.message || '');
    return `${ts} console ERROR ${escLine(trimStr(msg, 120))}`;
  }

  return null;
}

function renderFill(ts, ev) {
  const loc = ev.locator || '(no locator)';
  if (ev.is_masked) {
    const n = Number(ev.value_length || 0);
    return `${ts} fill ${loc} = <MASKED length=${n}>`;
  }
  const raw = typeof ev.value === 'string' ? ev.value : '';
  if (raw.length === 0) {
    return `${ts} fill ${loc} = ""`;
  }
  if (raw.length <= 40) {
    return `${ts} fill ${loc} = ${quoteValue(raw)}`;
  }
  return `${ts} fill ${loc} = <${raw.length} chars>`;
}

function renderNav(ev, startHost) {
  const fromRaw = ev.from || '';
  const toRaw = ev.to || ev.url || '';
  const fromHost = hostOf(fromRaw);
  const toHost = hostOf(toRaw);
  const sameHostAsStart = (u) => hostOf(u) === startHost && startHost;
  const fromStr = fromRaw ? (sameHostAsStart(fromRaw) ? pathOf(fromRaw) : fromRaw) : '(start)';
  const toStr = toRaw ? (sameHostAsStart(toRaw) ? pathOf(toRaw) : toRaw) : '';
  // Cross-host transitions always show the full URL on both sides so the
  // reader doesn't have to infer the origin change.
  if (fromHost && toHost && fromHost !== toHost) {
    return `nav ${fromRaw} -> ${toRaw}`;
  }
  return `nav ${fromStr} -> ${toStr}`;
}

function buildMaskedSection(evs) {
  const out = [];
  for (const ev of evs) {
    if (!ev) continue;
    if (ev.is_masked !== true) continue;
    if (ev.kind !== 'input' && ev.kind !== 'change') continue;
    const ts = fmtTS(ev.t);
    const loc = primaryLocator(ev) || '(no locator)';
    const n = Number(ev.value_length || 0);
    const reason = ev.mask_reason || 'heuristic';
    out.push(`${ts} ${loc} length=${n} reason=${reason}`);
  }
  return out;
}

function buildNoteSection(evs) {
  const out = [];
  for (const ev of evs) {
    if (!ev || ev.kind !== 'note') continue;
    const ts = fmtTS(ev.t);
    out.push(`${ts} "${escQ(ev.text || '')}"`);
  }
  return out;
}

function buildMarkerSection(evs) {
  const out = [];
  for (const ev of evs) {
    if (!ev || ev.kind !== 'marker') continue;
    const ts = fmtTS(ev.t);
    out.push(`${ts} "${escQ(ev.label || '')}"`);
  }
  return out;
}

// ---- formatting helpers ----------------------------------------------------

function fmtTS(tMs) {
  const t = Math.max(0, Math.floor(Number(tMs || 0) / 1000));
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function fmtDurationS(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 100) / 10);
  // Trim trailing ".0" for a cleaner read: 3s rather than 3.0s.
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

function primaryLocator(ev) {
  const locs = ev?.target?.locators;
  if (Array.isArray(locs) && locs.length) return locs[0];
  const css = ev?.target?.css;
  return css ? `locator(${JSON.stringify(css)})` : null;
}

function countKind(evs, kind) {
  let n = 0;
  for (const e of evs) if (e && e.kind === kind) n++;
  return n;
}

function countMasked(evs) {
  let n = 0;
  for (const e of evs) if (e && e.is_masked === true) n++;
  return n;
}

function hostOf(u) {
  if (!u) return '';
  try { return new URL(u).host; } catch { return ''; }
}

function pathOf(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    return url.pathname + (url.search || '');
  } catch { return ''; }
}

// Truncate + quote an arbitrary value for timeline display. Strings longer
// than MAX_VALUE_REPR get an ellipsis; all values are escaped single-line.
function quoteValue(v) {
  const s = String(v);
  const truncated = s.length > MAX_VALUE_REPR ? s.slice(0, MAX_VALUE_REPR) + '...' : s;
  return `"${escQ(truncated)}"`;
}

function trimStr(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '...' : str;
}

// Escape for use inside double-quoted timeline values. Newlines collapse to
// a single ↵ character so each event stays on one line.
function escQ(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '↵');
}

// Escape a non-quoted message body (console line, etc.) — we still want
// single-line output but don't need quote escaping.
function escLine(s) {
  return String(s || '').replace(/\r?\n/g, '↵');
}

function num(n) {
  return Number.isFinite(n) ? n : 0;
}
