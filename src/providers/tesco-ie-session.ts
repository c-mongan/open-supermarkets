/**
 * Tesco Ireland — imported browser session.
 *
 * tesco.ie has no scripted login (Akamai). The user signs in at www.tesco.ie in
 * a normal browser and imports the Cookie header of a www.tesco.ie request with
 * `supermarket --provider tesco-ie import-session --stdin`.
 *
 * Only `OAuth.AccessToken` and `UUID` are stored: they are all xapi needs (sent
 * as `authorization: Bearer …` and `customer-uuid`), so the refresh token and the
 * Akamai cookies never leave the browser. The session expires with the access
 * token's JWT `exp`, about an hour after the page last refreshed it.
 */

import { createTescoSessionStore, type TescoSessionConfig } from './tesco-session';

export const TESCO_IE_SESSION_CONFIG: TescoSessionConfig = {
  dirName: '.tesco-ie',
  cookieDomain: '.tesco.ie',
  requestHost: 'www.tesco.ie',
  keepCookie: (name) => name === 'OAuth.AccessToken' || name === 'UUID',
  tokenCookie: 'OAuth.AccessToken',
  fallbackTtlMs: 60 * 60 * 1000,
};

export const TESCO_IE_SESSION = createTescoSessionStore(TESCO_IE_SESSION_CONFIG);
