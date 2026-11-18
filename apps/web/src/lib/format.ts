import { useMemo } from 'react';
import { formatAge } from '@natija/domain';
import { useAuth } from './auth';
import { useLang } from './i18n';

const CURRENCY_LABEL: Record<string, { ar: string; en: string }> = {
  SYP: { ar: 'ل.س', en: 'SYP' },
  USD: { ar: '$', en: 'USD' },
};

/**
 * Formatting that follows the language and the lab's settings (digits, time zone, currency).
 * Use it everywhere instead of toFixed/toLocaleString.
 */
export function useFormat() {
  const lang = useLang();
  const { me } = useAuth();
  const digits = (me?.lab.settings?.digits as string | undefined) ?? 'latin';
  const timeZone = me?.lab.timezone ?? 'Asia/Damascus';
  const currency = me?.lab.currency ?? 'SYP';

  return useMemo(() => {
    const locale = lang === 'ar' ? (digits === 'arabic' ? 'ar-SY' : 'ar-SY-u-nu-latn') : 'en-GB';
    const nf = (min: number, max: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));
    const dateFmt = new Intl.DateTimeFormat(locale, { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeFmt = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
    const dateTimeFmt = new Intl.DateTimeFormat(locale, { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const shortDayFmt = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short' });
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

    return {
      locale,
      timeZone,
      currency,
      currencyLabel: (cur = currency) => CURRENCY_LABEL[cur]?.[lang] ?? cur,
      number: (v: number | null | undefined, decimals?: number) =>
        v === null || v === undefined || Number.isNaN(v) ? '—' : decimals === undefined ? nf(0, 3).format(v) : nf(decimals, decimals).format(v),
      money: (v: number | null | undefined, cur = currency) => {
        if (v === null || v === undefined || Number.isNaN(v)) return '—';
        const amount = cur === 'SYP' ? nf(0, 0).format(Math.round(v)) : nf(2, 2).format(v);
        return `${amount} ${CURRENCY_LABEL[cur]?.[lang] ?? cur}`;
      },
      percent: (v: number | null | undefined, decimals = 0) => (v === null || v === undefined ? '—' : `${nf(0, decimals).format(v)}%`),
      date: (d: Date | string | number | null | undefined) => (d ? dateFmt.format(toDate(d)) : '—'),
      time: (d: Date | string | number | null | undefined) => (d ? timeFmt.format(toDate(d)) : '—'),
      dateTime: (d: Date | string | number | null | undefined) => (d ? dateTimeFmt.format(toDate(d)) : '—'),
      shortDay: (d: Date | string | number) => shortDayFmt.format(toDate(d)),
      relative: (d: Date | string | number | null | undefined) => {
        if (!d) return '—';
        const diff = (toDate(d).getTime() - Date.now()) / 1000;
        const abs = Math.abs(diff);
        if (abs < 60) return rtf.format(Math.round(diff), 'second');
        if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
        return rtf.format(Math.round(diff / 86400), 'day');
      },
      /** Minutes between two instants, e.g. waiting time or turnaround. */
      minutesBetween: (a: Date | string, b: Date | string = new Date()) => Math.max(0, Math.round((toDate(b).getTime() - toDate(a).getTime()) / 60000)),
      duration: (minutes: number | null | undefined) => {
        if (minutes === null || minutes === undefined) return '—';
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        if (lang === 'ar') return h ? `${h} س ${m} د` : `${m} د`;
        return h ? `${h}h ${m}m` : `${m}m`;
      },
      age: (birthDate: string | null | undefined) => (birthDate ? formatAge(birthDate, lang) : '—'),
      /** Today's calendar date (YYYY-MM-DD) in the lab's time zone. */
      today: () => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()),
    };
  }, [lang, digits, timeZone, currency]);
}
