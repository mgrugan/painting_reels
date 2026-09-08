/**
 * Settings persistence.
 *
 * Everything here is browser-local. The API key is deliberately kept apart from
 * the rest: it lives in memory for the session, and only reaches localStorage if
 * the user ticks "Remember on this device".
 */

const SETTINGS_KEY = 'painting-reels.settings';
const API_KEY_KEY = 'painting-reels.apiKey';

export const DEFAULTS = {
  model: 'claude-opus-5',
  effort: 'high',
  voice: 'plain',
  beats: 11,
  secs: 7.5,
  strictFacts: true,
  res: '720',
  fps: '30',
  motion: 12,
  showTitleCard: true,
  fontFamily: '700 %spx "Helvetica Neue", Helvetica, Arial, sans-serif',
  fontSize: 52,
  capPos: 'auto',
  watermark: '@explainingpaintings',
  musicVol: 35,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode, quota — not worth interrupting the user over */
  }
}

/** Returns the remembered key, or '' when the user chose not to store one. */
export function loadApiKey() {
  try {
    return localStorage.getItem(API_KEY_KEY) || '';
  } catch {
    return '';
  }
}

export function rememberApiKey(key) {
  try {
    localStorage.setItem(API_KEY_KEY, key);
  } catch {
    /* ignore */
  }
}

export function forgetApiKey() {
  try {
    localStorage.removeItem(API_KEY_KEY);
  } catch {
    /* ignore */
  }
}
