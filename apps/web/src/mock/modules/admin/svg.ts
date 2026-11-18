/**
 * Strict sanitiser for uploaded lab logos (port of apps/api/src/modules/settings/svg.ts; sizes
 * are measured in UTF-8 with TextEncoder instead of Buffer). The SVG is parsed with a small XML
 * tokenizer and written out again from a whitelist, so nothing is stored that was not understood.
 *
 * Refused outright (error): scripts, event handlers (on*), foreignObject and other embedded
 * documents, links or url() references to anything outside the file, javascript:/data: values,
 * DOCTYPE/ENTITY declarations, malformed XML, more than 100 KB.
 * Dropped quietly (reported in `removed`): editor metadata, <style> blocks, animation, unknown
 * elements and attributes. Kept: shapes, paths, text, gradients, clip paths, masks, internal <use>.
 */
import { byteLength } from './kit';

export class SvgError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const MAX_LOGO_BYTES = 100 * 1024;
const MAX_NODES = 10_000;
const MAX_DEPTH = 64;

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
]);

/** Elements that make the file unsafe: the upload is refused, not cleaned. */
const DANGEROUS_ELEMENTS: Record<string, string> = {
  script: 'svg_script',
  foreignobject: 'svg_foreign_object',
  iframe: 'svg_embedded_content',
  object: 'svg_embedded_content',
  embed: 'svg_embedded_content',
  handler: 'svg_script',
  listener: 'svg_script',
};

const ALLOWED_ATTRIBUTES = new Set([
  'id', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'width', 'height', 'd', 'points', 'transform', 'viewBox', 'preserveAspectRatio', 'version',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits', 'display', 'visibility', 'color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'letter-spacing', 'word-spacing', 'text-decoration', 'dx', 'dy', 'rotate', 'lengthAdjust', 'textLength',
  'direction', 'unicode-bidi', 'writing-mode', 'startOffset', 'side', 'spacing', 'method',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'href', 'style', 'role', 'aria-label', 'aria-hidden', 'focusable',
]);

const STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'stop-color',
  'stop-opacity', 'clip-path', 'clip-rule', 'mask', 'display', 'visibility', 'color', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'word-spacing', 'mix-blend-mode',
  'isolation', 'paint-order', 'vector-effect', 'shape-rendering', 'text-rendering',
]);

const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath', 'title', 'desc']);

type El = { name: string; attrs: Array<[string, string]>; children: Array<El | string> };

/* ------------------------------------------------------------------ tokenizer */

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (_m, ent: string) => {
    if (ent.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(Number.parseInt(ent.slice(1), 10));
    const v = NAMED_ENTITIES[ent];
    if (v === undefined) throw new SvgError('svg_invalid', `Unknown entity &${ent};`);
    return v;
  });
}

function parseXml(src: string): El {
  let i = 0;
  let nodes = 0;
  let root: El | null = null;
  const stack: El[] = [];
  const nameRe = /[A-Za-z_][\w.:-]*/y;
  const pushText = (text: string) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(text);
    else if (text.trim()) throw new SvgError('svg_invalid', 'Text outside the root element');
  };
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) throw new SvgError('svg_invalid', 'Unclosed comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) throw new SvgError('svg_invalid', 'Unclosed CDATA');
      pushText(src.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', i)) throw new SvgError('svg_doctype', 'DOCTYPE and ENTITY declarations are not allowed');
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) throw new SvgError('svg_invalid', 'Unclosed processing instruction');
      i = end + 2;
      continue;
    }
    if (src[i] === '<' && src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      if (end < 0) throw new SvgError('svg_invalid', 'Unclosed tag');
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new SvgError('svg_invalid', `Mismatched </${name}>`);
      i = end + 1;
      continue;
    }
    if (src[i] === '<') {
      nameRe.lastIndex = i + 1;
      const m = nameRe.exec(src);
      if (!m) throw new SvgError('svg_invalid', 'Invalid tag');
      const el: El = { name: m[0], attrs: [], children: [] };
      let j = nameRe.lastIndex;
      let selfClosing = false;
      for (;;) {
        while (j < src.length && /\s/.test(src[j]!)) j++;
        if (j >= src.length) throw new SvgError('svg_invalid', 'Unclosed tag');
        if (src[j] === '/' && src[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        if (src[j] === '>') {
          j++;
          break;
        }
        const an = /[^\s=/>]+/y;
        an.lastIndex = j;
        const am = an.exec(src);
        if (!am) throw new SvgError('svg_invalid', 'Invalid attribute');
        j = an.lastIndex;
        while (/\s/.test(src[j] ?? '')) j++;
        if (src[j] !== '=') throw new SvgError('svg_invalid', `Attribute ${am[0]} has no value`);
        j++;
        while (/\s/.test(src[j] ?? '')) j++;
        const quote = src[j];
        if (quote !== '"' && quote !== "'") throw new SvgError('svg_invalid', `Attribute ${am[0]} is not quoted`);
        const close = src.indexOf(quote, j + 1);
        if (close < 0) throw new SvgError('svg_invalid', 'Unclosed attribute value');
        const raw = src.slice(j + 1, close);
        if (raw.includes('<')) throw new SvgError('svg_invalid', 'Invalid attribute value');
        el.attrs.push([am[0], decodeEntities(raw)]);
        j = close + 1;
      }
      if (++nodes > MAX_NODES) throw new SvgError('svg_too_complex', 'Too many elements');
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(el);
      else if (root) throw new SvgError('svg_invalid', 'More than one root element');
      else root = el;
      if (!selfClosing) {
        stack.push(el);
        if (stack.length > MAX_DEPTH) throw new SvgError('svg_too_complex', 'Nested too deeply');
      }
      i = j;
      continue;
    }
    const next = src.indexOf('<', i);
    const end = next < 0 ? src.length : next;
    pushText(decodeEntities(src.slice(i, end)));
    i = end;
  }
  if (stack.length) throw new SvgError('svg_invalid', `Unclosed <${stack[stack.length - 1]!.name}>`);
  if (!root) throw new SvgError('svg_invalid', 'No root element');
  return root;
}

