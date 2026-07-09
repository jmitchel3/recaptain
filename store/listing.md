# Chrome Web Store listing — Recaptain

Everything below maps to a field in the Chrome Web Store developer dashboard.
Copy/paste ready. No em-dashes in the prose per house style.

---

## Store listing tab

### Item name
`Recaptain` (matches the installed extension name)

Optional longer title if a descriptive one is wanted:
`Recaptain — Record & Share Browser Sessions` (69 chars, within the 75 limit)

### Summary / short description (max 132 chars)
> Record a browser session (clicks, screenshots, console, network, voice) into one shareable bundle. 100% free, local, and private.

(129 characters.)

### Category
**Developer Tools** (primary). Fallback: Productivity.

### Language
English (United States)

### Detailed description

> **Record it once. Hand off the whole story.**
>
> Recaptain turns a browser session into a single, shareable bundle: clicks,
> screenshots, console output, network activity, and your own voice narration,
> all captured together so anyone (a teammate, a QA engineer, or an AI agent) can
> understand exactly what happened.
>
> Perfect for documenting an automation, filing a bug that actually reproduces,
> or capturing a workflow you want to hand off.
>
> **100% Free. 100% Local. 100% Private.**
> Recaptain has no server, no account, and no backend. Nothing you record ever
> leaves your computer. There is no analytics, no telemetry, and no remote code.
>
> ---
>
> **What it captures**
> - Clicks, typing, navigation, and scrolling as clean semantic events, each with
>   Playwright-ready locator suggestions.
> - Screenshots of the active tab, taken periodically and on every meaningful action.
> - Console logs, warnings, and uncaught errors.
> - Network requests (URL, method, status, timing) for the page's own traffic.
> - Microphone narration, so you can talk through the flow as you record.
> - Assertions: press Cmd/Ctrl+Shift+A to attach a check to any element on the page.
>
> **Private by default**
> - Passwords, emails, and other sensitive inputs are masked automatically. The
>   raw value is dropped; only its length is kept.
> - Screenshots are redacted before they are ever encoded (solid black or blur,
>   your choice), including elements that use LogRocket, FullStory, PostHog, and
>   other recognized opt-out attributes.
> - High-entropy URL parameters are scrubbed from the log.
>
> **One portable artifact**
> Stop recording and you get a single .zip bundle you can send to anyone:
> - A self-contained viewer. Double-click to replay the session in your browser,
>   no server required.
> - A dense, LLM-ready RECAP.md digest of the whole session.
> - A runnable replay.spec.ts Playwright test built from the same stable locators.
> - The raw event, console, network, and screenshot data as clean JSON.
>
> **Built for handoff**
> Every recording is already a test and already a runbook. Feed the bundle to an
> AI agent, open it in the viewer, or run the Playwright spec as-is.
>
> Free and open source under the MIT license.

---

## Privacy practices tab (this is what review scrutinizes)

### Single purpose (required, one sentence)
> Recaptain records the active browser session into a downloadable bundle for
> local documentation, bug reporting, and test generation.

### Permission justifications
Paste each into the matching field.

| Permission | Justification |
|---|---|
| `host_permissions` (`<all_urls>`) | Required to inject the recorder content script into whatever page the user chooses to record, and to capture that tab's screenshot with `chrome.tabs.captureVisibleTab`. Not used for any network request. |
| `activeTab` | Identifies and operates on the tab the user is actively recording. |
| `tabs` | Follows the recording across tab switches and navigations so the timeline stays continuous. |
| `scripting` | Coordinates the recorder content script across page loads during a recording. |
| `downloads` | Saves the finished recording as a .zip file to the user's Downloads folder. |
| `offscreen` | Records microphone audio in an offscreen document, because an MV3 service worker cannot call `getUserMedia`. |
| `storage` | Persists in-progress recording state locally so a recording survives a service-worker restart (crash recovery). |
| `sidePanel` | Provides the recorder's start/stop and settings UI in the side panel. |

### Remote code
**No.** The extension executes no remotely hosted code. All scripts are bundled
in the package.

### Data usage disclosures
Recaptain does not collect or transmit any user data off the device, so under
Chrome's definition of "collection" (transmitting data off the user's device) it
collects nothing. Certify all three:

- [x] I do not sell or transfer user data to third parties, apart from the approved use cases.
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

Data types collected: **none** (no data is transmitted off the device).

### Privacy policy URL (required)
Host `store/privacy-policy.md` at a public URL and paste it here. A GitHub Pages
or repo raw/blob link to the file is acceptable, for example:
`https://github.com/<you>/recaptain/blob/main/store/privacy-policy.md`

---

## Notes for the account (not part of the listing)
- Item name and version come from `src/manifest.json` (built into `dist/manifest.json`).
- Chrome Web Store one-time developer registration fee ($5) applies to the account.
- Upload the packaged `dist/` as a .zip (run `npm run build` first).
