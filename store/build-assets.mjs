// Renders the Chrome Web Store image assets to exact pixel dimensions.
// Usage: node store/build-assets.mjs
// Requires the Playwright chromium build (already a dev dependency).

import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

// Chrome Web Store exact specs:
//   screenshots     1280x800 (preferred)
//   small promo     440x280
//   marquee promo   1400x560
const jobs = [
  { file: 'screenshot-1-hero.html',    out: 'screenshot-1-hero.png',    w: 1280, h: 800 },
  { file: 'screenshot-2-capture.html', out: 'screenshot-2-capture.png', w: 1280, h: 800 },
  { file: 'screenshot-3-privacy.html', out: 'screenshot-3-privacy.png', w: 1280, h: 800 },
  { file: 'screenshot-4-bundle.html',  out: 'screenshot-4-bundle.png',  w: 1280, h: 800 },
  { file: 'screenshot-5-replay.html',  out: 'screenshot-5-replay.png',  w: 1280, h: 800 },
  { file: 'promo-small.html',          out: 'promo-small-440x280.png',  w: 440,  h: 280 },
  { file: 'promo-marquee.html',        out: 'promo-marquee-1400x560.png', w: 1400, h: 560 },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    // deviceScaleFactor 1 → PNG matches CWS's exact-dimension requirement 1:1.
    const page = await browser.newPage({
      viewport: { width: job.w, height: job.h },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(join(srcDir, job.file)).href, { waitUntil: 'load' });
    await page.screenshot({
      path: join(outDir, job.out),
      clip: { x: 0, y: 0, width: job.w, height: job.h },
    });
    await page.close();
    console.log(`  ✓ ${job.out}  (${job.w}x${job.h})`);
  }

  // Store icon: reuse the real extension icon so the listing matches what installs.
  copyFileSync(join(here, '..', 'src', 'icons', 'icon-128.png'), join(outDir, 'store-icon-128.png'));
  console.log('  ✓ store-icon-128.png  (128x128, copied from src/icons)');
} finally {
  await browser.close();
}

console.log(`\nDone → ${outDir}`);
