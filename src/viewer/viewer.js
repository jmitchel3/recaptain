/* viewer.js: self-contained bundle viewer.
 *
 * Runs as a classic script (not a module) so it works from file:// in Chrome.
 * Reads bundle data from inline <script type="application/json"> tags whose
 * contents are substituted at bundle-assembly time (see viewer.html header).
 *
 * No dependencies. No network. No build step.
 */
(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────
  // Data loading: inline JSON with sensible fallbacks when sentinels
  // haven't been replaced yet (e.g. running this file standalone from src/).
  // ───────────────────────────────────────────────────────────────────────
  function loadInline(id, fallback) {
    const node = document.getElementById(id);
    if (!node) return fallback;
    const raw = (node.textContent || '').trim();
    if (!raw) return fallback;
    // Sentinel still in place (e.g. "__MANIFEST_JSON__"). Treat as unset.
    if (/^__[A-Z_]+__$/.test(raw)) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error('[viewer] failed to parse', id, err);
      return fallback;
    }
  }

  const manifest = loadInline('manifest-data', null);
  const events = loadInline('events-data', []);
  const consoleEntries = loadInline('console-data', []);
  const tabsTimeline = loadInline('tabs-data', []);
  const shotsIndex = loadInline('shots-data', []);

  // Build lookup: which event time owns which screenshot (for focus pane).
  const shotByT = new Map();
  for (const s of shotsIndex) {
    if (s && typeof s.t === 'number') shotByT.set(s.t, s);
  }

  // Assign a stable id to every event so selection survives re-render.
  events.forEach((e, i) => { if (e && e._vid == null) e._vid = i; });

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────
  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtRelTime(ms) {
    ms = Math.max(0, Math.floor(ms || 0));
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    const frac = String(Math.floor((ms % 1000) / 100));
    return `${m}:${s}.${frac}`;
  }

  function fmtDurationMs(ms) {
    if (ms == null) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }

  function fmtBytes(n) {
    if (n == null) return '-';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }

  function fmtISO(iso) {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  function targetLabel(t) {
    if (!t) return 'unknown';
    if (t.accessible_name) return `${t.role || t.tag || '?'} "${t.accessible_name}"`;
    if (t.test_id) return `[data-testid="${t.test_id}"]`;
    if (t.label) return `${t.role || t.tag || '?'} "${t.label}"`;
    if (t.text) return `${t.tag || '?'} "${t.text}"`;
    if (t.placeholder) return `${t.tag || '?'} (placeholder "${t.placeholder}")`;
    if (t.id) return `${t.tag || '?'}#${t.id}`;
    if (t.name) return `${t.tag || '?'}[name="${t.name}"]`;
    return t.tag || 'element';
  }

  function summaryHTML(e) {
    switch (e.kind) {
      case 'click':
      case 'dblclick':
      case 'focus':
        return `<span>${escapeHTML(targetLabel(e.target))}</span>`;
      case 'input':
      case 'change': {
        const label = targetLabel(e.target);
        const val = e.is_masked
          ? `<span class="masked">masked (${e.value_length ?? '?'}ch)</span>`
          : `<span class="muted">= </span>"${escapeHTML(String(e.value ?? '').slice(0, 80))}"`;
        return `<span>${escapeHTML(label)}</span> ${val}`;
      }
      case 'submit':
        return `<span>${escapeHTML(targetLabel(e.target) || 'form')} submitted</span>`;
      case 'key': {
        const mods = e.modifiers?.length ? e.modifiers.join('+') + '+' : '';
        return `<span class="muted">${escapeHTML(mods)}</span>${escapeHTML(e.key || '')}`;
      }
      case 'scroll':
        return `<span class="muted">to (${e.x ?? 0}, ${e.y ?? 0})</span>`;
      case 'navigation':
        return `<span class="muted">&rarr;</span> ${escapeHTML(e.to || '')}`;
      case 'tab_switch':
        return `<span class="muted">tab &rarr;</span> ${escapeHTML(e.toUrl || '')}`;
      case 'console': {
        const args = (e.args || []).join(' ');
        return `<span class="muted">[${escapeHTML(e.level || 'log')}]</span> ${escapeHTML(args.slice(0, 240))}`;
      }
      case 'screenshot':
        return `<span class="muted">screenshot &middot; ${escapeHTML(e.reason || '')}</span>`;
      case 'marker':
        return `<span>&#9654; ${escapeHTML(e.label || 'step')}</span>`;
      case 'note':
        return `<span>${escapeHTML(String(e.text || '').slice(0, 240))}</span>`;
      case 'idle':
        return `<span class="muted">idle ${Math.round((e.duration_ms || 0) / 100) / 10}s</span>`;
      case 'pause':
        return `<span class="muted">paused</span>`;
      case 'resume':
        return `<span class="muted">resumed &middot; paused ${Math.round((e.paused_ms || 0) / 1000)}s</span>`;
      case 'timeout':
        return `<span>time limit reached &middot; ${Math.round((e.limit_ms || 0) / 60000)}min cap</span>`;
      case 'network':
        return `<span class="muted">${escapeHTML(e.method || 'GET')}</span> ${escapeHTML(e.url || '')}`;
      default:
        return `<span class="muted">${escapeHTML(e.kind || 'event')}</span>`;
    }
  }

  function badgeFor(e) {
    if (e.kind === 'console') {
      const sub = e.level || 'log';
      return `<span class="badge console ${escapeHTML(sub)}">${escapeHTML(sub)}</span>`;
    }
    return `<span class="badge ${escapeHTML(e.kind || '')}">${escapeHTML(e.kind || '')}</span>`;
  }

  // Pretty-print JSON with a tiny colorizer. Dependencies-free.
  // Work on the raw JSON (before HTML-escaping) so "..." string boundaries are
  // easy to recognize. Escape each captured token's content after matching.
  function colorJSON(obj) {
    const str = JSON.stringify(obj, null, 2);
    // Match strings (with escaped chars), numbers, booleans, null. Strings may
    // be followed by ": " which marks them as keys.
    return str.replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (m, s, colon, lit) => {
        if (s) {
          const esc = escapeHTML(s);
          return colon
            ? `<span class="j-key">${esc}</span>${colon}`
            : `<span class="j-str">${esc}</span>`;
        }
        if (lit === 'true' || lit === 'false') return `<span class="j-bool">${lit}</span>`;
        if (lit === 'null') return `<span class="j-null">null</span>`;
        return `<span class="j-num">${escapeHTML(m)}</span>`;
      },
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Header
  // ───────────────────────────────────────────────────────────────────────
  function renderHeader() {
    const labelEl = document.getElementById('bundle-label');
    const descEl = document.getElementById('bundle-description');
    const metaEl = document.getElementById('bundle-meta');
    const hostsEl = document.getElementById('bundle-hosts');

    if (!manifest) {
      labelEl.textContent = 'Recording (no manifest)';
      descEl.textContent = 'manifest.json was not found or not injected. Viewer is running with empty data.';
      metaEl.innerHTML = '';
      hostsEl.innerHTML = '';
      document.title = 'Recaptain Recording';
      return;
    }

    const label = manifest.label || '(unlabeled recording)';
    labelEl.textContent = label;
    descEl.textContent = manifest.description || '';
    if (!manifest.description) descEl.style.display = 'none';

    const metaRows = [
      ['format', manifest.format || '-'],
      ['started', fmtISO(manifest.started_at)],
      ['ended', fmtISO(manifest.ended_at)],
      ['duration', fmtDurationMs(manifest.duration_ms)],
      ['events', String(manifest.events_count ?? events.length)],
      ['shots', String(manifest.screenshots_count ?? shotsIndex.length)],
    ];
    metaEl.innerHTML = metaRows.map(([k, v]) =>
      `<span class="meta-row"><span class="meta-key">${escapeHTML(k)}: </span><span class="meta-val">${escapeHTML(v)}</span></span>`,
    ).join('');

    const hosts = Array.isArray(manifest.hosts) ? manifest.hosts : [];
    hostsEl.innerHTML = hosts.length
      ? hosts.map((h) => `<span class="chip">${escapeHTML(h)}</span>`).join('')
      : '<span class="muted">no hosts recorded</span>';

    document.title = `${label} - Recaptain Recording`;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Tabs
  // ───────────────────────────────────────────────────────────────────────
  const tabButtons = Array.from(document.querySelectorAll('.tab'));
  const panes = {
    activity: document.getElementById('pane-activity'),
    console: document.getElementById('pane-console'),
    network: document.getElementById('pane-network'),
    screenshots: document.getElementById('pane-screenshots'),
    tabs: document.getElementById('pane-tabs'),
    manifest: document.getElementById('pane-manifest'),
  };
  function switchTab(name) {
    for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === name);
    for (const key of Object.keys(panes)) panes[key].classList.toggle('active', key === name);
  }
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // ───────────────────────────────────────────────────────────────────────
  // Activity feed
  // ───────────────────────────────────────────────────────────────────────
  const feedEl = document.getElementById('feed');
  const feedEmpty = document.getElementById('feed-empty');
  const feedCount = document.getElementById('feed-count');
  const filterText = document.getElementById('filter-text');
  const filterType = document.getElementById('filter-type');
  const onlyInteractions = document.getElementById('only-interactions');
  const focusCol = document.getElementById('focus-col');

  const INTERACTION_KINDS = new Set([
    'click', 'dblclick', 'input', 'change', 'submit', 'key', 'navigation', 'tab_switch', 'marker', 'note',
  ]);

  const state = {
    selectedVid: null,
    expanded: new Set(),
    filtered: [],
  };

  function populateKindDropdown() {
    const kinds = new Set(events.map((e) => e?.kind).filter(Boolean));
    const sorted = Array.from(kinds).sort();
    // Keep 'all' option, append actual kinds.
    for (const k of sorted) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      filterType.appendChild(opt);
    }
  }

  function matchesFilter(e) {
    if (!e) return false;
    if (onlyInteractions.checked && !INTERACTION_KINDS.has(e.kind)) return false;
    const typeVal = filterType.value;
    if (typeVal && e.kind !== typeVal) return false;
    const q = filterText.value.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      e.kind,
      e.target?.accessible_name, e.target?.label, e.target?.text, e.target?.test_id,
      e.target?.id, e.target?.name, e.target?.css,
      e.value,
      e.to, e.toUrl, e.url,
      e.reason,
      e.key,
      (e.args || []).join(' '),
      e.level,
      e.label,
      e.text,
      e.method,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function eventShotPath(e) {
    // Explicit screenshot event: look up via t.
    if (e.kind === 'screenshot') {
      const s = shotByT.get(e.t);
      return s ? s.file : null;
    }
    // Some events may embed screenshot_id / shot_file; be lenient.
    if (e.screenshot_id && typeof e.screenshot_id === 'string') return e.screenshot_id;
    if (e.shot_file) return e.shot_file;
    return null;
  }

  function renderRow(e) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.vid = e._vid;
    if (state.selectedVid === e._vid) li.classList.add('selected');
    const expanded = state.expanded.has(e._vid);
    if (expanded) li.classList.add('expanded');

    const shot = eventShotPath(e);
    let thumbHTML = '';
    if (expanded && shot) {
      thumbHTML = `<div class="row-thumb"><img src="${escapeHTML(shot)}" alt="screenshot" loading="lazy"></div>`;
    }
    let detailsHTML = '';
    if (expanded) {
      const copy = { ...e };
      delete copy._vid;
      detailsHTML = `<pre class="row-details">${escapeHTML(JSON.stringify(copy, null, 2))}</pre>`;
    }

    li.innerHTML = `
      <span class="time">${fmtRelTime(e.t ?? 0)}</span>
      ${badgeFor(e)}
      <span class="summary">${summaryHTML(e)}</span>
      ${thumbHTML}
      ${detailsHTML}
    `;

    li.addEventListener('click', (ev) => {
      if (ev.target.closest('.row-thumb img')) {
        openLightbox(shot);
        return;
      }
      selectAndToggle(e._vid);
    });
    return li;
  }

  function renderFeed() {
    state.filtered = events.filter(matchesFilter);
    feedCount.textContent = `${state.filtered.length} / ${events.length}`;
    feedEmpty.classList.toggle('hidden', state.filtered.length > 0);

    const frag = document.createDocumentFragment();
    // Render last 2000 to stay snappy on huge bundles.
    const slice = state.filtered.slice(-2000);
    for (const e of slice) frag.appendChild(renderRow(e));
    feedEl.replaceChildren(frag);
  }

  function selectAndToggle(vid) {
    if (state.selectedVid === vid) {
      // Same row clicked again: toggle expand.
      if (state.expanded.has(vid)) state.expanded.delete(vid);
      else state.expanded.add(vid);
    } else {
      state.selectedVid = vid;
    }
    renderFeed();
    renderFocus();
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    const node = feedEl.querySelector(`.row[data-vid="${state.selectedVid}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function currentEvent() {
    if (state.selectedVid == null) return null;
    return events.find((e) => e._vid === state.selectedVid) || null;
  }

  function renderFocus() {
    const e = currentEvent();
    if (!e) {
      focusCol.innerHTML = '<div class="focus-empty muted">Select an event to see its details.</div>';
      return;
    }
    const shot = eventShotPath(e);
    const shotBlock = shot
      ? `<div class="focus-shot"><img src="${escapeHTML(shot)}" alt="screenshot"></div>`
      : '';

    let extraBlocks = '';
    if (e.kind === 'network') {
      extraBlocks = `
        <div class="focus-section">
          <h3>Request / Response</h3>
          <div class="kv">
            <div class="kv-row"><span class="k">method</span><span>${escapeHTML(e.method || '-')}</span></div>
            <div class="kv-row"><span class="k">url</span><span>${escapeHTML(e.url || '-')}</span></div>
            <div class="kv-row"><span class="k">status</span><span>${escapeHTML(String(e.status ?? '-'))}</span></div>
            <div class="kv-row"><span class="k">duration</span><span>${escapeHTML(fmtDurationMs(e.duration_ms))}</span></div>
            <div class="kv-row"><span class="k">size</span><span>${escapeHTML(fmtBytes(e.size ?? e.response_size))}</span></div>
          </div>
        </div>`;
    }

    const copy = { ...e };
    delete copy._vid;
    focusCol.innerHTML = `
      <div class="focus-head">
        <span class="time">${fmtRelTime(e.t ?? 0)}</span>
        ${badgeFor(e)}
        <h2>${escapeHTML(e.kind || 'event')}</h2>
      </div>
      <div class="focus-summary">${summaryHTML(e)}</div>
      ${shotBlock}
      ${extraBlocks}
      <div class="focus-section">
        <h3>Raw event</h3>
        <pre class="json">${colorJSON(copy)}</pre>
      </div>
    `;
    const img = focusCol.querySelector('.focus-shot img');
    if (img) img.addEventListener('click', () => openLightbox(shot));
  }

  // Keyboard: j/k/Enter/slash
  document.addEventListener('keydown', (ev) => {
    // Don't hijack keys while typing in an input.
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    const inEditable = tag === 'input' || tag === 'textarea' || tag === 'select';

    if (ev.key === '/' && !inEditable) {
      ev.preventDefault();
      filterText.focus();
      filterText.select();
      return;
    }
    if (inEditable) return;

    if (panes.activity.classList.contains('active')) {
      if (ev.key === 'j') { ev.preventDefault(); moveSelection(1); }
      else if (ev.key === 'k') { ev.preventDefault(); moveSelection(-1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (state.selectedVid != null) {
          if (state.expanded.has(state.selectedVid)) state.expanded.delete(state.selectedVid);
          else state.expanded.add(state.selectedVid);
          renderFeed();
          scrollSelectedIntoView();
        }
      }
    }

    if (ev.key === 'Escape') closeLightbox();
  });

  function moveSelection(delta) {
    if (state.filtered.length === 0) return;
    const idx = state.filtered.findIndex((e) => e._vid === state.selectedVid);
    let next;
    if (idx === -1) next = delta > 0 ? 0 : state.filtered.length - 1;
    else next = Math.max(0, Math.min(state.filtered.length - 1, idx + delta));
    state.selectedVid = state.filtered[next]._vid;
    renderFeed();
    renderFocus();
    scrollSelectedIntoView();
  }

  filterText.addEventListener('input', () => { renderFeed(); });
  filterType.addEventListener('change', () => { renderFeed(); });
  onlyInteractions.addEventListener('change', () => { renderFeed(); });

  // ───────────────────────────────────────────────────────────────────────
  // Console panel
  // ───────────────────────────────────────────────────────────────────────
  const consoleList = document.getElementById('console-list');
  const consoleFilter = document.getElementById('console-filter');
  const consoleLevel = document.getElementById('console-level');
  const consoleCount = document.getElementById('console-count');

  function renderConsole() {
    const q = consoleFilter.value.trim().toLowerCase();
    const lvl = consoleLevel.value;
    const filtered = consoleEntries.filter((c) => {
      if (lvl && c.level !== lvl) return false;
      if (!q) return true;
      const hay = [(c.args || []).join(' '), c.level, c.url].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    consoleCount.textContent = `${filtered.length} / ${consoleEntries.length} entries`;
    const frag = document.createDocumentFragment();
    for (const c of filtered.slice(-5000)) {
      const li = document.createElement('li');
      li.className = `console-item level-${escapeHTML(c.level || 'log')}`;
      const msg = (c.args || []).map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      li.innerHTML = `
        <span class="time">${fmtRelTime(c.t ?? 0)}</span>
        <span class="badge console ${escapeHTML(c.level || 'log')}">${escapeHTML(c.level || 'log')}</span>
        <span class="msg">${escapeHTML(msg)}</span>
      `;
      frag.appendChild(li);
    }
    consoleList.replaceChildren(frag);
  }
  consoleFilter.addEventListener('input', renderConsole);
  consoleLevel.addEventListener('change', renderConsole);

  // ───────────────────────────────────────────────────────────────────────
  // Network panel
  // ───────────────────────────────────────────────────────────────────────
  const networkBody = document.getElementById('network-body');
  const networkFilter = document.getElementById('network-filter');
  const networkCount = document.getElementById('network-count');
  const networkTable = document.getElementById('network-table');
  const networkEmpty = document.getElementById('network-empty');

  const networkEvents = events.filter((e) => e && e.kind === 'network');

  function renderNetwork() {
    if (networkEvents.length === 0) {
      networkTable.style.display = 'none';
      networkEmpty.style.display = 'block';
      networkCount.textContent = '0 requests';
      return;
    }
    networkTable.style.display = '';
    networkEmpty.style.display = 'none';
    const q = networkFilter.value.trim().toLowerCase();
    const filtered = networkEvents.filter((n) => {
      if (!q) return true;
      return [n.url, n.method, String(n.status || '')].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    networkCount.textContent = `${filtered.length} / ${networkEvents.length} requests`;
    const frag = document.createDocumentFragment();
    for (const n of filtered) {
      const tr = document.createElement('tr');
      const status = Number(n.status || 0);
      if (status >= 400 && status < 600) tr.classList.add('err');
      tr.innerHTML = `
        <td class="col-time">${fmtRelTime(n.t ?? 0)}</td>
        <td class="col-method">${escapeHTML(n.method || 'GET')}</td>
        <td class="col-url" title="${escapeHTML(n.url || '')}">${escapeHTML(n.url || '')}</td>
        <td class="col-status">${escapeHTML(String(n.status ?? '-'))}</td>
        <td class="col-duration">${escapeHTML(fmtDurationMs(n.duration_ms))}</td>
        <td class="col-size">${escapeHTML(fmtBytes(n.size ?? n.response_size))}</td>
      `;
      tr.addEventListener('click', () => {
        state.selectedVid = n._vid;
        switchTab('activity');
        renderFeed();
        renderFocus();
        scrollSelectedIntoView();
      });
      frag.appendChild(tr);
    }
    networkBody.replaceChildren(frag);
  }
  networkFilter.addEventListener('input', renderNetwork);

  // ───────────────────────────────────────────────────────────────────────
  // Screenshots grid
  // ───────────────────────────────────────────────────────────────────────
  const shotsGrid = document.getElementById('shots-grid');
  const shotsCount = document.getElementById('shots-count');

  function renderShots() {
    shotsCount.textContent = `${shotsIndex.length} screenshot${shotsIndex.length === 1 ? '' : 's'}`;
    const frag = document.createDocumentFragment();
    for (const s of shotsIndex) {
      const card = document.createElement('div');
      card.className = 'shot-card';
      card.innerHTML = `
        <img src="${escapeHTML(s.file)}" alt="screenshot" loading="lazy">
        <div class="shot-meta">
          <span class="shot-t">${fmtRelTime(s.t ?? 0)}</span>
          <span class="muted" title="${escapeHTML(s.reason || '')}">${escapeHTML(s.reason || '')}</span>
        </div>
      `;
      card.addEventListener('click', () => openLightbox(s.file));
      frag.appendChild(card);
    }
    shotsGrid.replaceChildren(frag);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Tabs timeline (gantt-style bars)
  // ───────────────────────────────────────────────────────────────────────
  function renderTabsTimeline() {
    const container = document.getElementById('tabs-timeline');
    const tabsCountEl = document.getElementById('tabs-count');
    tabsCountEl.textContent = `${tabsTimeline.length} tab${tabsTimeline.length === 1 ? '' : 's'}`;

    if (tabsTimeline.length === 0) {
      container.innerHTML = '<div class="empty-inline muted">No tab timeline recorded.</div>';
      return;
    }
    // Compute time axis in epoch ms.
    const startedAt = manifest?.started_at ? new Date(manifest.started_at).getTime() : null;
    const endedAt = manifest?.ended_at ? new Date(manifest.ended_at).getTime() : null;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const row of tabsTimeline) {
      if (row.entered_at != null) t0 = Math.min(t0, row.entered_at);
      if (row.left_at != null) t1 = Math.max(t1, row.left_at);
    }
    if (startedAt != null) t0 = Math.min(t0, startedAt);
    if (endedAt != null) t1 = Math.max(t1, endedAt);
    if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) {
      container.innerHTML = '<div class="empty-inline muted">Tab timeline timestamps are missing or degenerate.</div>';
      return;
    }
    const span = t1 - t0;

    // Group by tab_id so each tab gets its own row (can have multiple bars).
    const byTab = new Map();
    for (const row of tabsTimeline) {
      const id = row.tab_id != null ? row.tab_id : 'unknown';
      if (!byTab.has(id)) byTab.set(id, []);
      byTab.get(id).push(row);
    }

    const rows = [];
    for (const [tabId, entries] of byTab) {
      entries.sort((a, b) => (a.entered_at || 0) - (b.entered_at || 0));
      const firstUrl = entries[0]?.url || '-';
      const bars = entries.map((entry) => {
        const start = entry.entered_at ?? t0;
        const end = entry.left_at ?? t1;
        const left = ((start - t0) / span) * 100;
        const width = Math.max(0.4, ((end - start) / span) * 100);
        return `<div class="tab-bar" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHTML(entry.url || '')}"></div>`;
      }).join('');
      rows.push(`
        <div class="tab-row">
          <div class="tab-label" title="tab ${escapeHTML(String(tabId))} - ${escapeHTML(firstUrl)}">#${escapeHTML(String(tabId))} ${escapeHTML(firstUrl)}</div>
          <div class="tab-track">${bars}</div>
        </div>
      `);
    }
    rows.push(`
      <div class="tab-axis">
        <span>${fmtRelTime(0)}</span>
        <span>${fmtRelTime(span)}</span>
      </div>
    `);
    container.innerHTML = rows.join('');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Manifest tab
  // ───────────────────────────────────────────────────────────────────────
  function renderManifest() {
    const el = document.getElementById('manifest-view');
    if (!manifest) {
      el.textContent = '(no manifest.json found)';
      return;
    }
    el.innerHTML = colorJSON(manifest);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Audio footer
  // ───────────────────────────────────────────────────────────────────────
  function setupAudio() {
    const foot = document.getElementById('audio-foot');
    const audio = document.getElementById('audio');
    const alignBtn = document.getElementById('align-audio');
    const hint = document.getElementById('audio-hint');

    const audioFile = manifest?.audio?.file;
    if (!audioFile) {
      foot.classList.add('no-audio');
      audio.hidden = true;
      alignBtn.disabled = true;
      hint.textContent = 'no audio in this bundle';
      return;
    }
    audio.src = audioFile;
    hint.textContent = audioFile;
    alignBtn.addEventListener('click', () => {
      const e = currentEvent();
      if (!e || typeof e.t !== 'number') return;
      try {
        // e.t is relative ms since start.
        audio.currentTime = Math.max(0, e.t / 1000);
        audio.play().catch(() => {});
      } catch (err) {
        console.warn('[viewer] audio seek failed', err);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Lightbox
  // ───────────────────────────────────────────────────────────────────────
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');

  function openLightbox(src) {
    if (!src) return;
    lightboxImg.src = src;
    lightbox.hidden = false;
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = '';
  }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (ev) => {
    if (ev.target === lightbox) closeLightbox();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Boot
  // ───────────────────────────────────────────────────────────────────────
  renderHeader();
  populateKindDropdown();
  renderFeed();
  renderFocus();
  renderConsole();
  renderNetwork();
  renderShots();
  renderTabsTimeline();
  renderManifest();
  setupAudio();

  // Select the first event by default so the focus pane isn't empty.
  if (events.length > 0) {
    state.selectedVid = events[0]._vid;
    renderFeed();
    renderFocus();
  }
})();
