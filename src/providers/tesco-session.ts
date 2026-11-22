/**
 * Cookie session store shared by the Tesco xapi storefronts that have no
 * scripted login (Hungary, Ireland).
 *
 * The storefronts sit behind Akamai, so the user signs in with a normal browser
 * and imports the resulting cookies: a raw `Cookie:` request header copied from
 * DevTools → Network (the one route that always works and includes HttpOnly
 * cookies), or a cookie JSON export from Chrome DevTools / Cookie-Editor /
 * Playwright.
 *
 * Each storefront binds its own store (directory, cookie domain, which cookies to
 * keep, how expiry is read) so two markets never overwrite each other. This
 * module has no network code and imports nothing from ../tesco/ (that module
 * loads Playwright at import time).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { asRecord } from './ie/shared';

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_COOKIE_RE = /(auth|oauth|token|session|sid|sso|identity|access|refresh|jwt|tesco)/i;

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds, or -1 when unknown. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface TescoCookieSession {
  cookies: SessionCookie[];
  expiresAt: string;
  lastLogin: string;
}

export interface TescoSessionInfo {
  exists: boolean;
  path: string;
  expired: boolean;
  expiresAt?: string;
  lastLogin?: string;
  cookieCount?: number;
}

export interface TescoSessionConfig {
  /** Directory under the home directory, e.g. ".tesco-hu". */
  dirName: string;
  /** Domain stamped on cookies parsed from a header, e.g. ".tesco.hu". */
  cookieDomain: string;
  /** Storefront host named in the help text, e.g. "bevasarlas.tesco.hu". */
  requestHost: string;
  /** Cookies to store. Default: every cookie the user imported. */
  keepCookie?: (name: string) => boolean;
  /**
   * Cookie holding a JWT access token. When set, the session must contain it
   * and expires when the token does; cookie expiry dates are not consulted.
   */
  tokenCookie?: string;
  /** Lifetime when nothing better is known. Default 12 hours. */
  fallbackTtlMs?: number;
  /** Injectable for tests. Default `os.homedir()`. */
  homeDir?: string;
}

