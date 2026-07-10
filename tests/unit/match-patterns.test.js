import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  isValidPattern,
  compilePattern,
  compileMatcher,
  matchesAny,
} from '../../src/shared/match-patterns.js';

test('canonicalize assumes scheme and path from the short form', () => {
  assert.equal(canonicalize('checkout.stripe.com/*'), '*://checkout.stripe.com/*');
  assert.equal(canonicalize('checkout.stripe.com'), '*://checkout.stripe.com/*');
  assert.equal(canonicalize('*.okta.com'), '*://*.okta.com/*');
});

test('canonicalize keeps an explicit scheme and path', () => {
  assert.equal(canonicalize('https://only-secure.example.com/*'), 'https://only-secure.example.com/*');
  assert.equal(canonicalize('github.com/login*'), '*://github.com/login*');
});

test('canonicalize lowercases the host', () => {
  assert.equal(canonicalize('Accounts.Google.COM/*'), '*://accounts.google.com/*');
});

test('bare host matches any path (implicit /*)', () => {
  const re = compilePattern('checkout.stripe.com');
  assert.ok(re.test('https://checkout.stripe.com/'));
  assert.ok(re.test('https://checkout.stripe.com/pay/123'));
});

test('omitted scheme matches http and https but not ftp', () => {
  const re = compilePattern('app.example.com/*');
  assert.ok(re.test('http://app.example.com/x'));
  assert.ok(re.test('https://app.example.com/x'));
  assert.ok(!re.test('ftp://app.example.com/x'));
});

test('a pinned scheme excludes the other', () => {
  const re = compilePattern('https://app.example.com/*');
  assert.ok(re.test('https://app.example.com/x'));
  assert.ok(!re.test('http://app.example.com/x'));
});

test('*.host matches the apex and any subdomain, and rejects spoofs', () => {
  const m = compileMatcher(['*.okta.com/*']);
  assert.ok(m('https://okta.com/app'));
  assert.ok(m('https://acme.okta.com/app'));
  assert.ok(m('https://a.b.okta.com/app'));
  assert.ok(!m('https://notokta.com/app'));
  assert.ok(!m('https://evilokta.com/app'));
  assert.ok(!m('https://okta.com.evil.com/app'));
});

test('exact host does not match subdomains', () => {
  const m = compileMatcher(['id.atlassian.com/*']);
  assert.ok(m('https://id.atlassian.com/login'));
  assert.ok(!m('https://other.atlassian.com/login'));
});

test('path wildcard vs exact path', () => {
  const wild = compileMatcher(['github.com/login*']);
  assert.ok(wild('https://github.com/login'));
  assert.ok(wild('https://github.com/login/oauth'));
  assert.ok(!wild('https://github.com/dashboard'));

  const exact = compileMatcher(['github.com/session']);
  assert.ok(exact('https://github.com/session'));
  assert.ok(!exact('https://github.com/session/new'));
});

test('matcher ignores the port and query string (path only)', () => {
  const m = compileMatcher(['app.example.com/admin*']);
  assert.ok(m('http://app.example.com:8080/admin'));
  assert.ok(m('https://app.example.com/admin?x=1'));
  assert.ok(!m('https://app.example.com/public'));
});

test('compileMatcher skips invalid patterns instead of throwing', () => {
  const m = compileMatcher(['', 'good.example.com/*', 'ht tp://bad', null]);
  assert.ok(m('https://good.example.com/x'));
  assert.ok(!m('https://elsewhere.example.com/x'));
});

test('compileMatcher returns false for unparseable urls', () => {
  const m = compileMatcher(['*.okta.com/*']);
  assert.ok(!m('not a url'));
  assert.ok(!m('chrome://extensions'));
});

test('matchesAny is the list convenience form', () => {
  assert.ok(matchesAny('https://accounts.google.com/o/oauth2', ['accounts.google.com/*']));
  assert.ok(!matchesAny('https://example.com/', ['accounts.google.com/*']));
});

test('isValidPattern accepts short forms and rejects junk', () => {
  for (const ok of ['a.com', 'a.com/*', '*.a.com/*', 'https://a.com/x*', 'ftp://a.com/']) {
    assert.ok(isValidPattern(ok), `expected valid: ${ok}`);
  }
  for (const bad of ['', '   ', 'ht*tp://a.com', 'a*b.com/*', '/*', 42]) {
    assert.ok(!isValidPattern(bad), `expected invalid: ${JSON.stringify(bad)}`);
  }
});
