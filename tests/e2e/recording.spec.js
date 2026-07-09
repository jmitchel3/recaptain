import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', '..', 'dist');

const TEST_HTML = `<!DOCTYPE html>
<html><body>
  <h1>E2E test flow</h1>
  <button id="go">Go</button>
  <input id="q" type="text" placeholder="search" />
</body></html>`;

function startServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

// Playwright extension-test dance: load the unpacked build, drive the
// recorder via __recaptainTest hooks on the service worker, capture the emitted
// download, inspect the zip. No sidepanel UI is touched; we're asserting
// the recorder's output contract, not its buttons.
async function launch() {
  // Sanity check: developer forgot to build.
  try { await fs.access(path.join(EXT_PATH, 'manifest.json')); }
  catch { throw new Error(`Extension not built at ${EXT_PATH}. Run \`npm run build\` first.`); }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recaptain-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // --headless=new lets Chromium load unpacked MV3 extensions without a
    // visible window, so CI/local runs don't pop a browser.
    channel: 'chromium',
    headless: false, // new-headless flag set below instead for wider support
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
    ],
    acceptDownloads: true,
    viewport: { width: 1024, height: 720 },
  });

  // Wait for the SW to spin up so __recaptainTest is available.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });

  return { context, sw, userDataDir };
}

test('records a flow and produces a valid recording bundle', async () => {
  const { server, url } = await startServer();
  const { context, sw, userDataDir } = await launch();
  try {
    const page = await context.newPage();
    // Content scripts don't inject on about:blank or data: URLs, so we
    // serve a real HTTP page from a loopback server.
    await page.goto(url);
    await page.bringToFront();
    // Wait a beat for the content script to register with the SW before we
    // flip on recording, otherwise the initial state.recording -> begin
    // message can lose the race.
    await page.waitForTimeout(300);

    await sw.evaluate(async () => {
      await self.__recaptainTest.start({
        label: 'e2e-smoke',
        mic: false,
        description: null,
        saveAs: false,
      });
    });

    await page.click('#go');
    await page.fill('#q', 'hello world');
    // Give the content script time to batch + flush its activity queue
    // (ACTIVITY_BATCH_MS in content.js is 400ms).
    await page.waitForTimeout(800);

    // Skip chrome.downloads; Playwright doesn't reliably observe downloads
    // triggered via the API. The test hook returns the zipped bytes so we
    // can inspect the bundle contract directly.
    const zippedArr = await sw.evaluate(async () => {
      return await self.__recaptainTest.stopAndPackage();
    });
    const bytes = new Uint8Array(zippedArr);
    const entries = unzipSync(bytes);

    // Contract: these files must exist in every bundle.
    for (const name of [
      'manifest.json',
      'events.json',
      'console.json',
      'tabs.json',
      'screenshots/index.json',
      'README.md',
      'PROMPT.md',
    ]) {
      expect(entries[name], `missing ${name} in bundle`).toBeTruthy();
    }

    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest.format).toBe('recaptain-recording/2.2');
    expect(manifest.label).toBe('e2e-smoke');
    expect(manifest.duration_ms).toBeGreaterThan(0);
    expect(manifest.events_count).toBeGreaterThan(0);
    expect(manifest.privacy).toBeTruthy();
    expect(typeof manifest.pages_count).toBe('number');
    expect(typeof manifest.total_waiting_ms).toBe('number');
    // 2.2 bundles always ship the new consumer artifacts.
    for (const name of ['RECAP.md', 'pages.json', 'replay.spec.ts', 'index.html', 'viewer.css', 'viewer.js']) {
      expect(entries[name], `missing ${name} in 2.2 bundle`).toBeTruthy();
    }

    const events = JSON.parse(strFromU8(entries['events.json']));
    expect(Array.isArray(events)).toBe(true);
    // We clicked and typed; expect at least one of each.
    expect(events.some((e) => e.kind === 'click')).toBe(true);
    expect(events.some((e) => e.kind === 'input')).toBe(true);

    const shotIndex = JSON.parse(strFromU8(entries['screenshots/index.json']));
    expect(Array.isArray(shotIndex)).toBe(true);
    expect(shotIndex.length).toBeGreaterThan(0);
    // Each indexed file is present in the zip.
    for (const row of shotIndex) {
      expect(entries[row.file], `missing ${row.file}`).toBeTruthy();
    }
  } finally {
    await context.close();
    await new Promise((r) => server.close(() => r()));
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
