// pnpm build:offline — build the mock-mode app into ONE html file (dist-offline/natija-demo.html):
// scripts, styles and fonts are inlined, routes use #, and the demo data is created in the
// browser. Double-click the file to open it: no server, no install, no internet.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, 'dist-offline');

const res = spawnSync('pnpm exec vite build', {
  cwd: web,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NATIJA_OFFLINE: '1' },
});
if (res.status !== 0) process.exit(res.status ?? 1);

let html = readFileSync(join(out, 'index.html'), 'utf8');
const assets = join(out, 'assets');
const read = (href) => readFileSync(join(out, href.replace(/^\.\//, '')), 'utf8');

// The tab icon as a data URL, so the file needs nothing next to it.
html = html.replace(/<link rel="icon"[^>]*href="([^"]+\.svg)"[^>]*>/g, (_m, href) => {
  const svg = read(href);
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
});

// Styles first, then the (single) module script; modulepreload hints are not needed any more.
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => `<style>${read(href)}</style>`);
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
  // A literal </script> inside the code would end the tag early.
  const code = read(src).replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${code}</script>`;
});

const left = readdirSync(assets).filter((f) => !/\.(js|css)$/.test(f));
if (left.length) console.warn(`Assets that were not inlined (they will be missing offline): ${left.join(', ')}`);

const target = join(out, 'natija-demo.html');
writeFileSync(target, html);
rmSync(join(out, 'index.html'));
rmSync(assets, { recursive: true, force: true });
// Files copied from public/ (the icon is inlined above).
for (const f of readdirSync(out)) if (f !== 'natija-demo.html') rmSync(join(out, f), { recursive: true, force: true });
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
console.log(`\nOffline demo: ${target} (${mb} MB). Double-click it to open.\n`);
