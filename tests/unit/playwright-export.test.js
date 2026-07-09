import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportPlaywrightSpec } from '../../src/shared/playwright-export.js';

function makeManifest(overrides = {}) {
  return {
    format: 'recaptain-recording/2.1',
    label: 'demo',
    description: null,
    start_url: 'https://example.com/',
    started_at: '2026-04-24T00:00:00.000Z',
    duration_ms: 12345,
    ...overrides,
  };
}

function loc(primary, { n = 1, fallbacks = [] } = {}) {
  const locators = [primary, ...fallbacks];
  const locator_matches = locators.map((s) => ({ str: s, n }));
  return { locators, locator_matches };
}

function target(primary, extra = {}, opts = {}) {
  return { ...loc(primary, opts), ...extra };
}

test('emits minimal spec with goto + click + fill + press', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'navigation', t: 0, to: 'https://example.com/', tab_id: 1 },
    {
      kind: 'click',
      t: 100,
      target: target(`getByRole('button', { name: 'Go' })`),
    },
    {
      kind: 'input',
      t: 200,
      final: true,
      value: 'hello',
      value_length: 5,
      target: target(`getByLabel('Name')`, { label: 'Name' }),
    },
    {
      kind: 'key',
      t: 300,
      key: 'Enter',
      target: target(`getByLabel('Name')`),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events, screenshotsIndex: [], console: [] });
  assert.match(out, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(out, /await page\.goto\("https:\/\/example\.com\/"\);/);
  assert.match(out, /page\.getByRole\('button', \{ name: 'Go' \}\)\.click\(\);/);
  assert.match(out, /page\.getByLabel\('Name'\)\.fill\("hello"\);/);
  assert.match(out, /page\.getByLabel\('Name'\)\.press\("Enter"\);/);
});