function cookieExpiryMs(cookie: { expires?: unknown; expirationDate?: unknown }): number | null {
  const raw = cookie?.expires ?? cookie?.expirationDate;
  if (raw === undefined || raw === null || raw === -1 || raw === 0) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Playwright and Chrome exports use seconds; tolerate millisecond exports too.
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

/**
 * Earliest expiry among auth-looking cookies that is at least a minute away;
 * otherwise a 12 hour fallback. `now` is injectable for tests.
 */
export function inferSessionExpiry(
  cookies: Array<{ name?: string; expires?: number; expirationDate?: number }>,
  now: number = Date.now(),
  fallbackMs: number = DEFAULT_SESSION_TTL_MS
): string {
  const authExpiries = cookies
    .filter(c => AUTH_COOKIE_RE.test(String(c?.name || '')))
    .map(cookieExpiryMs)
    .filter((e): e is number => !!e && e > now + 60_000)
    .sort((a, b) => a - b);
  if (authExpiries.length > 0) return new Date(authExpiries[0]).toISOString();
  return new Date(now + fallbackMs).toISOString();
}

/** `exp` of a JWT in epoch ms, or undefined when the value is not a readable JWT. */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** One storefront's session file and the operations on it. */
export interface TescoSessionStore {
  configDir: string;
  sessionFile: string;
  parseCookieHeader(header: string): SessionCookie[];
  normaliseCookieExport(raw: unknown): SessionCookie[];
  saveSession(session: TescoCookieSession, file?: string): void;
  loadSession(file?: string): TescoCookieSession | null;
  getSessionInfo(file?: string): TescoSessionInfo;
  clearSession(file?: string): void;
  getCookieString(session: TescoCookieSession): string;
  importSessionFromHeader(header: string, file?: string): TescoCookieSession;
  importSession(filePath: string, file?: string): TescoCookieSession;
}

export function createTescoSessionStore(config: TescoSessionConfig): TescoSessionStore {
  const configDir = path.join(config.homeDir ?? os.homedir(), config.dirName);
  const sessionFile = path.join(configDir, 'session.json');
  const keep = config.keepCookie ?? (() => true);
  const fallbackMs = config.fallbackTtlMs ?? DEFAULT_SESSION_TTL_MS;

  /** Parse a raw `Cookie:` request header. Values legitimately contain '='. */
  function parseCookieHeader(header: string): SessionCookie[] {
    const cleaned = String(header ?? '')
      .trim()
      .replace(/^Cookie:\s*/i, '')
      .replace(/^["']|["']$/g, '');

    const cookies = cleaned
      .split(';')
      .map(pair => pair.trim())
      .filter(Boolean)
      .map((pair): SessionCookie | null => {
        const eq = pair.indexOf('=');
        if (eq === -1) return null;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!name || !value) return null;
        return { name, value, domain: config.cookieDomain, path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' };
      })
      .filter((c): c is SessionCookie => c !== null);

    if (cookies.length === 0) {
      throw new Error(
        'No cookies parsed from that header.\n' +
          'Expected something like: name=value; name2=value2; ...\n' +
          `In DevTools → Network, pick a ${config.requestHost} request, then Request Headers → Cookie.`
      );
    }
    return cookies;
  }

  /**
   * Normalise a cookie JSON export. Chrome DevTools exports an array; Cookie-Editor
   * exports an array with Capitalised keys or `{ [domain]: cookie[] }`; Playwright
   * storage_state wraps everything in `{ cookies: [...] }`.
   */
  function normaliseCookieExport(raw: unknown): SessionCookie[] {
    const wrapper = asRecord(raw);
    const list: unknown[] = Array.isArray(raw) ? raw
      : Array.isArray(wrapper.cookies) ? wrapper.cookies
      : Object.values(wrapper).flat();

    const cookies = list
      .map((entry): SessionCookie => {
        const c = asRecord(entry);
        return {
          name: (c.name ?? c.Name) as string,
          value: (c.value ?? c.Value) as string,
          domain: (c.domain ?? c.Domain ?? config.cookieDomain) as string,
          path: (c.path ?? c.Path ?? '/') as string,
          expires: Number(c.expirationDate ?? c.expires ?? -1),
          httpOnly: Boolean(c.httpOnly ?? c.HttpOnly ?? false),
          secure: Boolean(c.secure ?? c.Secure ?? false),
          sameSite: String(c.sameSite ?? c.SameSite ?? 'Lax'),
        };
      })
      .filter(c => c.name && c.value);

    if (cookies.length === 0) {
      throw new Error('No usable cookies found in the file. Check the export includes name/value fields.');
    }
    return cookies;
  }

  function saveSession(session: TescoCookieSession, file: string = sessionFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  /** Null when there is no session or it has expired. Callers decide what to say. */
  function loadSession(file: string = sessionFile): TescoCookieSession | null {
    if (!fs.existsSync(file)) return null;
    const session: TescoCookieSession = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (new Date(session.expiresAt) < new Date()) return null;
    return session;
  }

  function getSessionInfo(file: string = sessionFile): TescoSessionInfo {
    if (!fs.existsSync(file)) return { exists: false, path: file, expired: true };
    const session: TescoCookieSession = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      exists: true,
      path: file,
      expired: new Date(session.expiresAt) < new Date(),
      expiresAt: session.expiresAt,
      lastLogin: session.lastLogin,
      cookieCount: session.cookies?.length ?? 0,
    };
  }

  function clearSession(file: string = sessionFile): void {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  function getCookieString(session: TescoCookieSession): string {
    return session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  function sessionFrom(imported: SessionCookie[], now: number = Date.now()): TescoCookieSession {
    const cookies = imported.filter(c => keep(c.name));
    let expiresAt: string;
    if (config.tokenCookie) {
      const token = cookies.find(c => c.name === config.tokenCookie)?.value;
      if (!token) {
        throw new Error(
          `No ${config.tokenCookie} cookie in what was imported, so there is no signed-in session to save. ` +
            `Sign in on ${config.requestHost}, then copy the Cookie header of a ${config.requestHost} request.`
        );
      }
      const exp = jwtExpiryMs(token);
      if (exp !== undefined && exp <= now) {
        throw new Error(
          `That ${config.tokenCookie} expired at ${new Date(exp).toISOString()}. ` +
            `Reload ${config.requestHost} while signed in and copy a fresh Cookie header.`
        );
      }
      expiresAt = new Date(exp ?? now + fallbackMs).toISOString();
    } else {
      expiresAt = inferSessionExpiry(cookies, now, fallbackMs);
    }
    return { cookies, expiresAt, lastLogin: new Date(now).toISOString() };
  }

  function importSessionFromHeader(header: string, file: string = sessionFile): TescoCookieSession {
    const session = sessionFrom(parseCookieHeader(header));
    saveSession(session, file);
    return session;
  }

  function importSession(filePath: string, file: string = sessionFile): TescoCookieSession {
    const resolved = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`Cookie file not found: ${resolved}`);
    const session = sessionFrom(normaliseCookieExport(JSON.parse(fs.readFileSync(resolved, 'utf-8'))));
    saveSession(session, file);
    return session;
  }

  return {
    configDir,
    sessionFile,
    parseCookieHeader,
    normaliseCookieExport,
    saveSession,
    loadSession,
    getSessionInfo,
    clearSession,
    getCookieString,
    importSessionFromHeader,
    importSession,
  };
}
