# Playback Feature (Design Notes)

Status: design exploration, not committed. Captured 2026-05-07. Revisit before any implementation.

## TL;DR

Add a **playback mode** to the recorder extension. Recorded bundles are already shareable artifacts; since the extension is the universal runtime, replay lives inside it rather than as a website-embedded library. Failures are private to the user running the extension, which sidesteps the "broken tour on a customer's brand" problem. Replay doubles as a drift-detection and inline-healing tool, turning the recorder into a closed-loop record / replay / heal / re-share system.

## Paths considered and rejected (for now)

Three replay surfaces were explored. We are pursuing only the third.

1. **`recaptain-autoguide.js` (script-tag library for site owners).** Most distribution leverage on paper (one `<script>` reaches every visitor, no install), but the recorded bundle's locator stability is not strong enough to put in front of a customer's visitors on the customer's domain. Every drift becomes a public failure with the site owner's logo on it. Also breaks on cross-origin navigation, which the recorder routinely captures. Rejected until either a re-identification layer or an agent-only positioning is in place.
2. **Embedded viewer-style replay (iframe a self-contained bundle viewer on a host site).** The bundle's `index.html` already replays itself as a frozen recording. Useful but already exists; it is replay against the *recording*, not against the *live site*, so it doesn't solve the tutorial use case. Status quo.
3. **Extension-side replay with timeline editor and inline drift healing.** This document.

## Why extension-only

- **Distribution is free for anyone who already has the recorder.** A bundle is a `.zip`; the extension is the player.
- **Failure surface is contained.** A locator miss surfaces to the user running replay, not to a customer's visitors.
- **Reuses ~80% of existing infra.** `pickLocator` (`src/shared/playwright-export.js`), Shadow-DOM overlay (`src/shared/assertion-capture.js`), waiting detector (`src/shared/waiting-mode.js`), SW state plumbing, and `describeElement` (`src/content.js`) all drop in or adapt cheaply.
- **Cross-tab / cross-origin survives natively.** Content scripts re-inject across navigations; the SW already owns canonical state and persists it via `shared/persistence.js`.
- **Heals can be persisted and re-shared.** A bundle whose locators have been re-pointed against the live site is itself a more durable artifact, which compounds the value of sharing recordings.

## Drift handling: three flavors

Replay needs a story for "the recorded locator no longer resolves." Increasing scope:

1. **Detect-and-pause.** Highlight what was expected, pause, let the user click the real element manually. Extension captures the resolved element via `describeElement` and uses it for advance. Nothing persisted.
2. **Point-to-heal with patch.** Same UX, but the resolved locator is written back, either as a healed bundle (`v2`) or a sidecar `patch.json`. Reuses the assertion-capture overlay almost wholesale. **This is the v1 target.**
3. **Suggest-then-confirm.** Replay fuzzy-matches via `pages.json` landmarks plus nearby text plus role, proposes a candidate, user confirms or rejects. Higher build cost. Defer until drift becomes the dominant complaint.

## Framing fix

Stop calling this "replay." The recorder scrubs input values, masks PII, and redacts screenshots by design, so faithful playback against the live app is not what the bundle supports. The honest framing is **guided checklist with locator-anchored coachmarks**, advanced manually or on detected interaction. This phrasing survives the privacy contract and sets correct user expectations.

## UI shape

Goal: replay should feel like editing a video clip, not driving a debugger.

### "Under the website" dock

Three options were considered for where the playback chrome lives:

| Option | Feel | Verdict |
|---|---|---|
| Content-script Shadow-DOM dock pinned to bottom of the page, with `body { padding-bottom: 96px }` injected so content is pushed up | Closest to "playback bar under the page." Co-located with the DOM under inspection, so step highlighting is a single paint. Reuses the Shadow-DOM hygiene patterns already in `assertion-capture.js` plus a new `__recaptainReplayActive` flag so content.js ignores its own clicks. | **Primary surface.** |
| Document Picture-in-Picture (`documentPictureInPicture` API) | Real floating window, always-on-top, survives tab switches and full reloads. Detached from page layout. Compelling for cross-tab recordings, but breaks the "scrub the page like a video" feel. | Future enhancement, possibly for cross-tab flows. |
| Existing sidepanel | Beside the page, not under. Doesn't match the playback-bar frame. | Rejected as the primary surface. Used as the editor pane (see below). |

### Two-track timeline

The dock contents:

- **Steps track** (top): user-meaningful events the operator would edit. Clicks, navigations, inputs, assertions, markers.
- **Context track** (bottom): scaffolding. Screenshots, network requests, console output. Dimmed regions render `waiting_start` / `waiting_end` ranges so the operator can see why replay paused.

Modeled loosely after a non-linear video editor's video plus audio tracks. The split is also useful for collapsing routine scaffolding without losing the ability to debug it on demand.

### Editor pane

The 96px-ish dock is too narrow for per-step editing. Click a step in the dock and the **sidepanel** opens to that step's editor, with fields for:

