import { useEffect, useState } from 'react';
import { safeStorage } from '@/lib/utils';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'natija.theme';

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function initTheme() {
  const stored = safeStorage().get(KEY) as ThemeChoice | null;
  apply(stored ?? 'light');
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => (safeStorage().get(KEY) as ThemeChoice | null) ?? 'light');
  useEffect(() => {
    apply(choice);
    safeStorage().set(KEY, choice);
    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);
  return [choice, setChoice];
}
