import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsLabProfile } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { adminKeys } from '../../api';

export function useLabProfile() {
  return useQuery({ queryKey: adminKeys.lab, queryFn: () => api.get<SettingsLabProfile>('/settings/lab') });
}

/** After a lab save: keep the fresh profile and reload the session so colour, digits and logo update everywhere. */
export function useLabSaved() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useCallback(
    async (profile?: SettingsLabProfile) => {
      if (profile) qc.setQueryData(adminKeys.lab, profile);
      else await qc.invalidateQueries({ queryKey: adminKeys.lab });
      await refresh();
    },
    [qc, refresh],
  );
}

/** Black or white text, whichever reads better on a #RRGGBB background. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = Number.parseInt(m[1]!, 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return lum > 0.45 ? '#121620' : '#ffffff';
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const TIMEZONES = [
  'Asia/Damascus',
  'Asia/Beirut',
  'Asia/Amman',
  'Asia/Baghdad',
  'Europe/Istanbul',
  'Asia/Riyadh',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Dubai',
  'Africa/Cairo',
  'Europe/Berlin',
  'Europe/London',
  'UTC',
];

export function tzOffset(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

export const CURRENCIES = ['SYP', 'USD', 'EUR'];
