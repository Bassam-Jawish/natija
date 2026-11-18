/**
 * Printing: print pages live under /print/* with their own page size (A4 report, 50×25 mm labels,
 * 80 mm receipts). openPrint() opens one in a new tab with ?autoprint=1; the page calls
 * usePrintWhenReady(ready) to open the browser's print dialog once its data has loaded.
 * Silent printing to a chosen printer goes through the Lab Agent's print bridge (see docs).
 */
import { useEffect } from 'react';
import { appUrl, MOCK, persistMock } from './mode';

export function openPrint(path: string) {
  const url = appUrl(`${path}${path.includes('?') ? '&' : '?'}autoprint=1`);
  if (!MOCK) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  // Mock mode: the new tab reads the data saved in this browser, so save the latest changes first.
  const win = window.open('about:blank', '_blank');
  void persistMock().then(() => {
    if (win) win.location.href = new URL(url, window.location.href).href;
    else window.open(url, '_blank', 'noopener');
  });
}

export function usePrintWhenReady(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const asked = new URLSearchParams(window.location.search).has('autoprint') || window.location.hash.includes('autoprint=1');
    if (!asked) return;
    const id = setTimeout(() => window.print(), 400);
    return () => clearTimeout(id);
  }, [ready]);
}