test('dedups first navigation when it matches start_url', () => {
  const manifest = makeManifest({ start_url: 'https://example.com/' });
  const events = [
    { kind: 'navigation', t: 0, to: 'https://example.com/' },
    {
      kind: 'click',
      t: 50,
      target: target(`getByRole('button', { name: 'OK' })`),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  const gotos = out.match(/await page\.goto\(/g) || [];
  // Should only be the start_url goto at top, not a second one for the first nav.
  assert.equal(gotos.length, 1);
});

test('first navigation dedup handles url fallback and missing target', () => {
  const urlFallback = exportPlaywrightSpec({
    manifest: makeManifest({ start_url: 'https://example.com/from-url' }),
    events: [{ kind: 'navigation', t: 0, url: 'https://example.com/from-url' }],
  });
  assert.equal((urlFallback.match(/await page\.goto\(/g) || []).length, 1);

  const missing = exportPlaywrightSpec({
    manifest: makeManifest({ start_url: 'https://example.com/' }),
    events: [{ kind: 'navigation', t: 0 }],
  });
  assert.match(missing, /\/\/ navigation with no target url/);
});

test('wraps each marker label in a test.step(...)', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'marker', t: 0, label: 'Login' },
    {
      kind: 'click',
      t: 10,
      target: target(`getByRole('button', { name: 'Sign in' })`),
    },
    { kind: 'marker', t: 100, label: 'Checkout' },
    {
      kind: 'click',
      t: 120,
      target: target(`getByRole('button', { name: 'Pay' })`),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(out, /await test\.step\("Login", async \(\)/);
  assert.match(out, /await test\.step\("Checkout", async \(\)/);
  assert.match(out, /page\.getByRole\('button', \{ name: 'Sign in' \}\)\.click\(\);/);
  assert.match(out, /page\.getByRole\('button', \{ name: 'Pay' \}\)\.click\(\);/);
});

test('emits env-var fill for masked input with label-derived key', () => {
  const manifest = makeManifest();
  const events = [
    {
      kind: 'input',
      t: 10,
      is_masked: true,
      value_length: 8,
      final: true,
      target: target(`getByLabel('Password')`, { label: 'Password' }),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(out, /\/\/ length=8/);
  assert.match(out, /process\.env\.RECAPTAIN_SECRET_PASSWORD \?\? ''/);
});

test('idle with stable next locator becomes waitFor', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'idle', t: 10, duration_ms: 3000 },
    {
      kind: 'click',
      t: 3100,
      target: target(`getByRole('link', { name: 'Next' })`),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(
    out,
    /page\.getByRole\('link', \{ name: 'Next' \}\)\.waitFor\(\{ state: 'visible' \}\);/,
  );
});

test('short idle (<500ms) is dropped', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'idle', t: 10, duration_ms: 200 },
    { kind: 'click', t: 100, target: target(`getByRole('button', { name: 'X' })`) },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.doesNotMatch(out, /waitFor\(/);
});

test('assertion events emit expect() calls', () => {
  const manifest = makeManifest();
  const events = [
    {
      kind: 'assertion',
      t: 10,
      assertion_kind: 'visible',
      target: target(`getByRole('heading', { name: 'Home' })`),
    },
    {
      kind: 'assertion',
      t: 20,
      assertion_kind: 'text_equals',
      expected: 'Hello',
      target: target(`getByTestId('greeting')`),
    },
    {
      kind: 'assertion',
      t: 30,
      assertion_kind: 'count',
      expected: 3,
      target: target(`locator('.item')`),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(
    out,
    /await expect\(page\.getByRole\('heading', \{ name: 'Home' \}\)\)\.toBeVisible\(\);/,
  );
  assert.match(
    out,
    /await expect\(page\.getByTestId\('greeting'\)\)\.toHaveText\("Hello"\);/,
  );
  assert.match(
    out,
    /await expect\(page\.locator\('\.item'\)\)\.toHaveCount\(3\);/,
  );
});

test('waiting_start/end with network emits waitForResponse on longest', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'waiting_start', t: 10 },
    { kind: 'network', t: 12, kind_net: 'xhr', method: 'GET', url: 'https://api.example.com/fast', duration_ms: 50, status: 200 },
    { kind: 'network', t: 13, kind_net: 'xhr', method: 'POST', url: 'https://api.example.com/v1/orders', duration_ms: 800, status: 200 },
    { kind: 'waiting_end', t: 900 },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(
    out,
    /await page\.waitForResponse\(resp => resp\.url\(\)\.includes\("\/v1\/orders"\) && resp\.ok\(\)\);/,
  );
});

test('waiting_start/end without network falls back to networkidle', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'waiting_start', t: 10 },
    { kind: 'waiting_end', t: 900 },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(out, /await page\.waitForLoadState\('networkidle'\);/);
});

test('click immediately followed by navigation collapses to Promise.all', () => {
  const manifest = makeManifest();
  const events = [
    {
      kind: 'click',
      t: 100,
      target: target(`getByRole('link', { name: 'About' })`),
    },
    { kind: 'navigation', t: 300, to: 'https://example.com/about' },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(out, /await Promise\.all\(\[/);
  assert.match(out, /page\.waitForURL\("https:\/\/example\.com\/about"\)/);
  assert.match(
    out,
    /page\.getByRole\('link', \{ name: 'About' \}\)\.click\(\),/,
  );
});

test('prefers a locator with n === 1 over earlier multi-match locators', () => {
  const manifest = makeManifest();
  const multi = `getByText('Save')`;
  const unique = `getByTestId('save-button')`;
  const ev = {
    kind: 'click',
    t: 10,
    target: {
      locators: [multi, unique],
      locator_matches: [
        { str: multi, n: 3 },
        { str: unique, n: 1 },
      ],
    },
  };
  const out = exportPlaywrightSpec({ manifest, events: [ev] });
  assert.match(out, /page\.getByTestId\('save-button'\)\.click\(\);/);
  // The multi-match locator should appear as a fallback comment.
  assert.match(out, /\/\/ fallback: getByText\('Save'\)/);
});

test('falls back to first locator when none are unique', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [{
      kind: 'click',
      target: {
        locators: [`getByText('Save')`, `getByRole('button', { name: 'Save' })`],
        locator_matches: [
          { str: `getByText('Save')`, n: 2 },
          { str: `getByRole('button', { name: 'Save' })`, n: 2 },
        ],
      },
    }],
  });
  assert.match(out, /page\.getByText\('Save'\)\.click\(\);/);
  assert.match(out, /\/\/ fallback: getByRole\('button', \{ name: 'Save' \}\)/);
});

test('zero events produces a skeleton test with a TODO', () => {
  const out = exportPlaywrightSpec({
    manifest: makeManifest({ label: 'empty' }),
    events: [],
  });
  assert.match(out, /test\("empty", async/);
  assert.match(out, /TODO: bundle had zero events/);
  assert.match(out, /await page\.goto\("https:\/\/example\.com\/"\);/);
});

test('default inputs produce a skeleton without a start navigation', () => {
  const out = exportPlaywrightSpec();
  assert.match(out, /bundle: recorded session \(recaptain-recording\/\?\)/);
  assert.match(out, /Duration \(active\): 0ms/);
  assert.match(out, /TODO: bundle had zero events/);
  assert.doesNotMatch(out, /await page\.goto/);
});

test('slugify falls back to step for non-alphanumeric labels', () => {
  const out = exportPlaywrightSpec({
    manifest: makeManifest({ label: '!!!', start_url: 'https://example.com/' }),
    events: [{ kind: 'focus' }],
  });
  assert.match(out, /screenshots\/step-start\.png/);
});

test('notes become // NOTE comments preceding subsequent actions', () => {
  const manifest = makeManifest();
  const events = [
    { kind: 'note', t: 10, text: 'verify button enabled' },
    {
      kind: 'click',
      t: 20,
      target: target(`getByRole('button', { name: 'Go' })`),
    },
  ];
  const out = exportPlaywrightSpec({ manifest, events });
  assert.match(out, /\/\/ NOTE: verify button enabled/);
});

test('navigation variants include missing-target comments and screenshots', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'navigation', t: 10, to: '' },
      { kind: 'navigation', t: 20, to: 'https://example.com/path/to/page?x=1' },
      { kind: 'navigation', t: 30, to: 'https://example.com/' },
      { kind: 'navigation', t: 40, to: 'notaurl' },
    ],
  });
  assert.match(out, /\/\/ navigation with no target url/);
  assert.match(out, /await page\.goto\("https:\/\/example\.com\/path\/to\/page\?x=1"\);/);
  assert.match(out, /screenshots\/page\.png/);
  assert.match(out, /screenshots\/root\.png/);
  assert.match(out, /screenshots\/nav\.png/);
});

