import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
import { defaultFixture } from './default-fixtures.mjs';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? '/private/tmp/matrix-connected-app-design-refresh');
const defaults = resolve(process.argv[3] ?? '/private/tmp/matrix-default-app-design-refresh');
const original = resolve(process.argv[4] ?? '/private/tmp/matrix-default-design-baseline');
const publicRoot = resolve(here, 'public');
const documents = resolve(here, 'src/preview-documents');
await mkdir(documents, { recursive: true });
const ids = ['folio', 'atlas', 'agenda', 'subscriptions', 'focus', 'meeting-briefs', 'projects', 'revenue'];
const defaultsIds = ['notes', 'todo', 'task-manager', 'calculator', 'clock', 'weather', 'expense-tracker', 'stickies', 'pomodoro'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const assets = resolve(source, 'home/app-templates/connected-starter/dist/assets');
const catalog = JSON.parse(await readFile(resolve(source, 'home/system/app-gallery.json'), 'utf8'));
const provenance = JSON.parse(await readFile(resolve(publicRoot, 'demos/provenance.json'), 'utf8'));
provenance.refreshed = { source: 'home/app-templates/connected-starter/src', sourceSha256: await sourceDigest(resolve(source, 'home/app-templates/connected-starter/src')), packaging: 'Actual Vite production output; original compiled assets retained for comparison.' };
let script, stylesheet;
for (const name of await readdir(assets)) {
  if (!/\.(css|js)$/.test(name)) throw Error('Unexpected connected output asset');
  const data = await readFile(resolve(assets, name));
  await cp(resolve(assets, name), resolve(publicRoot, 'demos/assets', name));
  provenance.assetSha256[name] = hash(data);
  if (name.endsWith('.js')) script = name; else stylesheet = name;
}
if (!script || !stylesheet) throw Error('Connected output unavailable');
provenance.refreshed.script = script;
provenance.refreshed.stylesheet = stylesheet;
for (const id of ids) {
  const path = resolve(publicRoot, 'demos', id, 'index.html');
  let html = await readFile(path, 'utf8');
  html = html.replace(/\.\.\/assets\/index-[^" ]+\.css/, `../assets/${stylesheet}`).replace(/\.\.\/assets\/index-[^" ]+\.js/, `../assets/${script}`);
  const app = catalog.apps.find(app => app.id === id);
  if (!app) throw Error('Missing app definition');
  html = html.replace(/(id="matrix-app-definition">)[\s\S]*?(<\/script>)/, `$1${json(app)}$2`);
  await writeFile(path, html);
  await inlineDocument(id, 'current', path);
  await inlineDocument(id, 'original', resolve(publicRoot, 'baseline/connected', id, 'index.html'));
}
await writeFile(resolve(publicRoot, 'demos/provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
const defaultProvenance = { temporaryOnly: true, packaging: 'Actual source entry bundled to a classic IIFE for opaque frames; CSS and JS never receive owner credentials. Notes lazy chunks are bundled locally.', editions: {} };
for (const [edition, root] of [['current', defaults], ['original', original]]) {
  const destination = resolve(publicRoot, edition === 'current' ? 'demos/defaults' : 'baseline/defaults');
  defaultProvenance.editions[edition] = {};
  for (const id of defaultsIds) {
    const appRoot = resolve(root, 'home/apps', id), out = resolve(destination, id);
    await mkdir(out, { recursive: true });
    const result = await build({ entryPoints: [resolve(appRoot, 'src/main.tsx')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outdir: out, entryNames: 'app', write: true, metafile: true });
    const manifest = JSON.parse(await readFile(resolve(appRoot, 'matrix.json'), 'utf8'));
    const fixture = defaultFixture(id, manifest);
    const nonce = randomBytes(18).toString('base64');
    const adapter = relative(out, resolve(publicRoot, 'demos/default-adapter.js')).replaceAll('\\', '/');
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'`;
    await writeFile(resolve(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${id} design preview</title><link rel="stylesheet" href="./app.css"><style>.default-example-banner{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;pointer-events:none;padding:6px 12px;background:#fff;color:#39434b;border-top:1px solid #dce1e4;font:10px/1.5 system-ui;text-align:center}body{padding-bottom:28px}</style><script nonce="${nonce}" defer src="${adapter}"></script><script nonce="${nonce}" defer src="./app.js"></script></head><body><div id="root"></div><aside class="default-example-banner" role="note">Fictional example data · temporary edits · ${id === 'weather' ? 'example forecast, not live weather' : 'reset on reload'}</aside><script nonce="${nonce}" type="application/json" id="default-fixture">${json(fixture)}</script></body></html>`);
    await inlineDocument(id, edition, resolve(out, 'index.html'));
    const outputs = {};
    for (const path of Object.keys(result.metafile.outputs)) outputs[path.endsWith('.css') ? 'app.css' : 'app.js'] = hash(await readFile(path));
    defaultProvenance.editions[edition][id] = { sourceSha256: await sourceDigest(resolve(appRoot, 'src')), outputs };
    console.log(`${edition} ${id}: actual source packaged`);
  }
}
await writeFile(resolve(publicRoot, 'demos/default-provenance.json'), JSON.stringify(defaultProvenance, null, 2) + '\n');
// Only self-contained, lazily loaded review documents ship for the defaults.
await rm(resolve(publicRoot, 'demos/defaults'), { recursive: true });
await rm(resolve(publicRoot, 'baseline/defaults'), { recursive: true });
async function inlineDocument(id, edition, path) {
  let html = await readFile(path, 'utf8');
  const replacements = [];
  for (const match of html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)) {
    const css = await readFile(resolve(dirname(path), match[1]), 'utf8');
    replacements.push([match[0], `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`]);
  }
  // Run after the fixture JSON and #root exist. This is a local source document,
  // never HTML returned by an owner API or a third party.
  const scripts = [];
  for (const match of html.matchAll(/<script nonce="([^"]+)" defer src="([^"]+)"><\/script>/g)) {
    const code = await readFile(resolve(dirname(path), match[2]), 'utf8');
    scripts.push(`<script nonce="${match[1]}">${code.replace(/<\/script/gi, '<\\/script')}</script>`);
    replacements.push([match[0], '']);
  }
  for (const [before, after] of replacements) html = html.replace(before, () => after);
  if (/<script[^>]+src=|<script[^>]+type="module"|<link[^>]+rel="stylesheet"/i.test(html)) throw Error('Preview has an external runtime asset');
  html = html.replace('</body>', () => scripts.join('') + '</body>');
  await writeFile(resolve(documents, `${edition}-${id}.json`), JSON.stringify({ html, sha256: hash(html), fictionalOnly: true }) + '\n');
}
async function sourceDigest(root) {
  const digest = createHash('sha256');
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) { digest.update(relative(root, next)); digest.update(await readFile(next)); }
      else throw Error('Source contains unsupported entries');
    }
  }
  await walk(root); return digest.digest('hex');
}
