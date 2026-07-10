# Recaptain access model

Guiding principle: **nothing at install, every capability opt-in.** Recaptain
installs with only the permissions that grant no site or device access and show
no prompt. Every capability that touches a site or a device is a toggle that
requests its permission at the moment it is enabled, and can be revoked.

## Permission -> capability map

| Capability | Permission it opts into | Prompt |
|---|---|---|
| Capture a site (events / console / network / DOM) | per-site host, or all-sites | per-site: "read data on app.example.com"; all-sites: broad |
| Screenshots | all-sites (`captureVisibleTab` needs it) | broad |
| Follow across tabs | all-sites | broad |
| Microphone narration | mic (`getUserMedia`) | mic |
| Video / tab recording (DEFERRED) | `tabCapture`, invoke-gated | none at install |
| Denylist (auth / payment suppression) | none, it only subtracts | none |

Baseline (no prompt, no site/data access): `scripting`, `storage`, `offscreen`,
`sidePanel`.

Two install-time warnings remain today and are only worth deferring if "zero
prompts at install" becomes a hard goal:
- `tabs` -> "Read your browsing history" (could be dropped; read tab URLs via
  host grants instead).
- `downloads` -> "Manage your downloads" (could be requested on first save).

## Two layers

1. **Permission layer (Chrome grants):** where Recaptain *can* inject. Either an
   allowlist of per-site grants, or "allow all" (`<all_urls>`).