test('tab switches, submits, standalone waiting_end, network, and unknown events are rendered safely', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'tab_switch', t: 10 },
      { kind: 'submit', t: 20, target: target(`locator('form')`) },
      { kind: 'submit', t: 30, target: {} },
      { kind: 'waiting_end', t: 40 },
      { kind: 'network', t: 50, status: 500 },
      { kind: 'mystery', t: 60 },
    ],
  });
  assert.match(out, /\/\/ TODO: tab switch not auto-translated/);
  assert.match(out, /\/\/ submit on locator\('form'\)/);
  assert.match(out, /\/\/ submit event \(no locator\)/);
  assert.match(out, /await page\.waitForLoadState\('networkidle'\);/);
  assert.doesNotMatch(out, /status: 500/);
  assert.match(out, /\/\/ unknown event kind: mystery/);
});

test('skipped-only recordings emit an empty step', () => {
  const out = exportPlaywrightSpec({
    manifest: makeManifest({ start_url: '' }),
    events: [
      { kind: 'focus' },
      { kind: 'scroll' },
      { kind: 'console' },
    ],
  });
  assert.match(out, /\/\/ no actions captured/);
});

test('idle without a stable future locator emits manual-wait comments', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'idle', t: 5 },
      { kind: 'idle', t: 10, duration_ms: 900 },
      { kind: 'navigation', t: 950, to: 'https://example.com/next' },
      { kind: 'idle', t: 2000, duration_ms: 1000 },
    ],
  });
  assert.match(out, /\/\/ idle 900ms \(no stable next locator/);
  assert.match(out, /\/\/ idle 1000ms \(no stable next locator/);
});

test('idle locator scan skips nulls and non-action markers', () => {
  const out = exportPlaywrightSpec({
    manifest: makeManifest({ start_url: '' }),
    events: [
      { kind: 'idle', t: 10, duration_ms: 900 },
      null,
      { kind: 'focus' },
      { kind: 'marker', label: 'Later' },
      { kind: 'note', text: 'still later' },
      { kind: 'click', target: target(`getByText('Ready')`) },
    ],
  });
  assert.match(out, /page\.getByText\('Ready'\)\.waitFor\(\{ state: 'visible' \}\);/);
});

