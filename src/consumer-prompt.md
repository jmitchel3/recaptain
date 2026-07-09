# Prompt: Convert Recaptain bundle → `wb` runbook

You are converting a Recaptain bundle into a `wb`-runnable markdown runbook. Produce exactly one markdown file as output. No preamble, no explanation, just the file contents.

## Read order

1. **`RECAP.md`**: dense LLM-readable session digest. Single line per event, pages indexed by `pN`. Start here.
2. **`pages.json`**: structured landmark snapshots keyed by page id. Use for headings / primary actions / forms.
3. **`events.json`**: full per-event detail when RECAP doesn't carry enough.
4. **`screenshots/index.json`**: screenshot paths + per-shot mask rects.
5. **`audio.webm`** (optional): operator narration, aligned by `manifest.started_at`.

RECAP is dense by design: no emojis, no tables, one line per event. Treat it as a line-delimited structured text digest, not prose. `replay.spec.ts` is also present if you want to see how a mechanical converter rendered the same session.

## Inputs

You will receive the bundle root. The schema is documented in the bundle's `README.md`; in particular: `manifest.json` carries counts + the privacy + waiting semantics, `events.json` carries every captured interaction.

## Output requirements

1. **YAML frontmatter** at the top with at minimum:
   ```yaml
   ---
   title: <from manifest.title>
   description: <from manifest.description, or one-line summary if absent>
   runtime: browser
   ---
   ```
2. **Section structure**: use `##` headings to bound steps. A new section begins at every `marker` event and at every `navigation` to a new origin. Use the `marker.data.label` (or the surrounding `note.data.text`) as the section title when present.
3. **Fenced blocks**: every executable step goes inside a ` ```browser ` fenced code block using only these verbs: `goto`, `click`, `fill`, `press`, `wait_for`, `extract`, `assert`, `screenshot`, `pause_for_human`, `eval`, `save`. Never invent verbs.
4. **Locator selection**: use `target.locators[0]` as the primary selector. Emit later locators as `# fallback: <locator>` comments on the line above. Prefer `locator_matches[]` entries where `n === 1`.
5. **Event collapsing**: sequential `input` events on the same field collapse into one `fill`. Consecutive `key` events that form a shortcut (e.g. Cmd+K) collapse into one `press`.
6. **Screenshots**: insert a `screenshot:` verb at every navigation boundary and after every `marker`. Reference the PNG by `screenshot_id` where available.
7. **Idle gaps**: translate `idle` events of notable duration (≥2s) into `wait_for:` calls when a post-idle event has a stable locator; otherwise drop the idle.
8. **Narration**: if an audio transcript is provided, weave relevant lines as prose between `##` sections; never inside ` ```browser ` blocks.

## Example block

```markdown
## Step 2: Open project settings

Operator navigates from the dashboard to the project's settings pane.

\`\`\`browser
# fallback: getByText('Settings')
click: getByRole('link', { name: 'Settings' })
wait_for: getByRole('heading', { name: 'Project settings' })
screenshot: settings-open
\`\`\`
```

## Reference

Model your output's structure, tone, and verb usage on:
`/Users/jmitch/dev/wb/examples/browser-demo.md`

If you cannot find a stable locator for an event, emit `pause_for_human:` with a descriptive message explaining what the operator needs to do.
