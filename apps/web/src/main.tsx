import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/index.css';
import './lib/i18n';
import { initTheme } from './components/layout/theme';
import { loadMock, MOCK } from './lib/mode';
import { App } from './app/App';

initTheme();

const rootEl = document.getElementById('root')!;

/** Mock mode: load the demo data kept in this browser, or create it the first time (a few seconds). */
async function prepareMock(): Promise<void> {
  const ar = (document.documentElement.lang || 'ar') === 'ar';
  rootEl.innerHTML = `<div class="grid min-h-screen place-items-center bg-paper p-6 text-center text-ink-2"><div><div class="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-line-strong border-t-accent"></div><p class="text-sm">${
    ar ? 'جارٍ تجهيز بيانات العرض…' : 'Preparing the demo data…'
  }</p><p class="mt-1 text-xs text-muted">${ar ? 'يحدث هذا مرة واحدة في هذا المتصفح.' : 'This happens once in this browser.'}</p></div></div>`;
  const mock = await loadMock();
  await mock.bootMock();
  rootEl.innerHTML = '';
}

async function start(): Promise<void> {
  if (MOCK) await prepareMock();
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
