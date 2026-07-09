import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));

if (!existsSync('dist')) {
  console.error('[package] dist/ does not exist — run `npm run build` first.');
  process.exit(1);
}

async function collectFiles(dir, root = dir, out = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(abs, root, out);
    } else if (entry.isFile()) {
      out[relative(root, abs)] = new Uint8Array(await readFile(abs));
    }
  }
  return out;
}

const files = await collectFiles('dist');

if (!files['manifest.json']) {
  console.error('[package] dist/manifest.json missing — build is incomplete.');
  process.exit(1);
}

const zip = zipSync(files, { level: 9 });

await mkdir('releases', { recursive: true });
const versioned = `releases/recaptain-${pkg.version}.zip`;
const latest = `releases/recaptain.zip`;
await writeFile(versioned, zip);
await writeFile(latest, zip);

const sizeKb = (zip.byteLength / 1024).toFixed(1);
const fileCount = Object.keys(files).length;
console.log(`[package] ${versioned} — ${fileCount} files, ${sizeKb} KB`);
console.log(`[package] ${latest} — same bytes, versionless filename for releases/latest URL`);
console.log(`[package] upload both to: gh release create v${pkg.version} ${versioned} ${latest}`);
