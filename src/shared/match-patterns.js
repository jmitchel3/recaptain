// Pure match-pattern utilities shared by the allowlist and denylist. No
// `chrome.*` here so the module stays unit-testable and importable from any
// context. Accepts a friendly short form and canonicalizes to a Chrome match
// pattern for `registerContentScripts`'s `excludeMatches`.
//
// Short form rules (see ACCESS-MODEL.md):
//   - no scheme  -> assume `*://` (matches http and https; `*` covers only
//     those, which is all that is recordable)
//   - no path    -> assume `/*`, so a bare host covers the whole domain
//   - subdomains stay explicit: `*.okta.com/*` for "any subdomain"
//   - a scheme can be pinned: `https://only-secure.example.com/*`
//
// Examples:
//   checkout.stripe.com/*  -> *://checkout.stripe.com/*
//   *.okta.com             -> *://*.okta.com/*
//   github.com/login*      -> *://github.com/login*

const SCHEME_RE = /^(\*|[a-z][a-z0-9+.-]*):\/\//i;

function parse(input) {
  if (typeof input !== 'string') throw new Error('pattern must be a string');
  let rest = input.trim();
  if (!rest) throw new Error('empty pattern');

  let scheme = '*';
  const m = rest.match(SCHEME_RE);
  if (m) { scheme = m[1].toLowerCase(); rest = rest.slice(m[0].length); }

  const slash = rest.indexOf('/');
  let host, path;
  if (slash === -1) { host = rest; path = '/*'; }
  else { host = rest.slice(0, slash); path = rest.slice(slash) || '/*'; }

  host = host.toLowerCase();
  if (!host) throw new Error(`missing host in "${input}"`);
  validateHost(host, input);
  return { scheme, host, path };
}

function validateHost(host, input) {
  if (host === '*') return;
  let h = host;
  if (h.startsWith('*.')) h = h.slice(2);
  if (h.includes('*')) throw new Error(`invalid host wildcard in "${input}" (only a leading "*." is allowed)`);
  if (!h || !/^[a-z0-9.-]+$/.test(h)) throw new Error(`invalid host in "${input}"`);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function schemeRe(scheme) { return scheme === '*' ? 'https?' : escapeRe(scheme); }

function hostRe(host) {
  if (host === '*') return '[^/]+';
  if (host.startsWith('*.')) return `(?:[^/.]+\\.)*${escapeRe(host.slice(2))}`;
  return escapeRe(host);
}

// A `*` in the path matches any run of characters; everything else is literal.
function pathRe(path) { return path.split('*').map(escapeRe).join('.*'); }

// Canonical Chrome match pattern (what excludeMatches wants).
export function canonicalize(input) {
  const { scheme, host, path } = parse(input);
  return `${scheme}://${host}${path}`;
}

export function isValidPattern(input) {
  try { canonicalize(input); return true; } catch { return false; }
}

// Compile one friendly pattern to an anchored RegExp over `scheme://host/path`.
export function compilePattern(input) {
  const { scheme, host, path } = parse(input);
  return new RegExp(`^${schemeRe(scheme)}://${hostRe(host)}${pathRe(path)}$`, 'i');
}

// Compile a list into a single tester. Invalid patterns are skipped so a bad
// entry never throws at match time (callers validate on input).
export function compileMatcher(patterns) {
  const res = [];
  for (const p of patterns || []) {
    try { res.push(compilePattern(p)); } catch { /* skip invalid */ }
  }
  return (url) => {
    let target;
    try {
      const u = new URL(url);
      target = `${u.protocol.replace(/:$/, '')}://${u.hostname}${u.pathname}`;
    } catch { return false; }
    return res.some((re) => re.test(target));
  };
}

export function matchesAny(url, patterns) {
  return compileMatcher(patterns)(url);
}
