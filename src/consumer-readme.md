# Recaptain bundle

This is a session recording captured by Recaptain. Intended consumers: LLMs turning it into a runbook, Playwright for replay, or a human double-clicking `index.html` to scrub through the flow.

## Fast path for each consumer

- **LLM**: read `RECAP.md` first (dense, LLM-optimized digest). Fall back to `events.json` + `pages.json` for detail.
- **Playwright**: `replay.spec.ts` is a runnable mechanical export — copy it into a Playwright project and `npx playwright test`. Masked fields resolve via `process.env.RECAPTAIN_SECRET_*`.
- **Human**: unzip and open `index.html` — self-contained viewer with the full timeline, screenshots, audio, and console.

## Files

Every recording bundle is a `.zip` containing the files below. Paths are relative to the bundle root.

### `manifest.json`
Top-level metadata. Schema (at a glance):
```
{
  "format": "recaptain-recording/2.2",
  "id": "<uuid>",
  "title": "<string>",
  "description": "<string>",          // 2.1+
  "created_at": "<ISO8601>",
  "duration_ms": <number>,             // active time (excludes paused + waiting windows)
  "total_waiting_ms": <number>,        // 2.2+ : cumulative time the page was busy + operator idle
  "viewport": { "w": <number>, "h": <number> },
  "user_agent": "<string>",
  "origin": "<string>",
  "counts": { "events": <n>, "screenshots": <n>, "console": <n>, "tabs": <n>, "pages": <n> },
  "capture_shots": <bool>,             // 2.2+ : operator toggle
  "capture_network": <bool>,           // 2.2+
  "capture_network_body": <bool>,      // 2.2+
  "waiting_semantics": { ... }         // 2.2+ : describes waiting-mode throttle behavior
}
```
Gotcha: `origin` is the first navigated origin, not necessarily the only one. Check `events.json` for full navigation trail.

### `events.json`
The ordered event stream. Array of event objects, each shaped roughly:
```
{
  "seq": <int>,
  "t": <ms-since-recording-start>,
  "kind": "<see Event kinds>",
  "url": "<string>",
  "tab_id": <int>,
  "target": { "locators": [...], "locator_matches": [...], "tag": "...", "text": "..." },
  "screenshot_id": "<id>",            // 2.1+, if a frame was captured for this event
  "target_state": { ... },            // 2.1+, on click events only
  "data": { /* kind-specific payload */ }
}
```
Gotcha: `seq` is authoritative ordering. `t` is monotonic but may have gaps where throttled events were dropped.

### `screenshots/index.json` + `screenshots/*.png`
`index.json` maps `screenshot_id` → relative PNG path, plus `{ w, h, captured_at, event_seq }`. PNGs are full-viewport captures at capture-time DPR. Not masked — see Privacy.

### `console.json`
Array of console messages: `{ t, level, args[], stack? }`. `args` is the stringified representation; objects are best-effort JSONified and may be truncated with `"[Truncated]"`.

### `tabs.json`
Array of tab lifecycle entries: `{ tab_id, opened_at, closed_at?, title, url_trail[] }`. Useful for resolving `tab_switch` events to a human-readable label.

### `audio.webm` (optional)
Operator narration, if recorded. Opus-encoded. Align to events by wall-clock: audio start = `manifest.created_at`. Not present in every bundle.

### `RECAP.md` (2.2+)
LLM-readable session digest. Dense, single-line-per-event timeline plus a per-page `[pN]` index with headings, landmarks, primary actions, and forms. This is the preferred starting point for any LLM conversion — use it first, then drop to `events.json` / `pages.json` for detail.

### `pages.json` (2.2+)
Structured landmark snapshots of every distinct page visited during the session, deduped by canonical URL (hash + `utm_*` / `fbclid` / `gclid` / `ref` stripped). Each entry carries `id` (`p1`, `p2`, …), `url`, `title`, `headings`, `landmarks`, `actions`, `forms`, `nav_items`, `screenshot`, and `first_visit_t`.

