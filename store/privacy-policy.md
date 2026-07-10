# Recaptain Privacy Policy

_Last updated: July 10, 2026_

Recaptain is a Chrome extension that records a browser session (interactions,
screenshots, console output, network metadata, and optional microphone audio)
into a single bundle that you save to your own computer.

## The short version

Recaptain does not have a server, an account system, or a backend. It never
transmits your recordings, your browsing data, or any other information off your
device. Everything the extension captures stays on the machine it runs on and is
written only to a file location you choose (your Downloads folder or a directory
you pick).

## What Recaptain handles, and where it goes

While you are recording, Recaptain processes:

- **Page interactions** (clicks, typing, navigation, scrolling, and optionally
  keyboard shortcuts, text selection, and mouse gestures) as structured events.
  Captured text selection is redaction-aware: selections inside masked fields are
  stored as a length only.
- **Screenshots** of the tab you are recording.
- **Console messages** and uncaught errors from the page.
- **Network metadata** (URL, method, status, timing) for the page's own requests.
- **Microphone audio**, only if you enable it.

All of this is assembled locally into a `.zip` bundle (or written unzipped into a
folder you select) and handed to you. Recaptain is the sender of that data to
nowhere but your own disk.

## What Recaptain does NOT do

- It does not send data to the developer or to any third party.
- It does not include analytics, telemetry, tracking, or remote logging.
- It does not load or execute any remote code.
- It does not request any network host permission for itself. Site access is an
  optional permission that is not granted at install. You grant it deliberately,
  either for a single site (the current tab) or, if you choose, for all sites,
  and it is used solely to inject the recorder into the pages you record and to
  capture those tabs' screenshots. Grants are managed and revocable at any time
  from the extension's Permissions page and the side panel. A built-in denylist
  keeps recognized authentication and payment pages out of recordings by default,
  even under all-sites access.

## Privacy protections built in

- **Sensitive inputs are masked by default.** Passwords, emails, and fields
  matching a sensitive-attribute list are recorded with their length only; the
  raw value is dropped.
- **Screenshots are redacted by default.** Sensitive fields and elements marked
  with recognized opt-out attributes are painted over before the image is encoded.
- **High-entropy URL parameters are scrubbed** from the recorded event log.

## Your control

You start and stop every recording. You choose whether the microphone and network
capture are on. You decide where the resulting bundle is saved, and you can delete
it at any time. Because nothing is transmitted, there is no server-side copy to
request or erase.

## Contact

Questions about this policy can be raised as an issue on the project's GitHub
repository: https://github.com/jmitchel3/recaptain/issues
