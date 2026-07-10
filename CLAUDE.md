# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # one-shot esbuild → dist/
npm run watch       # esbuild in watch mode (reload the unpacked extension after)
npm run clean       # rm -rf dist
npm run lint        # eslint src tests build.mjs

npm test                                     # node --test on tests/unit/**
node --test tests/unit/privacy.test.js       # single unit-test file
node --test --test-name-pattern='scrubUrl'   # single test by name

npm run test:e2e    # playwright; requires `npm run build` first: the spec
                    #   asserts dist/manifest.json exists and launches chromium
                    #   with --load-extension=dist
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`. The manifest's `version` field is stamped from `package.json` at build time, so `npm version` alone bumps the extension.

## Architecture

MV3 Chrome extension with four runtime contexts that talk via `chrome.runtime` messages. Knowing which context owns what state is the key to not getting lost:

- **`background.js` (service worker, ESM)**: the source of truth. Owns recording state, the activity stream, the tab timeline, screenshot capture via `chrome.tabs.captureVisibleTab`, bundle assembly, and `chrome.downloads`. Exposes `self.__recaptainTest` for e2e hooks.
- **`content.js` (content script, IIFE, `document_start`)**: page-side. Listens for click/input/key/submit/focus/scroll/change, builds Playwright-style locators via `describeElement`, debounces input (250ms), batches into the SW (400ms), and installs the console hook. Idempotent via `window.__recaptainRecorderInstalled__`. **Not** declared statically in the manifest: `<all_urls>` is an *optional* host permission (see Permission model below), so the SW registers this script dynamically (`chrome.scripting.registerContentScripts`, `document_start`, session-scoped) on start and unregisters it on stop; the already-open tab is covered by a one-off `executeScript` in `ensureContentScript`.
- **`offscreen/offscreen.js` (offscreen doc, ESM)**: exists because MV3 service workers can't call `getUserMedia` or `URL.createObjectURL`. Owns the `MediaRecorder` for mic audio, the level meter, and creates the bundle blob URL so `chrome.downloads` has something to fetch.
- **`sidepanel/sidepanel.js` (side panel, ESM)**: UI only. Connects to the SW via a long-lived `chrome.runtime.connect({ name: 'sidepanel' })` port; receives `activity:init` / `activity:append` / `recording:state` pushes. Never owns canonical state; a sidepanel reopen re-pulls from the SW.

### Permission model

`<all_urls>` is declared as `optional_host_permissions`, not a required grant, so nothing broad is requested at install (this avoids the Chrome Web Store broad-host-permission warning / in-depth-review flag). The sidepanel requests it on the first **Start**, inside the click's user gesture (`chrome.permissions.request` must run first in the handler, before any other await, because the gesture does not survive `chrome.runtime.sendMessage` to the SW). Without the grant there is nothing to record: events, the console/network hooks, and `captureVisibleTab` screenshots all need host access. The sidepanel shows a scope line (granted / requested-on-Start) with a **revoke** control (`chrome.permissions.remove`); the SW's `permissions.onRemoved` listener tears down the registered content script. A runtime grant of an optional broad host permission **cannot be granted in automated Chromium** (the native bubble never gets clicked, headless or headful), which is why the e2e promotes it to a required permission (see Testing).

**Build split** (`build.mjs`): content script ships as IIFE because MV3 content scripts are classic scripts; the SW, offscreen, permission, and sidepanel ship as ESM (SW is `type:module` in the manifest; the others load via `<script type="module">`). esbuild bundles with `target: chrome120`, inline sourcemaps.

### Capture model (`recaptain-recording/2.2`)

This is **not** rrweb. The recorder emits small semantic events, not a DOM snapshot. Each interaction carries a `target` descriptor with Playwright-ordered locators (`getByTestId` → `getByRole` → `getByLabel` → `getByPlaceholder` → `getByText` → `locator(css)`) plus `locator_matches` (match counts, so downstream consumers can pick an unambiguous one). `EVENT_KINDS` in `background.js` defines what goes into `events.json`, currently: `click`, `dblclick`, `input`, `change`, `submit`, `key`, `focus`, `scroll`, `navigation`, `tab_switch`, `marker`, `note`, `idle`, `pause`, `resume`, `timeout`, `network`, `assertion`, `waiting_start`, `waiting_end`, `landmark_snapshot`. `screenshot` and `console` are routed to their own files in the bundle.

### New page-side modules (all under `src/shared/`, imported by content.js)

- **`network-capture.js`**: monkey-patches `window.fetch` and `XMLHttpRequest` to emit one `network` event per request. Page-side intentionally; the SW has no host permissions and we want zero `webRequest` surface. Operator-gated by `captureNetwork`; response bodies sub-gated by `captureNetworkBody`. Also exposes `getInFlightCount()` for the waiting detector.
- **`waiting-mode.js`**: heuristic detector that flags "operator is waiting on the app" (no input + network in flight + spinner painted + DOM churn). Emits `waiting_start` / `waiting_end`; SW excludes the window from the active-time budget, throttles screenshots, and pauses mic. Also operator-toggleable via a manual button (`manualWaiting`).
- **`assertion-capture.js`**: Cmd/Ctrl+Shift+A opens a Shadow-DOM overlay over the hovered element to attach an assertion (visible / has-text / count / etc). Emits an `assertion` event. Sets `window.__recaptainAssertionActive` while open so content.js's normal listeners ignore the operator's overlay clicks. Manifest does not need a `commands` entry: this is a page-keydown listener (which means it does not fire on `chrome://` pages, by design).
- **`landmarks.js`**: one synchronous DOM walk per navigation, returning a structured snapshot (headings, nav, main regions, redaction-aware). Feeds the `landmark_snapshot` event the SW packages into `pages.json` + `RECAP.md`.
- **`redaction.js`**: split: `collectRedactRects()` runs page-side before each capture and returns CSS-px rects for elements matching `REDACT_SELECTOR` or that would be input-masked; `applyRedactionToBitmap()` runs SW-side and paints the rects (solid black or blurred) onto the bitmap before encoding.

