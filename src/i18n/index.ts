// Tiny typed i18n: English is the source of truth for keys; other languages must provide every key.
// Language precedence: ?lang= > saved choice > browser language > server default.

import type { Localized } from '../../shared/roomConfig.ts';
import { localize } from '../../shared/roomConfig.ts';
import { en, type MessageKey } from './en.ts';
import { ja } from './ja.ts';

export type Lang = 'en' | 'ja';
export const LANGUAGES: readonly Lang[] = ['en', 'ja'];
const DICTS: Record<Lang, Record<MessageKey, string>> = { en, ja };
const STORAGE_KEY = 'colo.lang';

let current: Lang = 'en';

export function detectLanguage(serverDefault: Lang): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl && LANGUAGES.includes(fromUrl as Lang)) return fromUrl as Lang;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.includes(saved as Lang)) return saved as Lang;
  } catch {
    // storage may be unavailable (private mode)
  }
  const nav = navigator.language?.slice(0, 2);
  if (nav && LANGUAGES.includes(nav as Lang)) return nav as Lang;
  return serverDefault;
}

export function setLanguage(lang: Lang, persist = false): void {
  current = lang;
  document.documentElement.lang = lang;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore
    }
  }
}

export function getLanguage(): Lang {
  return current;
}

/** Translate a key; `{name}` placeholders are replaced from params. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = DICTS[current][key] ?? en[key];
  return params ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : text;
}

/** Pick the current language from a config-provided localized string. */
export function tl(text: Localized | null | undefined, fallback = ''): string {
  return localize(text ?? undefined, current, fallback);
}

export type { MessageKey };