2. **Capture policy (Recaptain's choice):** the **denylist**, patterns Recaptain
   refuses to record even where it has permission. Built-in auth/payment
   defaults plus user edits. Needs no permission; it only subtracts.

Effective capture = **(allowed sites, or all) minus denied patterns.**

Enforcement:
- Content-script registration passes the denylist as **`excludeMatches`**, so
  Chrome never injects on denied patterns.
- Screenshots and the already-open-tab injection check the URL against the
  denylist at runtime and skip + drop an honest gap note.
- The active denylist is recorded in `PRIVACY_MANIFEST` so every bundle
  documents what was suppressed.
- Gating is on the **top-frame origin**: a full-page redirect to an IdP is
  covered; an auth widget in a cross-origin iframe is not (those frames are
  unreachable anyway, and password fields are already masked).

## Pattern syntax

Friendly short form, normalized in a pure, unit-tested `shared/match-patterns.js`
shared by the allowlist and denylist:

- **No scheme** -> assume `*://` (matches http and https; `*` scheme covers only
  those, which is all that is recordable).
- **No path** -> assume `/*`, so a bare host covers the whole domain.
- **Subdomains stay explicit**: `*.okta.com/*` for "any subdomain".
- A scheme can still be pinned (`https://only-secure.example.com/*`).
- The UI shows the expanded canonical form for transparency. For Chrome's
  `excludeMatches` (which requires a full match pattern), the short form is
  canonicalized under the hood: `checkout.stripe.com/*` -> `*://checkout.stripe.com/*`.

### Built-in denylist (editable)

```
accounts.google.com/*        login.microsoftonline.com/*    login.live.com/*
*.okta.com/*                 *.auth0.com/*                  *.onelogin.com/*
*.pingidentity.com/*         *.duosecurity.com/*
signin.aws.amazon.com/*      id.atlassian.com/*
github.com/login*            github.com/session
checkout.stripe.com/*        *.paypal.com/*
```

## Capture toggles and defaults

- **Capture screenshots** - default OFF. Turning on requests all-sites.
- **Follow across tabs** - default OFF (record only the tab you started on).
  Turning on requests all-sites (other tabs can be on any domain).
- **Denylist auth/payment defaults** - default ON.
- **Capture network** - existing toggle, stays page-side, no permission change.
- **Video** - DEFERRED (see below).

With screenshots and follow-across-tabs both off, the user grants individual
sites (one friendly prompt each) that stack into a removable allowlist, and the
scary all-sites prompt never appears.

## Cross-origin behavior

When a per-site recording navigates to an ungranted origin (SSO / checkout
redirect), the timeline gets an honest "no access to auth.okta.com - not
captured" gap, and the sidepanel grant button re-points to the new site so
adding it is one click.

## UI split

- **Sidepanel:** everyday toggles (screenshots, mic, network, follow-across-tabs)
  and the current-site grant / revoke / scope status.
- **Options page** (`chrome.runtime.openOptionsPage`): allowlist + denylist
  pattern editors and advanced/experimental toggles. Cramped pattern editing
  does not belong in the side panel.

## Deferred

- **`activeTab` zero-prompt variant** for the pure single-tab case: no prompt at
  all and screenshots work, but access drops on cross-origin navigation and it
  must be armed by a toolbar-icon click. Revisit only if a no-prompt default is
  worth the fragility.
- **Video / tab recording**: possible via `tabCapture` + the existing offscreen
  MediaRecorder pipeline, but it cannot inherit screenshot redaction (would need
  real-time canvas compositing) and inverts the tiny-bundle property. Likely a
  separate companion extension (holds `tabCapture`, hands the `.webm` back via
  `externally_connectable`) to keep Recaptain's redaction promise uncontaminated.

## Foundation contracts (Step 0 - BUILT)

Two shared modules are the fixed interface every phase codes against. Do not
change their signatures; import and use them.

`src/shared/match-patterns.js` (pure, unit-tested):
- `canonicalize(input)` -> canonical Chrome match pattern string (for
  `excludeMatches`). Throws on invalid.
- `isValidPattern(input)` -> boolean (for editor validation).
- `compileMatcher(patterns)` -> `(url) => boolean` tester over a list.
- `matchesAny(url, patterns)` -> boolean convenience.

`src/shared/access-config.js` (chrome.storage.local):
- `getConfig()` -> `{ version, captureShots:false, followTabs:false,
  denylistEnabled:true, denylist:[...] }` merged with defaults.
- `setConfig(patch)` -> shallow-merges and persists, returns the next config.
- `getActiveDenylist()` -> `[]` if disabled, else the patterns.
- `onConfigChanged(cb)` -> subscribe (returns unsubscribe).
- `BUILTIN_DENYLIST`, `DEFAULT_CONFIG` exported.

Propagation contract (no new runtime messages): config lives in
chrome.storage.local, so the SW and every open UI observe changes via
`onConfigChanged` / storage.onChanged. Host grants live in the permissions API;
the SW reacts via `chrome.permissions.onAdded/onRemoved`. The allowlist is
`chrome.permissions.getAll().origins`, not stored in config.

## Build phases

1. **Permission core** - BUILT. `optional_host_permissions: ["<all_urls>"]`,
   per-site + all-sites grants, priming + revoke, screenshots gated on
   all-sites, dynamic per-origin content-script registration.
2. **Denylist** - BUILT. `shared/match-patterns.js` + built-in defaults +
   `excludeMatches` + runtime gating + gap notes + bundle-manifest disclosure.
3. **Allowlist UI + Options page** - BUILT. Sidepanel per-site allowlist +
   `src/options/` page with allowlist + denylist pattern editors.
4. **Follow-across-tabs toggle** - BUILT. Off by default; enabling requests
   all-sites; `handleTabSwitch` gates on it.
5. **Deferred**: activeTab variant, video companion.

## Decisions (locked)

- Defaults: screenshots OFF, follow-across-tabs OFF, denylist auth defaults ON.
  ("All off" applies to capture toggles; the denylist is a protection, not a
  capture capability, so it stays on.)
- Sequencing: build the whole model (Phases 1-4) now, then resubmit.

## Companion (video) integration: what is possible without modifying Recaptain

- **Fully decoupled: zero modification.** A companion extension records tab
  video entirely on its own (own start/stop UI), producing a separate `.webm`.
  The user runs both and associates the outputs manually. No coupling, no
  Recaptain change, but no automatic sync.
- **Integrated (video lands in the bundle, synced start/stop): needs a small,
  deliberate API in Recaptain.** Cross-extension messaging requires the
  *receiving* extension to opt in via `externally_connectable` + an
  `onMessageExternal` handler. So true integration is not "no modification"; it
  is a minimal, versioned companion protocol added to Recaptain on purpose.
- Decision: do NOT build the companion API yet (video is deferred). Revisit when
  video demand is real; design the protocol then.