### `replay.spec.ts` (2.2+)
Runnable Playwright spec. Mechanically generated — not LLM-assisted. Collapses consecutive inputs into `.fill(...)`, maps assertion events to `expect(...)`, and emits `waitForResponse(...)` where network + waiting events line up. Masked fields resolve via `process.env.RECAPTAIN_SECRET_*` (env var name derived from the field's accessible name / label).

### `index.html` + `viewer.css` + `viewer.js` (2.2+)
Self-contained HTML viewer. Double-click `index.html` after unzipping — no server, no internet, no tools required. Bundle's JSON is inlined into `<script type="application/json">` tags; screenshots and audio load via normal `<img>`/`<audio>` tags.

### `README.md`
This file.

### `PROMPT.md`
A ready-to-paste prompt template for converting this bundle to a `wb` runbook via an LLM. See the "Converting to a `wb` runbook" section below.

## Event kinds

- `click` — primary-button click on an element.
- `dblclick` — double-click.
- `input` — value changed on a text-like field (fires per keystroke, debounced).
- `change` — committed change on select/checkbox/radio.
- `submit` — form submission.
- `key` — standalone key event (Enter, Escape, Tab, arrow keys, shortcuts). Non-modifier character keys inside inputs are covered by `input`.
- `focus` — element received focus (captured selectively, not every focus).
- `scroll` — scroll event on window or a scrollable container (heavily throttled).
- `navigation` — URL change (pushState, replaceState, popstate, full navigation).
- `tab_switch` — active tab changed.
- `marker` — operator-injected intent signal. Emitted when the operator explicitly marks "step boundary" in the recorder UI. Treat as a section break.
- `note` — operator-injected free-text annotation. Carries `data.text`.
- `idle` — auto-emitted synthetic event for any gap ≥1s between real events. Carries `data.duration_ms`. Useful for "wait_for" heuristics.
- `network` — 2.2+ only if Capture Network was toggled on. Fields: `method`, `url` (scrubbed), `status`, `ok`, `duration_ms`, `req_body_size`, `res_body_size`, `res_content_type`, optional `res_body` (first 4KB, JSON/text only, redacted).
- `assertion` — operator-captured verification point (Cmd/Ctrl+Shift+A). Fields: `assertion_kind` in `{visible, text_equals, text_contains, count, attr_equals}`, `expected`, `attr_name` (for `attr_equals`), `actual` (what the page had at capture time).
- `waiting_start` / `waiting_end` — auto-detected brackets around "the page is busy, the operator is idle" windows. Fields on the `end` event: `duration_ms`, `reasons` (subset of `network_active`, `spinner_visible`, `dom_churn`, `manual`), `peak_reqs`. Screenshots throttle to 30s cadence and mic pauses inside these windows; the time does NOT count against `duration_ms`.
- `landmark_snapshot` — 2.2+ captured on navigation. Fields: `title`, `headings`, `landmarks`, `actions`, `forms`, `nav_items`. The structured source for `pages.json`.

`marker` and `note` are the strongest signal of operator intent in the bundle — prioritize them when segmenting steps. `assertion` is first-class: downstream should emit real `expect(...)` calls for it.

## Locator format

Every targetable event carries `target.locators[]`, an array of selector strings **ordered by stability**, most stable first:

1. `getByTestId('...')`
2. `getByRole('...', { name: '...' })`
3. `getByLabel('...')`
4. `getByPlaceholder('...')`
5. `getByText('...')`
6. CSS selector (fallback)

Consumers should pick the first entry and keep later entries as fallbacks in comments. Do not default to the CSS selector unless nothing earlier exists.

### `locator_matches[]` (2.1+)

Parallel to `locators[]`. Each entry: `{ str, n }` where `n` is the `querySelectorAll` count at capture time for the equivalent DOM query. Prefer entries where `n === 1`. An entry with `n > 1` means the locator was ambiguous on the captured page — either disambiguate with an index or fall through to the next locator.

## Privacy

### Inputs
Fields matching sensitive heuristics are captured with `is_masked: true` and a `value_length` integer only — the raw value is omitted. Heuristics include:
- `type` in `{ password, email, tel }`
- `name` or `id` matching `/password|passwd|pwd|otp|token|secret|jwt|oauth|apikey|api_key/i`
- `autocomplete` token in `{ current-password, new-password, one-time-code, cc-number, cc-csc }`
- Element carries the `.recaptain-mask` class

### Screenshots (2.2+)
Screenshots **are** masked via black-out or blur rectangles painted over any element matching a recognized privacy convention (see list below). Per-screenshot `mask_rects` + `redaction_mode` are recorded in `screenshots/index.json` for auditability. The default mode is `black`. Operators can pick `blur` (visually legible enough to verify flow, unreadable for content) or `off` (no redaction — operator responsibility) in the sidepanel's "Screenshot privacy" selector.

Recognized privacy conventions (honored in both input masking and screenshot rect redaction):

- `recaptain-mask`, `data-recaptain-mask`, `data-sensitive` (this extension's own)
- `data-private`, `.private` (LogRocket / de-facto generic)
- `fs-mask`, `fs-exclude`, `fs-hide`, `data-fs-mask/exclude/hide` (FullStory)
- `ph-no-capture`, `.ph-no-capture` (PostHog)
- `data-hj-suppress` (Hotjar)
- `data-heap-redact-text` (Heap)
- `mp-mask`, `data-mp-mask` (Mixpanel)
- `amp-block`, `amp-mask` (Amplitude)

Anything else on screen (plain-text account numbers, customer names in a table) stays visible unless tagged. Accessibility markers (`aria-hidden`, `.sr-only`, `.visually-hidden`) are **not** treated as privacy signals — they're semantic for screen readers, not privacy.

### URLs
High-entropy query parameters are scrubbed. Keys scrubbed: `token`, `access_token`, `refresh_token`, `code`, `state`, `id_token`, `session`, `sig`, `signature`, `key`, `api_key`, `apikey`. Values replaced with `***`. Scrubbing applies to `url` on all events and to `manifest.origin`.

## What's NOT captured

- **Storage & cookies** — no `localStorage`, `sessionStorage`, `IndexedDB`, or cookie snapshots.
- **Request headers & request bodies** — only response metadata (and optionally short response bodies) when the operator enables Capture Network. `Authorization` / `Cookie` / `X-Api-Key` / `X-Auth-Token` / `Proxy-Authorization` are never captured.
- **WebSocket / EventSource / SSE** — out of scope.
- **Element visibility** — beyond the target-state snapshot attached to `click` events, there is no visibility, layout, or offset data.
- **Full DOM** — no DOM serialization. Only per-event target info + landmark snapshots per page + screenshots.

This is intentional: the recorder emits **semantic events**, not a replay trace. If you need a replay-grade capture, use rrweb or Playwright trace; this format optimizes for human/LLM comprehension and conversion to runnable runbooks.

## Converting to a `wb` runbook

Two paths:

1. **LLM-assisted** — Open `PROMPT.md` in this bundle. Paste it into an LLM along with `manifest.json`, `events.json`, and `screenshots/index.json`. The LLM produces a single markdown file with YAML frontmatter and ` ```browser ` fenced blocks.
2. **Mechanical first pass** — Use `bundle-to-skeleton.mjs` (reference converter in the recorder repo) for a zero-LLM skeleton. Fast, predictable, and a good starting point for hand-editing or feeding to an LLM for refinement.

### `wb` browser runtime verbs

The target runtime supports exactly these verbs. Do not invent others:

`goto`, `click`, `fill`, `press`, `wait_for`, `extract`, `assert`, `screenshot`, `pause_for_human`, `eval`, `save`

Reference example of a well-formed runbook:
`/Users/jmitch/dev/wb/examples/browser-demo.md`

## Schema version

The current schema version is declared in `manifest.format` as `recaptain-recording/2.2`.

### Changes in 2.2 (additive over 2.1)

- `manifest.total_waiting_ms`, `manifest.pages_count`, `manifest.capture_shots`, `manifest.capture_network`, `manifest.capture_network_body`, `manifest.waiting_semantics`.
- New bundle files: `RECAP.md`, `pages.json`, `replay.spec.ts`, `index.html` + `viewer.css` + `viewer.js`.
- New event kinds: `network`, `assertion`, `waiting_start`, `waiting_end`, `landmark_snapshot`.
- `screenshots/index.json` entries gain `mask_rects` + `redaction_mode`.

### Changes in 2.1

- `manifest.description` — free-text description string.
- `manifest.viewport` — `{ w, h }` viewport dimensions at recording start.
- `event.screenshot_id` — present on events where a frame was captured, references `screenshots/index.json`.
- `event.target_state` — present on `click` events, snapshots target element state (disabled, value, aria-expanded, etc.) at click time.
- `event.target.locator_matches[]` — parallel array to `locators[]`, with `{ str, n }` per entry.
- Event kinds: `marker`, `note`, `idle`.

Consumers written for older schemas still parse newer bundles; newer-only fields will simply be absent on older bundles.