### New SW-side export modules (pure, no `chrome.*`)

- **`recap-export.js`**: turns the activity stream into `pages.json` (deduped landmark snapshots keyed by canonical URL) and `RECAP.md` (dense LLM-readable digest). The RECAP.md format is a product contract; downstream consumers parse it.
- **`playwright-export.js`**: converts a bundle into `replay.spec.ts` using the same locator-collapsing rules as `scripts/bundle-to-skeleton.mjs`, but emitting TypeScript instead of `wb` markdown.

### Bundle viewer

`src/viewer/{viewer.html,viewer.css,viewer.js}` is a self-contained inspector for a recorded session. `build.mjs` copies these into `dist/viewer/`; at stop time, `assembleBundle` inlines the JSON data into `viewer.html` and writes it as `index.html` at the bundle root, alongside `viewer.css` / `viewer.js`. The bundle is a double-clickable artifact, no server required.

### Privacy contract

`src/shared/privacy.js` is the single source of truth, imported by both the content script and the SW. `PRIVACY_MANIFEST` is written into every bundle's `manifest.json` so consumers know what was filtered.

**Screenshots are redacted.** Default `redactionMode` is `'black'`: every element matching `REDACT_SELECTOR` or that would be input-masked has its bounding box painted over before encoding. Operator can pick `'blur'` or `'off'` in the sidepanel. Per-screenshot `mask_rects` + `redaction_mode` are persisted in `screenshots/index.json` for auditability. Recognized vendor opt-out conventions (LogRocket / FullStory / PostHog / Hotjar / Heap / Mixpanel / Amplitude data-attrs and class names) are honored in both input masking and screenshot redaction.

### Crash recovery

Recordings survive SW restart mid-session:

- Text state (meta, activity array, console, tab timeline) → `chrome.storage.session`, debounced writes (500ms) via `shared/persistence.js`.
- Screenshot bytes → IndexedDB (`recaptain` DB, `screenshots` store), too big for session storage quota.
- On SW wake, `rehydrateIfNeeded()` runs before any message handler; it pushes a `note` into the activity stream acknowledging that any unstopped mic audio before the restart is lost (MediaRecorder doesn't span SW crashes).

### Stop targets

Two destinations from `stop({ target })`:

1. **`download`** (default): SW sends bytes to offscreen, offscreen creates a blob URL, SW calls `chrome.downloads.download`, then revokes the blob after a 1s grace period.
2. **`project`**: writes unzipped files into a user-picked directory via the File System Access API. The `FileSystemDirectoryHandle` is persisted in its own IDB (`projects.js`), but **permission on a stored handle does not survive browser restart**; re-prompt happens on the next Start (inside a user gesture). `manifest.json` is written **last** as a completion marker. If the write fails, the SW keeps the assembled bundle in `lastAssembled` so the sidepanel can fall back to a zip download via `recorder:download-last`.

### Session limits

`SESSION_MAX_MS = 10 min` active (not wall-clock). `activeElapsedMs()` excludes paused time; on cap, the SW emits a `timeout` event and calls `stop({ target: 'download' })`.

### Screenshot behavior

Periodic every 8s; also fires on `click/dblclick/change/submit/navigation/tab_switch` with a 500ms cooldown. Past 20MB cumulative, new shots switch to JPEG @0.6; a `note` is emitted into activity so the bundle is honest about the quality shift. Thumbnails for the sidepanel are downscaled to ≤360px via `OffscreenCanvas`; the full PNG/JPEG is kept for the bundle; only the thumb lives in-memory for the UI.

## Testing

- **Unit tests** use Node's built-in test runner (`node --test`). They live in `tests/unit/` and only cover pure functions (e.g. `shared/privacy.js`).
- **E2E tests** (`tests/e2e/recording.spec.js`) copy `dist` to a temp dir and promote `<all_urls>` to a **required** `host_permissions` there (unpacked extensions auto-grant required host permissions with no prompt), because the shipped optional grant can't be driven headlessly. They launch a persistent Chromium context with `--load-extension=<tempdir>`, drive the recorder through `sw.evaluate(() => self.__recaptainTest.start(...))`, and use `__recaptainTest.stopAndPackage()` to get the zipped bytes directly; `chrome.downloads` isn't reliably observable from Playwright, so there's a dedicated test-only path that skips it. Content scripts don't inject on `about:blank` or `data:` URLs, so the spec spins up a real loopback HTTP server. The spec verifies the bundle-output contract with full access; the optional-grant UX is verified manually.

## Downstream

The repo also ships a reference bundle consumer (`scripts/bundle-to-skeleton.mjs`, no LLM) that walks a bundle and emits a runbook skeleton. Every bundle embeds `README.md` (consumer guide) and `PROMPT.md` (ready-to-use LLM prompt); these live in `src/consumer-readme.md` / `src/consumer-prompt.md` and are copied into `dist/` by `build.mjs`, then baked into the zip by `assembleBundle`.
