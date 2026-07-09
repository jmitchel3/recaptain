// Throwaway demo: prove that a Recaptain recording bundle carries enough
// signal to detect design-pattern drift across two versions of the same flow.
//
// Boots a tiny HTTP server that serves either v1 or v2 of a "help center"
// page, launches Chromium with the recorder extension loaded, runs the same
// scripted flow against each version, and writes both bundles to
// /tmp/recaptain-drift-demo/.
//
// Run from repo root after `npm run build`:
//   node scripts/demo-design-drift.mjs

import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', 'dist');
const OUT_DIR = '/tmp/recaptain-drift-demo';

// ---------- Page templates ---------------------------------------------------

function pageHtml(version) {
  // Stable ids drive Playwright. Visible text / role names are what the
  // recorder writes into its locator priority list, and what changes between
  // versions to simulate a design tweak.
  if (version === 1) {
    return `<!DOCTYPE html><html><head><title>Help center</title></head>
<body>
  <header><h1>Help center</h1></header>
  <nav aria-label="Primary">
    <a href="#home">Home</a>
    <a href="#docs">Docs</a>
  </nav>
  <main>
    <h2>Search the docs</h2>
    <button id="primary">Search</button>
    <input id="q" type="text" placeholder="Search articles..." />
    <button id="submit">Go</button>
  </main>
</body></html>`;
  }
  // v2: button accessible names changed, heading rephrased, extra nav item,
  // and a wrapping div around the input (CSS-locator drift).
  return `<!DOCTYPE html><html><head><title>Help center</title></head>
<body>
  <header><h1>Help center</h1></header>
  <nav aria-label="Primary">
    <a href="#home">Home</a>
    <a href="#docs">Docs</a>
    <a href="#pricing">Pricing</a>
  </nav>
  <main>
    <h2>Quickly search our knowledge base</h2>
    <button id="primary">Find</button>
    <div class="search-wrap">
      <input id="q" type="text" placeholder="Type a question..." />
    </div>
    <button id="submit">Submit</button>
  </main>
</body></html>`;
}

function startServer() {
  const state = { version: 1 };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(state.version));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${port}/` });
    });
  });
}

// ---------- Browser harness --------------------------------------------------

async function launch() {
  await fs.access(path.join(EXT_PATH, 'manifest.json')).catch(() => {
    throw new Error(`Extension not built at ${EXT_PATH}. Run \`npm run build\` first.`);
  });
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recaptain-drift-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
    ],
    viewport: { width: 1024, height: 720 },
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return { context, sw, userDataDir };
}

async function runFlow({ context, sw, url, label }) {
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  // Let the content script register with the SW.
  await page.waitForTimeout(400);

  await sw.evaluate(async (lbl) => {
    await self.__recaptainTest.start({ label: lbl, mic: false, description: null, saveAs: false });
  }, label);

  // Same scripted actions in both runs — driven by stable #ids so the
  // accessible-name drift in v2 doesn't break the script (it's the recorder's
  // job to notice the drift).
  await page.click('#primary');
  await page.fill('#q', 'how do I export');
  await page.click('#submit');
  // Flush the content script's 400ms activity batch.
  await page.waitForTimeout(800);

  const zippedArr = await sw.evaluate(async () => self.__recaptainTest.stopAndPackage());
  await page.close();
  return new Uint8Array(zippedArr);
}

// ---------- Main -------------------------------------------------------------

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { server, state, url } = await startServer();
  const { context, sw, userDataDir } = await launch();
  try {
    state.version = 1;
    const v1 = await runFlow({ context, sw, url, label: 'drift-v1' });
    await fs.writeFile(path.join(OUT_DIR, 'v1.zip'), v1);
    console.log(`wrote ${OUT_DIR}/v1.zip (${v1.byteLength} bytes)`);

    state.version = 2;
    const v2 = await runFlow({ context, sw, url, label: 'drift-v2' });
    await fs.writeFile(path.join(OUT_DIR, 'v2.zip'), v2);
    console.log(`wrote ${OUT_DIR}/v2.zip (${v2.byteLength} bytes)`);
  } finally {
    await context.close();
    await new Promise((r) => server.close(() => r()));
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