- Locator (with a "select new target" affordance that reuses the assertion-capture picker)
- Action (click / dblclick / input / key / etc.)
- Assertion attached to this step, if any
- "Ignore this step on replay" toggle
- "Add a note for the next operator" field

When replay pauses on a heal miss, the dock turns the step red and the sidepanel auto-opens to that step with the locator field primed in "select new target" mode.

## Open questions to settle before code

1. **In-place edit vs diff.** Does the timeline editor mutate the bundle (with undo stack and "save as v2"), or produce a sidecar `patch.json` that layers on top of the original? The patch model lines up cleanly with the format-as-standard direction (versioned, additive, original stays pristine), and makes "share the heal" a meaningful action. Probably patch-first.
2. **Patch format.** Versioned schema, e.g. `recaptain-patch/1.0`. Needs to encode: which event index was healed, the old locator descriptor, the new descriptor, who/when, optional note. Worth specifying alongside the bundle format spec rather than independently.
3. **Bundle versioning.** A heal applied to bundle `abc123` produces what? A new bundle `abc123+heal-N`? A fork? A pull-request-shaped artifact back to the original recorder? This is partly a social question (who is the source of truth) and partly a technical one (how do downstream consumers like `bundle-to-skeleton.mjs` discover the latest healed version). Worth deciding before the first heal lands.
4. **Spec first?** The format-as-standard agent argued the bundle is already a versioned spec (`recaptain-recording/2.2`) and a JSON Schema plus conformance fixtures plus `wb validate` is roughly a week of work. Doing this before the playback feature would force the patch format to be specified cleanly rather than retrofitted. Likely the right sequence.
5. **What counts as a "step" in the timeline.** The recorder emits ~20 event kinds; not all are user-editable. The Playwright export already knows which kinds to skip (`SKIP_KINDS` in `src/shared/playwright-export.js`); the timeline can borrow that classification.
6. **Auto-advance vs manual-only.** v1 should be manual-advance only to sidestep the "synthetic clicks bypass real handlers" trap. Auto-advance is a v2 question that overlaps with the agent-runtime conversation.

## Reuse map (for scoping later)

| Existing module | Replay use |
|---|---|
| `src/shared/playwright-export.js` `pickLocator` | Live locator resolution |
| `src/content.js` `describeElement` | Heal-time locator capture |
| `src/shared/assertion-capture.js` overlay | Coachmark + heal picker |
| `src/shared/waiting-mode.js` | "Wait until app is quiescent" gate between steps |
| `src/viewer/viewer.js` bundle parsing | Replay bundle loader |
| `src/background.js` SW state plumbing + `shared/persistence.js` | Replay state, crash-safe |

Net-new modules: replay scheduler, dock UI, timeline component, step editor pane, patch writer.

## Adjacent path: LLM-translated tour configs

Worth naming explicitly so it doesn't get lost. A `recaptain-recording` bundle can be translated into an Intro.js / Shepherd.js / Driver.js tour config by Claude (or any capable LLM) without any new runtime work, because the bundle already carries everything those libraries need:

- Ordered steps with stable locators (`getByRole`, `getByLabel`, `getByText`, css fallback)
- Per-step screenshots for thumbnail / preview
- `RECAP.md` for natural-language step copy
- Markers for chapter boundaries
- `landmark_snapshot` events for page-context narration

This means the "tour on a customer's site" use case doesn't have to be solved by `autoguide.js` at all. The site owner runs the bundle through a one-shot LLM translation (or a deterministic exporter, similar in shape to `src/shared/playwright-export.js`) and gets a tour config they own and host themselves. The bundle stays the canonical format; the tour library is downstream.

Practical implications for this design:

- Reinforces the "bundle is the format, runtimes are downstream" position. A `recaptain-export-introjs` exporter (or a `consumer-introjs-prompt.md` analog to `consumer-prompt.md`) is a cheap, useful artifact that doesn't require the playback feature to ship first.
- The extension's playback feature is about **verifying and healing the bundle**, not about producing tutorials. Tutorials are an LLM-translation away. Keeping the two concerns separate avoids overloading the playback UI with export-format choices.
- Suggests a small near-term win: ship a `consumer-introjs-prompt.md` (and/or shepherd, driver) alongside the existing `consumer-prompt.md`, so any user can paste a bundle into Claude and get a working tour config. Zero engineering on our side.

## Provenance

This document was extracted from a design conversation that included an 8-agent structured debate over extension-replay vs `recaptain-autoguide.js` vs format-first. Key dissenting voices preserved here:

- **Locator-drift skeptic**: captured locators are strings frozen at record time; `locator_matches: 1` is a record-time count, not a replay-time guarantee. Implication: drift handling is load-bearing, not optional.
- **Privacy skeptic**: scrubbing makes "replay" the wrong frame; "guided checklist" is honest. Implication: positioning matters as much as the build.
- **Agent-consumer**: agents want goals plus state checks, not click recipes. Implication: a separate goals-oriented surface (potentially MCP) is a parallel track to playback, not the same thing.
- **Format-as-standard advocate**: the bundle is already a versioned spec; runtimes are downstream. Implication: spec the patch format alongside the bundle format, not as a side effect of building playback.
