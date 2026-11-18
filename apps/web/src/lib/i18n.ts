import i18n from 'i18next';
import { useCallback } from 'react';
import { initReactI18next, useTranslation } from 'react-i18next';
import { safeStorage } from './utils';

/**
 * Translations live in src/locales/<lang>/<namespace>.json. Every file found is loaded:
 * common.json is the default namespace; features use their own (frontdesk, bench, instruments, admin).
 * Arabic plural keys follow i18next: key_zero, key_one, key_two, key_few, key_many, key_other.
 */
const files = import.meta.glob('../locales/*/*.json', { eager: true }) as Record<string, { default: Record<string, unknown> }>;
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, mod] of Object.entries(files)) {
  const match = /locales\/(\w+)\/([\w-]+)\.json$/.exec(path);
  if (!match) continue;
  const [, lng, ns] = match as unknown as [string, string, string];
  (resources[lng] ??= {})[ns] = mod.default;
}

export type Lang = 'ar' | 'en';
const LANG_KEY = 'natija.lang';
const stored = safeStorage().get(LANG_KEY);
const initial: Lang = stored === 'en' || stored === 'ar' ? stored : 'ar';

void i18n.use(initReactI18next).init({
  resources,
  lng: initial,
  fallbackLng: 'en',
  defaultNS: 'common',
  fallbackNS: 'common',
  ns: Object.keys(resources.en ?? {}),
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function applyLanguage(lng: Lang) {
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
  document.documentElement.dir = lng === 'ar' ? 'rtl' : 'ltr';
  safeStorage().set(LANG_KEY, lng);
}
applyLanguage(initial);

export function useLang(): Lang {
  const { i18n: instance } = useTranslation();
  return instance.language === 'en' ? 'en' : 'ar';
}

/** Pick the Arabic or English field of a bilingual row: bi(test, 'name') → test.nameAr / test.nameEn. */
export function useBi() {
  const lang = useLang();
  return useCallback(
    (row: object | null | undefined, field = 'name'): string => {
      if (!row) return '';
      const r = row as Record<string, unknown>;
      const ar = r[`${field}Ar`] as string | null | undefined;
      const en = r[`${field}En`] as string | null | undefined;
      return (lang === 'ar' ? ar || en : en || ar) ?? '';
    },
    [lang],
  );
}

export default i18n;
