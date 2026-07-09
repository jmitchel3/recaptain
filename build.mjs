import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');

// Single source of truth for version: package.json. The manifest is stamped
// at build time so `npm version` alone is enough to bump the extension.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

// Content scripts in MV3 are classic scripts (not ES modules), so they build as IIFE.
// Background service worker is declared type:module in the manifest, so it builds as ESM.
// Popup + offscreen are loaded via <script type="module"> in their HTML, so also ESM.
const esmEntries = {
  'background': 'src/background.js',
  'offscreen': 'src/offscreen/offscreen.js',
  'permission': 'src/permission/permission.js',
  'sidepanel': 'src/sidepanel/sidepanel.js',
};
const iifeEntries = {
  'content': 'src/content.js',
};

const common = {
  bundle: true,
  target: ['chrome120'],
  logLevel: 'info',
  sourcemap: 'inline',
  legalComments: 'none',
};

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  manifest.version = pkg.version;
  await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  await cp('src/offscreen/offscreen.html', 'dist/offscreen.html');
  await cp('src/permission/permission.html', 'dist/permission.html');
  await cp('src/permission/permission.css', 'dist/permission.css');
  await cp('src/sidepanel/sidepanel.html', 'dist/sidepanel.html');
  await cp('src/sidepanel/sidepanel.css', 'dist/sidepanel.css');
  await cp('src/consumer-readme.md', 'dist/consumer-readme.md');
  await cp('src/consumer-prompt.md', 'dist/consumer-prompt.md');
  if (existsSync('src/icons')) {
    await cp('src/icons', 'dist/icons', { recursive: true });
  }
  // Viewer is vanilla JS + CSS + HTML template, not bundled. The SW loads
  // these files at assembleBundle time and inlines the bundle's JSON into
  // index.html before zipping into each recording.
  if (existsSync('src/viewer')) {
    await mkdir('dist/viewer', { recursive: true });
    await cp('src/viewer/viewer.html', 'dist/viewer/viewer.html');
    await cp('src/viewer/viewer.css', 'dist/viewer/viewer.css');
    await cp('src/viewer/viewer.js', 'dist/viewer/viewer.js');
  }
}

async function run() {
  if (existsSync('dist')) await rm('dist', { recursive: true });
  await copyStatic();

  const esmOpts = { ...common, format: 'esm', entryPoints: esmEntries, outdir: 'dist' };
  const iifeOpts = { ...common, format: 'iife', entryPoints: iifeEntries, outdir: 'dist' };

  if (watch) {
    const esm = await context(esmOpts);
    const iife = await context(iifeOpts);
    await Promise.all([esm.watch(), iife.watch()]);
    console.log('[watch] bundling; edit src/** to rebuild');
  } else {
    await Promise.all([build(esmOpts), build(iifeOpts)]);
    console.log('[build] dist/ ready — load unpacked in chrome://extensions');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