test('click and fill events without stable locators become comments', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: {} },
      { kind: 'input', t: 20, value: 'x', target: { tag: 'input', id: 'name' } },
      { kind: 'change', t: 30, value: 'y', target: { tag: 'input', id: 'other' } },
    ],
  });
  assert.match(out, /\/\/ click with no stable locator/);
  assert.match(out, /\/\/ input with no stable locator/);
  assert.match(out, /\/\/ change with no stable locator/);
});

test('CSS fallback locators and already-prefixed locators are preserved', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: { css: 'button.save' } },
      { kind: 'click', t: 20, target: target(`page.getByText('Already')`) },
    ],
  });
  assert.match(out, /await page\.locator\("button\.save"\)\.click\(\);/);
  assert.match(out, /await page\.getByText\('Already'\)\.click\(\);/);
});

test('click options cover buttons and normalized modifiers', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      {
        kind: 'click',
        t: 10,
        button: 'right',
        modifiers: ['ctrl', 'option', 'cmd', 'Fn'],
        target: target(`getByRole('button', { name: 'Menu' })`),
      },
      {
        kind: 'click',
        t: 20,
        button: 1,
        modifiers: ['shift'],
        target: target(`getByRole('button', { name: 'Open' })`),
      },
    ],
  });
  assert.match(out, /button: 'right'/);
  assert.match(out, /modifiers: \["Control", "Alt", "Meta", "Fn"\]/);
  assert.match(out, /button: 'middle'/);
  assert.match(out, /modifiers: \["Shift"\]/);
});

test('keys can target the page keyboard and combine modifiers', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'key', t: 10, key: 'Enter' },
      { kind: 'key', t: 20, key: 'K', modifiers: ['control', 'alt'] },
      { kind: 'key', t: 30, key: '' },
    ],
  });
  assert.match(out, /await page\.keyboard\.press\("Enter"\);/);
  assert.match(out, /await page\.keyboard\.press\("Control\+Alt\+K"\);/);
});

test('fill grouping handles trailing change, final events, nulls, and locator breaks', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'input', t: 10, value: 'a', target: target(`getByLabel('Name')`) },
      null,
      { kind: 'input', t: 20, value: 'ab', target: target(`getByLabel('Name')`) },
      { kind: 'change', t: 30, value: 'abc', target: target(`getByLabel('Name')`) },
      { kind: 'input', t: 40, value: 'x', final: true, target: target(`getByLabel('Other')`) },
      { kind: 'input', t: 50, value: 'xy', target: target(`getByLabel('Other')`) },
    ],
  });
  assert.match(out, /page\.getByLabel\('Name'\)\.fill\("abc"\);/);
  assert.match(out, /page\.getByLabel\('Other'\)\.fill\("xy"\);/);
});

test('fill grouping covers value length fallbacks and fingerprint breaks', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'change', value: 'changed', target: target(`getByLabel('Change')`) },
      { kind: 'change', target: target(`getByLabel('EmptyChange')`) },
      { kind: 'input', is_masked: true, value_length: 3, target: target(`getByLabel('Masked')`) },
      { kind: 'input', is_masked: true, value: 'longer', target: target(`getByLabel('Masked')`) },
      { kind: 'input', is_masked: true, value_length: 10, target: target(`getByLabel('Masked')`) },
      { kind: 'input', value: null, target: target(`getByLabel('Null')`) },
      { kind: 'input', value: 123, target: target(`getByLabel('Number')`) },
      { kind: 'input', value: 'seed', target: target(`getByLabel('FallbackChange')`) },
      { kind: 'change', target: target(`getByLabel('FallbackChange')`) },
      { kind: 'input', final: true, target: target(`getByLabel('FinalNoValue')`) },
      { kind: 'input', value: 'first', target: target(`getByLabel('FinalFallback')`) },
      { kind: 'input', final: true, target: target(`getByLabel('FinalFallback')`) },
      { kind: 'input', value: 'a', target: { tag: 'input', id: 'one' } },
      { kind: 'input', value: 'b', target: { tag: 'input', id: 'one' } },
      { kind: 'input', value: 'c', target: { tag: 'input', name: 'two' } },
      { kind: 'input', value: 'missing target' },
      { kind: 'input', value: 'plain target', target: {} },
    ],
  });
  assert.match(out, /page\.getByLabel\('Change'\)\.fill\("changed"\);/);
  assert.match(out, /page\.getByLabel\('EmptyChange'\)\.fill\(""\);/);
  assert.match(out, /\/\/ length=10/);
  assert.match(out, /page\.getByLabel\('Null'\)\.fill\(""\);/);
  assert.match(out, /page\.getByLabel\('Number'\)\.fill\("123"\);/);
  assert.match(out, /page\.getByLabel\('FallbackChange'\)\.fill\("seed"\);/);
  assert.match(out, /page\.getByLabel\('FinalNoValue'\)\.fill\(""\);/);
  assert.match(out, /page\.getByLabel\('FinalFallback'\)\.fill\("first"\);/);
  assert.match(out, /\/\/ input with no stable locator/);
});

