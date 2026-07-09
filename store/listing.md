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
**Productivity → Tools** (broadest accurate fit; keeps the audience wide rather than dev-only). Developer Tools is a narrower alternative if you ever want to target that shelf specifically.

### Language
English (United States)

### Detailed description

> **Record it once. Hand off the whole story.**
>
> Something broke, or you need to show someone exactly how a task is done.
> Recaptain records your browser session (every click, screenshot, and anything
> you say out loud) into one file you can hand to anyone. No more "it works on my
> screen" or writing out ten numbered steps from memory.
>
> Just click Start, do the thing, and click Stop. Talk through it with your voice
> if you like. You get back a single file that plays your session back like a
> recording, so the other person sees precisely what happened.
>
> **Great for anyone who needs to show, not tell:**
> - Reporting a bug that actually reproduces
> - Documenting how a workflow or automation really works
> - Handing a process off to a teammate, a new hire, or a client
> - Support and success teams capturing exactly what a user hit
> - Product and QA teams turning a session into a repeatable test
>
> No account, no setup, no learning curve.
>
> **100% Free. 100% Local. 100% Private.**
> Recaptain has no server and no backend. Nothing you record ever leaves your
> computer. There is no analytics, no telemetry, and no remote code. Your
> recording goes straight to your own Downloads folder and nowhere else.
>
> ---
>
> **What it captures**
> - Every click, keystroke, navigation, and scroll, as a clean step-by-step trail.
> - Screenshots of the tab, taken automatically as you go.
> - Your voice narration, so you can explain things as they happen.
> - Console messages and errors from the page.
> - Network activity (which requests the page made, and how they responded).
> - Checkpoints you add yourself: press Cmd/Ctrl+Shift+A to mark that something
>   should be true on the page.
>
> **Private by default**
> - Passwords, emails, and other sensitive fields are hidden automatically. The
>   actual value is never recorded.
> - Screenshots are redacted before the image is ever saved (blacked out or
>   blurred, your choice), and Recaptain honors the opt-out markers used by tools
>   like LogRocket, FullStory, and PostHog.
> - Sensitive bits of web addresses are scrubbed out of the log.
>
> **One file you can share with anyone**
> Stop recording and you get a single .zip. Double-click the viewer inside it to
> replay the whole session in your browser. Nothing to install, no server, works
> offline.
>
> **For the technical folks (optional bonus)**
> The same recording also includes machine-readable output, so it is ready for
> automation without any extra work:
> - A dense, LLM-ready RECAP.md digest you can feed straight to an AI agent.
> - A runnable Playwright test (replay.spec.ts) built from stable locators.
> - The raw events, console, network, and screenshots as clean JSON.
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
