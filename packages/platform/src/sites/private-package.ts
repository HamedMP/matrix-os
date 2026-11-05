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

const byteLength = (value: string) => Buffer.byteLength(value);

/** Refuses each growth step before String.replace can materialize an oversized result. */
class ExpansionBudget {
  private bytes: number;
  constructor(value: string) {
    this.bytes = byteLength(value);
    if (this.bytes > MAX_OUTPUT_BYTES) unavailable();
  }
  replacement(original: string, next: string): string {
    this.bytes += byteLength(next) - byteLength(original);
    if (this.bytes > MAX_OUTPUT_BYTES) unavailable();
    return next;
  }
}

function rawDataUri(contentType: string, body: Buffer): string {
  return `data:${contentType};base64,${body.toString('base64')}`;
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

function resolvedPath(files: Map<string, PrivateSiteFile>, specifier: string, importer: string): string | null {
  const relative = localPath(specifier, importer);
  if (!relative) return null;
  if (files.has(relative)) return relative;
  const root = posix.normalize(specifier.split(/[?#]/, 1)[0].replace(/^\//, ''));
  return files.has(root) ? root : relative;
}

function requiredPath(files: Map<string, PrivateSiteFile>, specifier: string, importer: string): string {
  const path = resolvedPath(files, specifier, importer);
  if (!path || !files.has(path)) unavailable();
  return path;
}

function rewriteCss(css: string, path: string, files: Map<string, PrivateSiteFile>, uriFor: (path: string) => string): string {
  const budget = new ExpansionBudget(css);
  return css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (match, _quote: string, raw: string) => {
    const resolved = resolvedPath(files, raw, path);
    if (!resolved) return match;
    if (!files.has(resolved)) unavailable();
    return budget.replacement(match, `url("${uriFor(resolved)}")`);
  });
}

function applyReplacements(code: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  const budget = new ExpansionBudget(code);
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    const original = code.slice(replacement.start, replacement.end);
    const value = budget.replacement(original, replacement.value);
    code = code.slice(0, replacement.start) + value + code.slice(replacement.end);
  }
  return code;
}

function rewriteVitePreloadMetadata(code: string, path: string, files: Map<string, PrivateSiteFile>, uriFor: (path: string) => string): string {
  const budget = new ExpansionBudget(code);
  return code.replace(
    /(\b__vite__mapDeps\b[\s\S]*?\.f\s*\|\|\s*\(\s*[A-Za-z_$][\w$]*\.f\s*=\s*\[)([\s\S]*?)(\]\s*\)\s*\))/g,
    (_match, prefix: string, entries: string, suffix: string) => {
      const rewritten = entries.replace(/(['"])(\/?[^'"\n]+)\1/g, (entry, _quote: string, raw: string) => {
        const resolved = resolvedPath(files, raw, path);
        const file = resolved ? files.get(resolved) : undefined;
        if (!file) return entry;
        const isCode = /(?:java|ecma)script|application\/x-javascript/.test(file.contentType) || /\.(?:m?js)$/i.test(file.path);
        // The real dynamic import is mapped separately. Preload a bounded empty
        // module so Vite's helper succeeds without a private network request.
        return budget.replacement(entry, JSON.stringify(isCode ? 'data:text/javascript,export{}' : uriFor(resolved!)));
      });
      return `${prefix}${rewritten}${suffix}`;
    },
  );
}

async function rewriteModule(code: string, path: string, files: Map<string, PrivateSiteFile>, uriFor: (path: string) => string): Promise<string> {
  const budget = new ExpansionBudget(code);
  code = code.replace(/new\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g, (match, _quote: string, raw: string) => {
    const resolved = resolvedPath(files, raw, path);
    if (!resolved) return match;
    if (!files.has(resolved)) unavailable();
    return budget.replacement(match, `new URL(${JSON.stringify(uriFor(resolved))}, import.meta.url)`);
  });
  await init;
  const [imports] = parse(code);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const imported of imports) {
    if (imported.d === -2) continue;
    if (imported.n === undefined) unavailable();
    const resolved = resolvedPath(files, imported.n, path);
    if (!resolved) continue;
    if (!files.has(resolved)) unavailable();
    const specifier = `${MODULE_PREFIX}${resolved}`;
    replacements.push({ start: imported.s, end: imported.e, value: imported.d >= 0 ? JSON.stringify(specifier) : specifier });
  }
  code = applyReplacements(code, replacements);
  // Vite names lazy CSS/JS chunks as strings in its generated dependency map.
  // Restrict rewriting to that metadata so ordinary app strings stay untouched.
  return rewriteVitePreloadMetadata(code, path, files, uriFor);
}

function moduleData(file: PrivateSiteFile, uriFor: (path: string) => string, code?: string): string {
  if (code !== undefined) return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  if (file.contentType === 'application/json') {
    let parsed: unknown;
    try { parsed = JSON.parse(file.body.toString('utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) unavailable();
      throw error;
    }
    return `data:text/javascript;base64,${Buffer.from(`export default ${JSON.stringify(parsed)};`).toString('base64')}`;
  }
  if (file.contentType === 'text/css' || file.path.endsWith('.css')) {
    const source = `const href=${JSON.stringify(uriFor(file.path))};const existing=document.querySelector('link[data-matrix-site-css=${JSON.stringify(file.path)}]');if(!existing){const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.matrixSiteCss=${JSON.stringify(file.path)};document.head.append(link)}export default href;`;
    return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  }
  return `data:text/javascript;base64,${Buffer.from(`export default ${JSON.stringify(uriFor(file.path))};`).toString('base64')}`;
}

function rewriteResourceAttributes(html: string, htmlPath: string, files: Map<string, PrivateSiteFile>, uriFor: (path: string) => string): string {
  const budget = new ExpansionBudget(html);
  return html.replace(/<(img|source|video|audio|link)\b([^>]*)>/gi, tag => {
    return tag.replace(/\b(src|poster|href)\s*=\s*(["'])([^"']+)\2/gi, (attribute, name: string, quote: string, raw: string) => {
      const resolved = resolvedPath(files, raw, htmlPath);
      if (!resolved) return attribute;
      if (!files.has(resolved)) unavailable();
      return budget.replacement(attribute, `${name}=${quote}${uriFor(resolved)}${quote}`);
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

  const uris = new Map<string, string>();
  const resolvingCss = new Set<string>();
  const uriFor = (path: string): string => {
    const cached = uris.get(path);
    if (cached) return cached;
    const file = files.get(path);
    if (!file) unavailable();
    let body = file.body;
    if (file.contentType === 'text/css' || file.path.endsWith('.css')) {
      if (resolvingCss.has(path)) unavailable();
      resolvingCss.add(path);
      try { body = Buffer.from(rewriteCss(body.toString('utf8'), path, files, uriFor)); }
      finally { resolvingCss.delete(path); }
    }
    const uri = rawDataUri(file.contentType, body);
    uris.set(path, uri);
    return uri;
  };

  const imports: Record<string, string> = {};
  let importMapBytes = 32;
  for (const file of files.values()) {
    if (file.path === entryPath) continue;
    const isModule = /(?:java|ecma)script|application\/x-javascript/.test(file.contentType) || /\.(?:m?js)$/i.test(file.path);
    const code = isModule ? await rewriteModule(file.body.toString('utf8'), file.path, files, uriFor) : undefined;
    const key = `${MODULE_PREFIX}${file.path}`;
    const value = moduleData(file, uriFor, code);
    importMapBytes += byteLength(key) + byteLength(value) + 8;
    if (importMapBytes > MAX_OUTPUT_BYTES) unavailable();
    imports[key] = value;
  }
  let html = entry.body.toString('utf8');
  html = html.replace(/<link\b[^>]*\brel\s*=\s*(["']?)modulepreload\1[^>]*>/gi, '');
  const budget = new ExpansionBudget(html);
  html = html.replace(/<script\b([^>]*)\btype\s*=\s*(["']?)module\2([^>]*)\bsrc\s*=\s*(["'])([^"']+)\4([^>]*)><\/script>/gi,
    (tag, before: string, _typeQuote: string, middle: string, _srcQuote: string, raw: string, after: string) => {
      const path = requiredPath(files, raw, entryPath);
      return budget.replacement(tag, `<script type="module"${before}${middle}${after}>import ${JSON.stringify(`${MODULE_PREFIX}${path}`)};</script>`);
    });
  html = rewriteResourceAttributes(html, entryPath, files, uriFor);
  if (byteLength(html) + importMapBytes + 64 > MAX_OUTPUT_BYTES) unavailable();
  const importMap = JSON.stringify({ imports }).replaceAll('<', '\\u003c');
  const sealed = `<script type="importmap">${importMap}</script>`;
  if (byteLength(html) + byteLength(sealed) > MAX_OUTPUT_BYTES) unavailable();
  if (/<head(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}${sealed}`);
  else if (/<html(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<html(?:\s[^>]*)?>/i, root => `${root}<head>${sealed}</head>`);
  else html = `<!doctype html><html><head>${sealed}</head><body>${html}</body></html>`;
  if (byteLength(html) > MAX_OUTPUT_BYTES) unavailable();
  return html;
}