/* ------------------------------------------------------------------ checks */

/** Lower case without white space and control characters (they can hide "javascript:"). */
const compact = (v: string) => v.replace(/[\s\x00-\x1f]+/g, '').toLowerCase();

function assertSafeValue(value: string) {
  const c = compact(value);
  if (c.includes('javascript:') || c.includes('vbscript:')) throw new SvgError('svg_script', 'Script URLs are not allowed');
  for (const m of c.matchAll(/url\(([^)]*)\)/g)) {
    const target = m[1]!.replace(/^['"]|['"]$/g, '');
    if (!target.startsWith('#')) throw new SvgError('svg_external_ref', 'Only references inside the file are allowed');
  }
  if (c.includes('data:') || c.includes('@import') || c.includes('expression(')) throw new SvgError('svg_external_ref', 'External or embedded content is not allowed');
}

/** First pass: refuse anything unsafe anywhere in the file, including parts that would be dropped. */
function scan(el: El) {
  const lower = el.name.toLowerCase();
  const local = lower.includes(':') ? lower.slice(lower.indexOf(':') + 1) : lower;
  const danger = DANGEROUS_ELEMENTS[local];
  if (danger) throw new SvgError(danger, `<${el.name}> is not allowed`);
  for (const [name, value] of el.attrs) {
    const n = name.toLowerCase();
    if (n.startsWith('on')) throw new SvgError('svg_event_handler', `Event handler ${name} is not allowed`);
    if (n === 'href' || n.endsWith(':href')) {
      if (!/^#[A-Za-z_][\w.:-]*$/.test(value.trim())) throw new SvgError('svg_external_ref', 'Links must point inside the file');
      continue;
    }
    if (n === 'xmlns' || n.startsWith('xmlns:')) continue;
    assertSafeValue(value);
  }
  for (const child of el.children) if (typeof child !== 'string') scan(child);
}

/* ------------------------------------------------------------------ output */

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cleanStyle(value: string, removed: Set<string>): string {
  const out: string[] = [];
  for (const decl of value.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val) continue;
    if (!STYLE_PROPERTIES.has(prop) || /[\\<>@]/.test(val)) {
      removed.add(`style:${prop}`);
      continue;
    }
    out.push(`${prop}:${val}`);
  }
  return out.join(';');
}

function write(el: El, removed: Set<string>, isRoot: boolean): string {
  const attrs: string[] = [];
  for (const [name, value] of el.attrs) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const key = name === 'xlink:href' ? 'href' : name;
    if (!ALLOWED_ATTRIBUTES.has(key)) {
      removed.add(`@${name}`);
      continue;
    }
    const v = key === 'style' ? cleanStyle(value, removed) : value.trim();
    if (key === 'style' && !v) continue;
    attrs.push(`${key}="${escAttr(v)}"`);
  }
  if (isRoot) {
    attrs.unshift('xmlns="http://www.w3.org/2000/svg"');
    const has = (n: string) => el.attrs.some(([k]) => k === n);
    if (!has('viewBox')) {
      const w = el.attrs.find(([k]) => k === 'width')?.[1];
      const h = el.attrs.find(([k]) => k === 'height')?.[1];
      const nw = w ? Number.parseFloat(w) : Number.NaN;
      const nh = h ? Number.parseFloat(h) : Number.NaN;
      if (Number.isFinite(nw) && Number.isFinite(nh) && nw > 0 && nh > 0 && /^[\d.]+(px)?$/.test(w!.trim()) && /^[\d.]+(px)?$/.test(h!.trim())) {
        attrs.push(`viewBox="0 0 ${nw} ${nh}"`);
      }
    }
  }
  const keepText = TEXT_ELEMENTS.has(el.name);
  const inner: string[] = [];
  for (const child of el.children) {
    if (typeof child === 'string') {
      if (keepText && child.length) inner.push(escText(child));
      continue;
    }
    if (child.name.includes(':') || !ALLOWED_ELEMENTS.has(child.name)) {
      removed.add(child.name);
      continue;
    }
    inner.push(write(child, removed, false));
  }
  const open = `<${el.name}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
  return inner.length ? `${open}>${inner.join('')}</${el.name}>` : `${open}/>`;
}

/** Sanitise an uploaded logo. Throws SvgError with a stable code when the file is refused. */
export function sanitizeSvg(input: string): { svg: string; bytes: number; removed: string[] } {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (byteLength(src) > MAX_LOGO_BYTES) throw new SvgError('svg_too_large', 'The logo must be 100 KB or smaller');
  const root = parseXml(src);
  if (root.name !== 'svg') throw new SvgError('svg_not_svg', 'The file is not an SVG image');
  scan(root);
  const removed = new Set<string>();
  const svg = write(root, removed, true);
  return { svg, bytes: byteLength(svg), removed: [...removed].sort() };
}
