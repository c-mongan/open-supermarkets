'use strict';

// The shared Tesco cookie-session store: Hungary keeps its exact behaviour,
// Ireland keeps only the access token and expires with it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createTescoSessionStore, jwtExpiryMs } = require('../src/providers/tesco-session.ts');
const { TESCO_IE_SESSION, TESCO_IE_SESSION_CONFIG } = require('../src/providers/tesco-ie-session.ts');
const huSession = require('../src/providers/tesco-hu/session.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-session-test-'));
const jwt = (exp) => ['{"alg":"none"}', JSON.stringify({ exp })].map((s) => Buffer.from(s).toString('base64url')).join('.') + '.sig';

test('Hungary: same file, every cookie kept, cookie-date expiry with a 12 hour fallback', () => {
  assert.equal(huSession.SESSION_FILE, path.join(os.homedir(), '.tesco-hu', 'session.json'));
  const file = path.join(tmp(), 'session.json');
  const before = Date.now();
  const session = huSession.importSessionFromHeader('OAuth.AccessToken=abc; _abck=x; other=y', file);
  assert.deepEqual(session.cookies.map((c) => c.name), ['OAuth.AccessToken', '_abck', 'other']);
  assert.ok(session.cookies.every((c) => c.domain === '.tesco.hu'));
  const ttl = Date.parse(session.expiresAt) - before;
  assert.ok(ttl > 11.9 * 3600_000 && ttl <= 12 * 3600_000 + 1000, `12h fallback, got ${ttl}`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => huSession.parseCookieHeader('nothing'), /pick a bevasarlas\.tesco\.hu request/);
});

test('Ireland: only the access token and UUID are stored, and the JWT exp is the expiry', () => {
  const store = createTescoSessionStore({ ...TESCO_IE_SESSION_CONFIG, homeDir: tmp() });
  const exp = Math.floor(Date.now() / 1000) + 3000;
  const token = jwt(exp);
  const session = store.importSessionFromHeader(
    `Cookie: OAuth.AccessToken=${token}; OAuth.RefreshToken=secret; UUID=u-1; _abck=akamai; bm_sv=x`);
  assert.deepEqual(session.cookies.map((c) => c.name), ['OAuth.AccessToken', 'UUID']);
  assert.equal(session.expiresAt, new Date(exp * 1000).toISOString());
  assert.equal(store.sessionFile.endsWith(path.join('.tesco-ie', 'session.json')), true);
  assert.doesNotMatch(fs.readFileSync(store.sessionFile, 'utf8'), /secret|akamai/);
  assert.equal(store.loadSession().cookies[0].value, token);
});

test('Ireland: a header without the access token, or with an expired one, is refused and nothing is saved', () => {
  const store = createTescoSessionStore({ ...TESCO_IE_SESSION_CONFIG, homeDir: tmp() });
  assert.throws(() => store.importSessionFromHeader('UUID=u-1; _abck=x'), /No OAuth\.AccessToken cookie/);
  assert.throws(() => store.importSessionFromHeader(`OAuth.AccessToken=${jwt(1)}; UUID=u`), /expired at 1970/);
  assert.equal(fs.existsSync(store.sessionFile), false);
});

test('Ireland: an expired saved session loads as none', () => {
  const store = createTescoSessionStore({ ...TESCO_IE_SESSION_CONFIG, homeDir: tmp() });
  store.saveSession({ cookies: [], expiresAt: new Date(Date.now() - 1000).toISOString(), lastLogin: '' });
  assert.equal(store.loadSession(), null);
  assert.equal(store.getSessionInfo().expired, true);
});

test('the default Irish store lives in ~/.tesco-ie', () => {
  assert.equal(TESCO_IE_SESSION.sessionFile, path.join(os.homedir(), '.tesco-ie', 'session.json'));
});

test('jwtExpiryMs reads exp and ignores non-JWTs', () => {
  assert.equal(jwtExpiryMs(jwt(1700000000)), 1700000000 * 1000);
  assert.equal(jwtExpiryMs('opaque'), undefined);
  assert.equal(jwtExpiryMs('a.b.c'), undefined);
});
