import { posix } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { SiteError } from './types.js';

export interface PrivateSiteFile {
  path: string;
  contentType: string;
  body: Buffer;
}

const MAX_FILES = 200;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;
const MODULE_PREFIX = 'matrix-site:';

function unavailable(): never {
  throw new SiteError('unavailable');
}

function dataUri(file: PrivateSiteFile): string {
  return `data:${file.contentType};base64,${file.body.toString('base64')}`;
}

function localPath(specifier: string, importer: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(specifier)) return null;
  const clean = specifier.split(/[?#]/, 1)[0];
  if (!clean) return null;
  const candidate = clean.startsWith('/')
    ? posix.normalize(clean.slice(1))
    : posix.normalize(posix.join(posix.dirname(importer), clean));
  if (!candidate || candidate === '..' || candidate.startsWith('../') || candidate.startsWith('/')) unavailable();
  return candidate;
}

function requiredFile(files: Map<string, PrivateSiteFile>, specifier: string, importer: string): PrivateSiteFile {
  const path = localPath(specifier, importer);
  if (!path) unavailable();
  const file = files.get(path);
  if (!file) unavailable();
  return file;
}

function rewriteCss(css: string, path: string, files: Map<string, PrivateSiteFile>): string {
  return css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (match, _quote: string, raw: string) => {
    const resolved = localPath(raw, path);
    if (!resolved) return match;
    const file = files.get(resolved);
    if (!file) unavailable();
    return `url("${dataUri(file)}")`;
  });
}

async function rewriteModule(code: string, path: string, files: Map<string, PrivateSiteFile>): Promise<string> {
  code = code.replace(/new\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g, (_match, _quote: string, raw: string) => {
    const resolved = localPath(raw, path);
    if (!resolved) return _match;
    const file = files.get(resolved);
    if (!file) unavailable();
    return JSON.stringify(dataUri(file));
  });
  await init;
  const [imports] = parse(code);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const imported of imports) {
    if (imported.d === -2) continue;
    if (imported.n === undefined) unavailable();
    const resolved = localPath(imported.n, path);
    if (!resolved) continue;
    if (!files.has(resolved)) unavailable();
    const specifier = `${MODULE_PREFIX}${resolved}`;
    replacements.push({ start: imported.s, end: imported.e, value: imported.d >= 0 ? JSON.stringify(specifier) : specifier });
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    code = code.slice(0, replacement.start) + replacement.value + code.slice(replacement.end);
  return code;
}

function moduleData(file: PrivateSiteFile, code?: string): string {
  if (code !== undefined) return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  if (file.contentType === 'application/json') {
    let parsed: unknown;
    try { parsed = JSON.parse(file.body.toString('utf8')); }
    catch { unavailable(); }
    return `data:text/javascript;base64,${Buffer.from(`export default ${JSON.stringify(parsed)};`).toString('base64')}`;
  }
  if (file.contentType === 'text/css') return 'data:text/javascript,export%20default%20undefined';
  return `data:text/javascript;base64,${Buffer.from(`export default ${JSON.stringify(dataUri(file))};`).toString('base64')}`;
}

function rewriteResourceAttributes(html: string, htmlPath: string, files: Map<string, PrivateSiteFile>): string {
  return html.replace(/<(img|source|video|audio|link)\b([^>]*)>/gi, (tag, element: string, attributes: string) => {
    if (element.toLowerCase() === 'link' && /\brel\s*=\s*(["']?)(?:stylesheet|modulepreload)\1/i.test(attributes)) return tag;
    return tag.replace(/\b(src|poster|href)\s*=\s*(["'])([^"']+)\2/gi, (attribute, name: string, quote: string, raw: string) => {
      const resolved = localPath(raw, htmlPath);
      if (!resolved) return attribute;
      const file = files.get(resolved);
      if (!file) unavailable();
      return `${name}=${quote}${dataUri(file)}${quote}`;
    });
  });
}

/** Seals a bounded published Vite build into one authorized opaque-frame response. */
export async function packagePrivateSiteHtml(input: PrivateSiteFile[], entryPath: string): Promise<string> {
  if (input.length < 1 || input.length > MAX_FILES) unavailable();
  const total = input.reduce((sum, file) => sum + file.body.byteLength, 0);
  if (total > MAX_INPUT_BYTES) unavailable();
  const files = new Map<string, PrivateSiteFile>();
  for (const file of input) {
    const normalized = posix.normalize(file.path);
    if (normalized !== file.path || normalized.startsWith('../') || files.has(normalized)) unavailable();
    files.set(normalized, file);
  }
  const entry = files.get(entryPath);
  if (!entry || entry.contentType !== 'text/html') unavailable();

  const imports: Record<string, string> = {};
  for (const file of files.values()) {
    const isModule = /(?:java|ecma)script|application\/x-javascript/.test(file.contentType) || /\.(?:m?js)$/i.test(file.path);
    const code = isModule ? await rewriteModule(file.body.toString('utf8'), file.path, files) : undefined;
    imports[`${MODULE_PREFIX}${file.path}`] = moduleData(file, code);
  }
  let html = entry.body.toString('utf8');
  html = html.replace(/<link\b[^>]*\brel\s*=\s*(["']?)(?:modulepreload|stylesheet)\1[^>]*>/gi, '');
  html = html.replace(/<script\b([^>]*)\btype\s*=\s*(["']?)module\2([^>]*)\bsrc\s*=\s*(["'])([^"']+)\4([^>]*)><\/script>/gi,
    (_tag, before: string, _typeQuote: string, middle: string, _srcQuote: string, raw: string, after: string) => {
      const file = requiredFile(files, raw, entryPath);
      return `<script type="module"${before}${middle}${after}>import ${JSON.stringify(`${MODULE_PREFIX}${file.path}`)};</script>`;
    });
  html = rewriteResourceAttributes(html, entryPath, files);
  const styles = [...files.values()].filter(file => file.contentType === 'text/css' || file.path.endsWith('.css'))
    .map(file => rewriteCss(file.body.toString('utf8'), file.path, files)).join('\n');
  const importMap = JSON.stringify({ imports }).replaceAll('<', '\\u003c');
  const sealed = `<script type="importmap">${importMap}</script>${styles ? `<style>${styles.replace(/<\/style/gi, '<\\/style')}</style>` : ''}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}${sealed}`);
  else if (/<html(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<html(?:\s[^>]*)?>/i, root => `${root}<head>${sealed}</head>`);
  else html = `<!doctype html><html><head>${sealed}</head><body>${html}</body></html>`;
  if (Buffer.byteLength(html) > MAX_OUTPUT_BYTES) unavailable();
  return html;
}