test('duplicate marker names are made unique', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'marker', t: 10, label: 'Review' },
      { kind: 'marker', t: 20, label: 'Review' },
      { kind: 'marker', t: 30, label: 'Review' },
      { kind: 'marker', t: 40, label: '' },
      { kind: 'marker', t: 50, label: '' },
      { kind: 'marker', t: 60, label: '   ' },
    ],
  });
  assert.match(out, /test\.step\("Review"/);
  assert.match(out, /test\.step\("Review \(2\)"/);
  assert.match(out, /test\.step\("Review \(3\)"/);
  assert.match(out, /test\.step\("step"/);
  assert.match(out, /test\.step\("step \(2\)"/);
  assert.match(out, /test\.step\("step \(3\)"/);
});

test('click-navigation collapse respects timing and intervening events', () => {
  const manifest = makeManifest({ start_url: '' });
  const late = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: target(`getByRole('link', { name: 'Late' })`) },
      { kind: 'navigation', t: 700, to: 'https://example.com/late' },
    ],
  });
  assert.doesNotMatch(late, /Promise\.all/);
  assert.match(late, /await page\.goto\("https:\/\/example\.com\/late"\);/);

  const interrupted = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: target(`getByRole('link', { name: 'Other' })`) },
      { kind: 'input', t: 20, value: 'x', target: target(`getByLabel('Search')`) },
      { kind: 'navigation', t: 100, to: 'https://example.com/other' },
    ],
  });
  assert.doesNotMatch(interrupted, /Promise\.all/);

  const urlFallback = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: target(`getByRole('link', { name: 'URL fallback' })`) },
      { kind: 'navigation', t: 100, url: 'https://example.com/url-fallback' },
    ],
  });
  assert.match(urlFallback, /page\.waitForURL\("https:\/\/example\.com\/url-fallback"\)/);

  const skipped = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: target(`getByRole('link', { name: 'Skip' })`) },
      null,
      { kind: 'focus' },
      { kind: 'console' },
      { kind: 'navigation', t: 100, to: 'https://example.com/skipped' },
    ],
  });
  assert.match(skipped, /Promise\.all/);

  const emptyTarget = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'click', t: 10, target: target(`getByRole('link', { name: 'Empty' })`) },
      { kind: 'navigation', t: 100 },
    ],
  });
  assert.match(emptyTarget, /page\.waitForURL\(""\)/);
});

test('waiting bracket variants handle url paths, missing urls, and no end event', () => {
  const manifest = makeManifest({ start_url: '' });
  const withPath = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'waiting_start', t: 10 },
      { kind: 'network', t: 20, url_path: '/explicit', url: 'https://api.example.com/actual', duration_ms: 10 },
      { kind: 'waiting_end', t: 30 },
    ],
  });
  assert.match(withPath, /includes\("\/explicit"\)/);

  const noWinner = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'waiting_start', t: 10 },
      null,
      { kind: 'network', t: 20, url: '', duration_ms: 10 },
    ],
  });
  assert.match(noWinner, /await page\.waitForLoadState\('networkidle'\);/);

  const durationFallback = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'waiting_start', t: 10 },
      { kind: 'network', t: 20, url: 'https://api.example.com/first' },
      { kind: 'network', t: 30, url: 'https://api.example.com/second', duration_ms: 1 },
      { kind: 'waiting_end', t: 40 },
    ],
  });
  assert.match(durationFallback, /includes\("\/second"\)/);

  const invalidUrl = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'waiting_start', t: 10 },
      { kind: 'network', t: 20, url: 'not a url', duration_ms: 1 },
      { kind: 'waiting_end', t: 30 },
    ],
  });
  assert.match(invalidUrl, /includes\("not a url"\)/);
});

