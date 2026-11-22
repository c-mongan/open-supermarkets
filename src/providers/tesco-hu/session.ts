/**
 * Tesco Hungary — cookie session store.
 *
 * bevasarlas.tesco.hu sits behind Akamai and its login lives on www.tesco.hu, so
 * there is no scripted login here. The user signs in with a normal browser and
 * imports the resulting cookies — see ../tesco-session.ts.
 *
 * Stored at ~/.tesco-hu/session.json. Deliberately a different file from the UK
 * provider's ~/.tesco/session.json so the two never overwrite each other. Every
 * imported cookie is kept, and expiry comes from the cookies' own dates with a
 * 12 hour fallback.
 */

import { createTescoSessionStore } from '../tesco-session';

const store = createTescoSessionStore({
  dirName: '.tesco-hu',
  cookieDomain: '.tesco.hu',
  requestHost: 'bevasarlas.tesco.hu',
});

export const SESSION_FILE = store.sessionFile;
export const {
  parseCookieHeader,
  normaliseCookieExport,
  saveSession,
  loadSession,
  getSessionInfo,
  clearSession,
  getCookieString,
  importSessionFromHeader,
  importSession,
} = store;
