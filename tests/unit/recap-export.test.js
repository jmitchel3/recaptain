import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecapMd,
  buildPagesJson,
  canonicalUrl,
} from '../../src/shared/recap-export.js';

function manifest(overrides = {}) {
  return {
    format: 'recaptain-recording/2.2',
    label: 'demo',
    description: null,
    start_url: 'https://example.com/',
    started_at: '2026-04-24T00:00:00.000Z',
    duration_ms: 65000,
    total_waiting_ms: 0,
    events_count: 0,
    hosts: ['example.com'],
    ...overrides,
  };
}

function locTarget(primary) {
  return { locators: [primary] };
}

test('empty events emits "no events" timeline', () => {
  const out = buildRecapMd({ manifest: manifest(), events: [], pages: [] });
  assert.match(out, /^# Session/);
  assert.match(out, /## Timeline\n\n\(no events\)/);
  assert.match(out, /pages: 0/);
  assert.match(out, /events: 0/);
});

test('default inputs produce a valid empty recap', () => {
  const out = buildRecapMd();
  assert.match(out, /label: \(unlabeled\)/);
  assert.match(out, /description: \(none\)/);
  assert.match(out, /duration_ms_active: 0/);
  assert.match(out, /duration_ms_waiting: 0/);
  assert.match(out, /hosts: \[\]/);
  assert.match(out, /## Pages\n\n\(no pages\)/);
  assert.match(out, /## Timeline\n\n\(no events\)/);

  const tabsOut = buildRecapMd({ tabTimeline: [] });
  assert.match(tabsOut, /label: \(unlabeled\)/);
});

test('input collapse: 3 inputs on same locator -> 1 fill line with final value', () => {
  const events = [
    { kind: 'input', t: 1000, value: 'h', target: locTarget(`getByLabel('Name')`) },
    { kind: 'input', t: 1500, value: 'he', target: locTarget(`getByLabel('Name')`) },
    { kind: 'input', t: 2000, value: 'hello', target: locTarget(`getByLabel('Name')`), final: true },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  // One line preserving the first event's timestamp (00:01), final value "hello".
  const fillMatches = out.match(/fill getByLabel\('Name'\) = "hello"/g) || [];
  assert.equal(fillMatches.length, 1);
  assert.match(out, /00:01 fill getByLabel\('Name'\) = "hello"/);
});

test('masked input line: timeline uses <MASKED length=N>, Masked section lists it', () => {
  const events = [
    {
      kind: 'input',
      t: 5000,
      is_masked: true,
      value_length: 12,
      mask_reason: 'password',
      target: locTarget(`getByLabel('Password')`),
    },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.match(out, /fill getByLabel\('Password'\) = <MASKED length=12>/);
  assert.match(out, /## Masked\n\n00:05 getByLabel\('Password'\) length=12 reason=password/);
  assert.match(out, /masked_inputs: 1/);
});

test('marker + note + assertion + waiting + pause/resume are rendered', () => {
  const events = [
    { kind: 'marker', t: 1000, label: 'Login' },
    { kind: 'note', t: 1500, text: 'smoke test path' },
    { kind: 'pause', t: 2000 },
    { kind: 'resume', t: 5000, paused_ms: 3000 },
    {
      kind: 'waiting_end',
      t: 6000,
      duration_ms: 1200,
      reasons: ['network', 'animation'],
    },
    {
      kind: 'assertion',
      t: 7000,
      assertion_kind: 'visible',
      target: locTarget(`getByRole('heading', { name: 'Home' })`),
    },
    {
      kind: 'assertion',
      t: 8000,
      assertion_kind: 'text_equals',
      expected: 'Hello',
      target: locTarget(`getByTestId('greet')`),
    },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.match(out, /00:01 marker "Login"/);
  assert.match(out, /00:01 note "smoke test path"/);
  assert.match(out, /00:02 pause/);
  assert.match(out, /00:05 resume \(3s paused\)/);
  assert.match(out, /00:06 waiting 1\.2s \(reasons: network\+animation\)/);
  assert.match(out, /00:07 assert visible getByRole\('heading', \{ name: 'Home' \}\)/);
  assert.match(out, /00:08 assert text_equals getByTestId\('greet'\) = "Hello"/);
  assert.match(out, /## Markers\n\n00:01 "Login"/);
  assert.match(out, /## Notes\n\n00:01 "smoke test path"/);
});

test('same-host nav shows path only; cross-host nav shows full URLs', () => {
  const events = [
    { kind: 'navigation', t: 1000, from: 'https://example.com/a', to: 'https://example.com/b?q=1' },
    { kind: 'navigation', t: 2000, from: 'https://example.com/b', to: 'https://other.test/x' },
    { kind: 'navigation', t: 3000, from: 'https://example.com', to: 'https://example.com' },
  ];
  const out = buildRecapMd({
    manifest: manifest({ start_url: 'https://example.com/' }),
    events,
    pages: [],
  });
  assert.match(out, /00:01 nav \/a -> \/b\?q=1/);
  // Cross-host: full URLs preserved.
  assert.match(out, /00:02 nav https:\/\/example\.com\/b -> https:\/\/other\.test\/x/);
  assert.match(out, /00:03 nav \/ -> \//);
});

test('long values truncated to 80 chars with ellipsis in fill', () => {
  const big = 'x'.repeat(200);
  const events = [
    { kind: 'input', t: 1000, value: big, target: locTarget(`getByLabel('Bio')`), final: true },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  // >40 chars → use `<N chars>` marker, not quoted value.
  assert.match(out, /fill getByLabel\('Bio'\) = <200 chars>/);
});

test('fill with 41-80 char value emits `<N chars>` form', () => {
  const v = 'a'.repeat(60);
  const events = [
    { kind: 'input', t: 1000, value: v, target: locTarget(`getByLabel('X')`), final: true },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.match(out, /fill getByLabel\('X'\) = <60 chars>/);
});

test('quoted short values are escaped for newlines and quotes', () => {
  const events = [
    {
      kind: 'assertion',
      t: 1000,
      assertion_kind: 'text_equals',
      expected: 'He said "hi"\nline2',
      target: locTarget(`locator('#x')`),
    },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.match(out, /assert text_equals locator\('#x'\) = "He said \\"hi\\"↵line2"/);
});

test('assertion values longer than 80 chars are truncated in quotes', () => {
  const events = [
    {
      kind: 'assertion',
      t: 1000,
      assertion_kind: 'text_equals',
      expected: 'x'.repeat(100),
      target: locTarget(`locator('#long')`),
    },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.match(out, /assert text_equals locator\('#long'\) = "x{80}\.\.\."/);
});

test('buildPagesJson dedups by canonical URL (first visit wins)', () => {
  const snapshots = [
    {
      kind: 'landmark_snapshot',
      t: 1000,
      ts: 1000,
      url: 'https://example.com/dashboard#frag',
      title: 'Dashboard',
      headings: [{ level: 1, text: 'Dashboard' }],
      landmarks: [{ role: 'main', name: null }],
      actions: [], forms: [], nav_items: [],
    },
    {
      kind: 'landmark_snapshot',
      t: 5000,
      ts: 5000,
      url: 'https://example.com/dashboard?utm_source=x',
      title: 'Dashboard v2',
      headings: [{ level: 1, text: 'Dashboard v2' }],
      landmarks: [],
      actions: [], forms: [], nav_items: [],
    },
  ];
  const pages = buildPagesJson(snapshots, []);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].id, 'p1');
  assert.equal(pages[0].title, 'Dashboard');
  assert.equal(pages[0].first_visit_t, 1000);
});

test('buildPagesJson assigns stable p1, p2, p3 ids in visit order', () => {
  const mkSnap = (url, t) => ({
    kind: 'landmark_snapshot',
    t, ts: t, url,
    title: url,
    headings: [], landmarks: [], actions: [], forms: [], nav_items: [],
  });
  const pages = buildPagesJson(
    [
      mkSnap('https://example.com/a', 1000),
      mkSnap('https://example.com/b', 2000),
      mkSnap('https://example.com/a', 3000),
      mkSnap('https://example.com/c', 4000),
    ],
    [],
  );
  assert.deepEqual(pages.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(pages.map((p) => p.url), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
  ]);
});

test('buildPagesJson matches screenshots within 2s window, else null', () => {
  const snapshots = [
    {
      kind: 'landmark_snapshot',
      t: 1000,
      url: 'https://example.com/a',
      title: 'A',
      headings: [], landmarks: [], actions: [], forms: [], nav_items: [],
    },
    {
      kind: 'landmark_snapshot',
      t: 10000,
      url: 'https://example.com/b',
      title: 'B',
      headings: [], landmarks: [], actions: [], forms: [], nav_items: [],
    },
  ];
  const shots = [
    { file: 'screenshots/0000.png', t: 1200 }, // within 2s of p1
    { file: 'screenshots/0001.png', t: 5000 }, // >2s from both
  ];
  const pages = buildPagesJson(snapshots, shots);
  assert.equal(pages[0].screenshot, 'screenshots/0000.png');
  assert.equal(pages[1].screenshot, null);
});

test('network events surface 4xx/5xx only; 2xx skipped', () => {
  const events = [
    { kind: 'network', t: 1000, status: 200, method: 'GET', url: 'https://example.com/ok' },
    { kind: 'network', t: 2000, status: 500, method: 'POST', url: 'https://example.com/api/save' },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.doesNotMatch(out, /net 200/);
  assert.match(out, /00:02 net 500 POST \/api\/save/);
});

test('pages section renders headings/landmarks/actions/forms/screenshot', () => {
  const pages = [
    {
      id: 'p1',
      url: 'https://example.com/home',
      title: 'Home',
      headings: [{ level: 1, text: 'Welcome' }, { level: 2, text: 'Get started' }],
      landmarks: [{ role: 'banner' }, { role: 'main' }, { role: 'contentinfo' }],
      actions: [
        { tag: 'button', role: 'button', name: 'Sign in', locators: [`getByRole('button', { name: 'Sign in' })`] },
      ],
      forms: [
        { name: 'login', fields: [
          { label: 'Email', type: 'email', required: true },
          { label: 'Password', type: 'password', required: true },
          null,
        ] },
        null,
      ],
      nav_items: [],
      screenshot: 'screenshots/0003.png',
      first_visit_t: 500,
    },
  ];
  const out = buildRecapMd({ manifest: manifest(), events: [], pages });
  assert.match(out, /\[p1\] https:\/\/example\.com\/home - "Home"/);
  assert.match(out, /headings: Welcome, Get started/);
  assert.match(out, /landmarks: banner, main, contentinfo/);
  assert.match(out, /actions: button "Sign in" -> getByRole\('button', \{ name: 'Sign in' \}\)/);
  assert.match(out, /forms: "login" \[email:Email \(required\), password:Password \(required\), text:\], "" \[\]/);
  assert.match(out, /screenshot: screenshots\/0003\.png/);
});

test('canonicalUrl strips hash and tracking params', () => {
  assert.equal(
    canonicalUrl('https://example.com/x?utm_source=a&utm_medium=b&keep=1#frag'),
    'https://example.com/x?keep=1',
  );
  assert.equal(canonicalUrl('https://example.com/y'), 'https://example.com/y');
  assert.equal(canonicalUrl('not a url'), 'not a url');
  assert.equal(canonicalUrl(null), '');
});

test('timeline renders idle, timeout, dblclick, key, tab switch, and console variants', () => {
  const events = [
    { kind: 'idle', t: 1000, duration_ms: 1500 },
    { kind: 'idle', t: 3000, duration_ms: 2500 },
    { kind: 'timeout', t: 6000 },
    { kind: 'dblclick', t: 7000, target: locTarget(`getByText('Open')`) },
    { kind: 'click', t: 8000, target: {} },
    { kind: 'key', t: 9000, key: 'Escape' },
    { kind: 'key', t: 10000, key: 'Enter', target: locTarget(`getByLabel('Name')`) },
    { kind: 'key', t: 11000, key: '' },
    { kind: 'tab_switch', t: 12000, toUrl: 'https://example.com/other' },
    { kind: 'console', t: 13000, level: 'warn', args: ['skip me'] },
    { kind: 'console', t: 14000, level: 'error', args: ['boom', 'line\n2'] },
    { kind: 'console', t: 15000, level: 'error', message: 'x'.repeat(130) },
    { kind: 'unknown', t: 16000 },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.doesNotMatch(out, /idle 1\.5s/);
  assert.match(out, /00:03 idle 2\.5s/);
  assert.match(out, /00:06 timeout \(session cap\)/);
  assert.match(out, /00:07 dblclick getByText\('Open'\)/);
  assert.match(out, /00:08 click \(no locator\)/);
  assert.match(out, /00:09 press Escape/);
  assert.match(out, /00:10 press Enter getByLabel\('Name'\)/);
  assert.doesNotMatch(out, /00:11 press/);
  assert.match(out, /00:12 tab_switch -> https:\/\/example\.com\/other/);
  assert.doesNotMatch(out, /console WARN/);
  assert.match(out, /00:14 console ERROR boom line↵2/);
  assert.match(out, /00:15 console ERROR x{120}\.\.\./);
});

test('timeline renders empty fills, change winners, assertions without expected values, and unknown waiting reasons', () => {
  const events = [
    { kind: 'input', t: 1000, value: '', target: locTarget(`getByLabel('Empty')`) },
    { kind: 'input', t: 2000, value: 'draft', target: locTarget(`getByLabel('Status')`) },
    { kind: 'change', t: 3000, value: 'done', target: locTarget(`getByLabel('Status')`) },
    { kind: 'assertion', t: 4000, assertion_kind: 'visible', expected: '', target: {} },
    { kind: 'assertion', t: 5000, assertion_kind: 'count', expected: 0, target: locTarget(`locator('.item')`) },
    { kind: 'assertion', t: 5500, assertion_kind: null, expected: null, target: { css: '#fallback' } },
    { kind: 'waiting_end', t: 6000, duration_ms: 0 },
  ];
  const out = buildRecapMd({ manifest: manifest(), events, pages: [] });
  assert.match(out, /00:01 fill getByLabel\('Empty'\) = ""/);
  assert.match(out, /00:02 fill getByLabel\('Status'\) = "done"/);
  assert.match(out, /00:04 assert visible \(no locator\)/);
  assert.match(out, /00:05 assert count locator\('\.item'\) = "0"/);
  assert.match(out, /00:05 assert unknown locator\("#fallback"\)/);
  assert.match(out, /00:06 waiting 0s \(reasons: unknown\)/);
});

test('pages and page-building tolerate sparse or invalid data', () => {
  const pages = buildPagesJson(
    [
      null,
      { kind: 'click', url: 'https://example.com/nope' },
      {
        kind: 'landmark_snapshot',
        ts: 500,
        url: 'not a url',
        headings: ['Plain heading', { text: 'Object heading' }, { text: '' }],
        landmarks: [{ role: 'main' }, {}, null],
        actions: [{ tag: null, name: null, locators: [] }],
        forms: [{ name: null, fields: [{ type: null, label: null, required: false }] }],
      },
      {
        kind: 'landmark_snapshot',
        t: 1200,
        url: '',
        title: '',
        headings: null,
        landmarks: null,
        actions: null,
        forms: null,
        nav_items: null,
      },
    ],
    [
      null,
      { file: 123, t: 500 },
      { file: 'screenshots/nearest.png', t: 'bad' },
      { file: 'screenshots/good.png', t: 800 },
    ],
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[0].id, 'p1');
  assert.equal(pages[0].first_visit_t, null);
  assert.equal(pages[0].screenshot, 'screenshots/good.png');
  assert.equal(pages[1].title, null);
  assert.deepEqual(pages[1].headings, []);
  assert.equal(pages[1].screenshot, 'screenshots/good.png');

  const out = buildRecapMd({ manifest: manifest(), events: [], pages });
  assert.match(out, /headings: Plain heading, Object heading/);
  assert.match(out, /landmarks: main/);
  assert.match(out, /actions: \? "" ->/);
  assert.match(out, /forms: "" \[text:\]/);
  assert.match(out, /\[p2\] {2}- ""/);
  assert.match(out, /headings: \(none\)/);
});

test('timeline fallback branches render defaults for sparse event data', () => {
  const events = [
    null,
    { kind: 'focus', t: 100 },
    { kind: 'scroll', t: 200 },
    { kind: 'submit', t: 300 },
    { kind: 'waiting_start', t: 400 },
    { kind: 'landmark_snapshot', t: 500 },
    { kind: 'screenshot', t: 600 },
    { kind: 'idle', t: 700 },
    { kind: 'pause', t: -1000 },
    { kind: 'resume', t: 0 },
    { kind: 'marker', t: 1000 },
    { kind: 'note', t: 2000 },
    { kind: 'tab_switch', t: 3000 },
    { kind: 'navigation', t: 4000, from: '', to: '' },
    { kind: 'navigation', t: 5000, from: 'not a url', url: 'also not a url' },
    { kind: 'navigation', t: 5500, from: 'https://example.com', to: 'https://example.com' },
    { kind: 'network', t: 6000, status: 404, url_path: '/known' },
    { kind: 'network', t: 7000, status: 500, url: 'not a url' },
    { kind: 'network', t: 8000, status: 502 },
    { kind: 'network', t: 8500 },
    { kind: 'console', t: 9000, level: 'error', message: 'plain error' },
    { kind: 'console', t: 9500, level: 'error' },
    { kind: 'input', t: 10000, is_masked: true, target: {} },
    { kind: 'input', t: 11000, value: 123, target: locTarget(`getByLabel('Number')`) },
    { kind: 'click', t: 12000, is_masked: true, target: locTarget(`getByText('Masked click')`) },
  ];
  const out = buildRecapMd({ manifest: manifest({ start_url: '' }), events, pages: [] });
  assert.match(out, /00:00 pause/);
  assert.match(out, /00:00 resume \(0s paused\)/);
  assert.match(out, /00:01 marker ""/);
  assert.match(out, /00:02 note ""/);
  assert.match(out, /00:03 tab_switch -> /);
  assert.match(out, /00:04 nav \(start\) -> /);
  assert.match(out, /00:05 nav not a url -> also not a url/);
  assert.match(out, /00:05 nav https:\/\/example\.com -> https:\/\/example\.com/);
  assert.match(out, /00:06 net 404 GET \/known/);
  assert.match(out, /00:07 net 500 GET not a url/);
  assert.match(out, /00:08 net 502 GET /);
  assert.doesNotMatch(out, /net 0/);
  assert.match(out, /00:09 console ERROR plain error/);
  assert.match(out, /00:09 console ERROR\s*$/m);
  assert.match(out, /00:10 fill \(no locator\) = <MASKED length=0>/);
  assert.match(out, /00:11 fill getByLabel\('Number'\) = ""/);
  assert.match(out, /00:10 \(no locator\) length=0 reason=heuristic/);
  assert.doesNotMatch(out, /Masked click.*reason/);
});

test('buildPagesJson handles non-arrays and missing screenshot targets', () => {
  assert.deepEqual(buildPagesJson(null, null), []);
  const pages = buildPagesJson([
    { kind: 'landmark_snapshot', url: 'https://example.com/no-time' },
  ], [{ file: 'screenshots/late.png', t: 1000 }]);
  assert.equal(pages[0].screenshot, null);

  const manualOut = buildRecapMd({
    manifest: manifest(),
    events: [],
    pages: [{ id: 'manual' }],
  });
  assert.match(manualOut, /\[manual\] {2}- ""/);
  assert.match(manualOut, /headings: \(none\)/);
  assert.match(manualOut, /landmarks: \(none\)/);
  assert.match(manualOut, /actions: \(none\)/);
  assert.match(manualOut, /forms: \(none\)/);
  assert.match(manualOut, /screenshot: none/);
});

test('input collapse stops at null and non-input events', () => {
  const nullOut = buildRecapMd({
    manifest: manifest(),
    events: [
      { kind: 'input', t: 1000, value: 'a', target: locTarget(`getByLabel('A')`) },
      null,
      { kind: 'input', t: 2000, value: 'b', target: locTarget(`getByLabel('A')`) },
    ],
    pages: [],
  });
  assert.match(nullOut, /00:01 fill getByLabel\('A'\) = "a"/);
  assert.match(nullOut, /00:02 fill getByLabel\('A'\) = "b"/);

  const breakOut = buildRecapMd({
    manifest: manifest(),
    events: [
      { kind: 'input', t: 1000, value: 'a', target: locTarget(`getByLabel('A')`) },
      { kind: 'click', t: 1500, target: locTarget(`getByText('Stop')`) },
      { kind: 'input', t: 2000, value: 'b', target: locTarget(`getByLabel('A')`) },
    ],
    pages: [],
  });
  assert.match(breakOut, /00:01 fill getByLabel\('A'\) = "a"/);
  assert.match(breakOut, /00:01 click getByText\('Stop'\)/);
  assert.match(breakOut, /00:02 fill getByLabel\('A'\) = "b"/);
});