test('assertion variants include contains, attrs, no-locator, and unknown kinds', () => {
  const manifest = makeManifest({ start_url: '' });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      { kind: 'assertion', assertion_kind: 'text_contains', expected: 'Hi', target: target(`getByText('Hi there')`) },
      { kind: 'assertion', assertion_kind: 'attr_equals', attribute: 'aria-expanded', expected: 'true', target: target(`getByRole('button')`) },
      { kind: 'assertion', assertion_kind: 'attr_equals', expected: 'abc', target: target(`locator('#field')`) },
      { kind: 'assertion', assertion_kind: 'attr_equals', target: target(`locator('#empty-attr')`) },
      { kind: 'assertion', assertion_kind: 'visible', target: {} },
      { kind: 'assertion', assertion_kind: 'count', expected: 'nope', target: target(`locator('.count')`) },
      { kind: 'assertion', assertion_kind: 'custom', target: target(`locator('#x')`) },
    ],
  });
  assert.match(out, /toContainText\("Hi"\)/);
  assert.match(out, /toHaveAttribute\("aria-expanded", "true"\)/);
  assert.match(out, /toHaveAttribute\("value", "abc"\)/);
  assert.match(out, /toHaveAttribute\("value", ""\)/);
  assert.match(out, /\/\/ assertion\(visible\) without locator/);
  assert.match(out, /toHaveCount\(0\)/);
  assert.match(out, /\/\/ unknown assertion_kind: custom/);
});

test('fallback event shapes cover defaults and skipped kinds', () => {
  const manifest = makeManifest({
    label: '',
    format: '',
    started_at: '',
    duration_ms: Number.NaN,
    start_url: 'https://example.com/',
  });
  const out = exportPlaywrightSpec({
    manifest,
    events: [
      null,
      { kind: 'focus' },
      { kind: 'scroll' },
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'timeout' },
      { kind: 'console' },
      { kind: 'note', note: 'note fallback' },
      { kind: 'note' },
      { kind: 'navigation', url: 'https://example.com/from-url' },
      { kind: 'dblclick', button: 0, target: target(`getByText('Twice')`) },
      { kind: 'click', target: target(`getByText('No time')`) },
      { kind: 'input', value: undefined, target: target(`getByLabel('Blank')`) },
      { kind: 'input', is_masked: true, target: target(`getByLabel('Secret')`, {}) },
      { kind: 'input', is_masked: true, value_length: 1, target: target(`getByLabel('Symbols')`, { label: '!!!' }) },
      { kind: 'input', is_masked: true, value_length: 2, target: target(`getByLabel('Placeholder')`, { placeholder: 'PIN code' }) },
      { kind: 'input', is_masked: true, value_length: 3, target: target(`getByLabel('Named')`, { name: 'api token' }) },
      { kind: 'input', is_masked: true, value_length: 4, target: target(`getByLabel('Identified')`, { id: 'field id' }) },
      { kind: 'key', key: 'Z', modifiers: ['meta'] },
      { kind: 'idle', duration_ms: 800 },
      { kind: 'waiting_start' },
      { kind: 'network', url: 'https://api.example.com/no-duration' },
      { kind: 'waiting_end' },
    ],
  });
  assert.match(out, /bundle: recorded session \(recaptain-recording\/\?\)/);
  assert.match(out, /Duration \(active\): 0ms/);
  assert.match(out, /\/\/ NOTE: note fallback/);
  assert.match(out, /await page\.goto\("https:\/\/example\.com\/from-url"\);/);
  assert.match(out, /page\.getByText\('Twice'\)\.dblclick\(\);/);
  assert.match(out, /page\.getByText\('No time'\)\.click\(\);/);
  assert.match(out, /page\.getByLabel\('Blank'\)\.fill\(""\);/);
  assert.match(out, /process\.env\.RECAPTAIN_SECRET_FIELD/);
  assert.match(out, /\/\/ length=1/);
  assert.match(out, /process\.env\.RECAPTAIN_SECRET_PIN_CODE/);
  assert.match(out, /process\.env\.RECAPTAIN_SECRET_API_TOKEN/);
  assert.match(out, /process\.env\.RECAPTAIN_SECRET_FIELD_ID/);
  assert.match(out, /page\.keyboard\.press\("Meta\+Z"\);/);
  assert.match(out, /\/\/ idle 800ms \(no stable next locator/);
  assert.match(out, /includes\("\/no-duration"\)/);
});
