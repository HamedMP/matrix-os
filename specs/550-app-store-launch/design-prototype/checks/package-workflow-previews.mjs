import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { defaultFixture } from './default-fixtures.mjs';
import { workflowFixture } from './workflow-fixtures.mjs';
import { previewSourceHash } from './preview-source-hash.mjs';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documents = resolve(here, 'src/preview-documents');
const connectedIds = ['folio', 'atlas', 'agenda', 'subscriptions', 'focus', 'meeting-briefs', 'projects', 'revenue', 'workout-coach', 'paycheck-runway', 'meal-planner', 'job-search', 'study-notes', 'journal-memory', 'chess-coach', 'people', 'cashflow'];
const defaultIds = ['notes', 'todo', 'task-manager', 'calculator', 'clock', 'weather', 'expense-tracker', 'stickies', 'pomodoro'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const scriptText = value => value.replace(/<\/script/gi, '<\\/script');
const styleText = value => value.replace(/<\/style/gi, '<\\/style');
const maxBytes = 2_000_000;

function validateDocument(value, id) {
  assert.equal(value.sha256, hash(value.html), `${id}: HTML digest`);
  assert.equal(value.fictionalOnly, true);
  assert.match(value.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(value.html) <= maxBytes, `${id}: document byte budget`);
  assert.doesNotMatch(value.html, /<script[^>]+src=|<script[^>]+type="module"|<link[^>]+rel="stylesheet"/i);
  assert.doesNotMatch(value.html, /import\.meta|data:image\/png/);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "worker-src 'none'", "img-src data:"]) assert.ok(value.html.includes(directive), `${id}: ${directive}`);
  assert.ok(value.html.includes('Changes reset on reload.'), `${id}: fictional banner`);
  const nonce = value.html.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, `${id}: nonce policy`);
  let executable = 0;
  for (const match of value.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.ok(match[1].includes(`nonce="${nonce}"`), `${id}: matching script nonce`);
    if (match[1].includes('application/json')) JSON.parse(match[2]);
    else { new Script(match[2], { filename: `${id}-inline-${executable++}.js` }); }
  }
  assert.equal(executable, 2, `${id}: adapter and actual source only`);
  return Buffer.byteLength(value.html);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.slice(2).join(' ') === '--verify') {
  let maximum = 0;
  for (const id of [...connectedIds, ...defaultIds]) {
    const value = JSON.parse(await readFile(resolve(documents, `current-${id}.json`), 'utf8'));
    maximum = Math.max(maximum, validateDocument(value, id));
  }
  console.log(JSON.stringify({ verified: 26, maximumBytes: maximum, limitBytes: maxBytes }));
} else if (isMain) {
  const args = process.argv.slice(2), flags = ['--connected-source', '--default-source', '--site-output'];
  if (args.length !== 6 || flags.some((flag, index) => args[index * 2] !== flag || !isAbsolute(args[index * 2 + 1]))) throw Error('Usage: --connected-source <absolute repository> --default-source <absolute repository> --site-output <absolute public/app-previews directory>, or --verify');
  const source = resolve(args[1]), defaults = resolve(args[3]), siteOutput = resolve(args[5]);
  if (!siteOutput.endsWith('/public/app-previews')) throw Error('Site destination must be the public app-previews directory');
  for (const path of [source, defaults]) if (!(await lstat(path)).isDirectory()) throw Error('Source root must be a repository directory');
  const originalNames = (await readdir(documents)).filter(name => /^original-[a-z-]+\.json$/.test(name)).sort();
  assert.equal(originalNames.length, 17, 'Preserved original comparison count');
  const originalDigests = await Promise.all(originalNames.map(async name => hash(await readFile(resolve(documents, name)))));
  const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
  const template = resolve(source, 'home/app-templates/connected-starter');
  const catalog = JSON.parse(await readFile(resolve(source, 'home/system/app-gallery.json'), 'utf8'));
  const artwork = await readFile(resolve(template, 'public/matrix-workflow-objects-v1.webp'));
  assert.ok(artwork.length <= 150000, 'Use the bounded WebP artwork');
  const dataArtwork = `data:image/webp;base64,${artwork.toString('base64')}`;
  const connectedAdapter = await readFile(resolve(here, 'public/demos/fixture-adapter.js'), 'utf8');
  const defaultsAdapter = await readFile(resolve(here, 'public/demos/default-adapter.js'), 'utf8');
  const packagingHash = hash(Buffer.concat([await readFile(fileURLToPath(import.meta.url)), await readFile(new URL('./preview-source-hash.mjs', import.meta.url))]));
  const connectedTree = await sourceDigest(resolve(template, 'src'));
  const connectedDependencies = hash(Buffer.concat([await readFile(resolve(template, 'package.json')), await readFile(resolve(template, 'pnpm-lock.yaml'))]));
  const compiled = await compile(build, resolve(template, 'src/main.tsx'), [{ name: 'offline-review-only', setup(builder) {
    builder.onLoad({ filter: /[\\/]Sidebar\.tsx$/ }, async ({ path }) => {
      const text = await readFile(path, 'utf8'), pattern = /new URL\("\.\.\/public\/matrix-workflow-objects-v1\.webp",\s*import\.meta\.url\)\.href/g;
      assert.equal([...text.matchAll(pattern)].length, 1, 'Expected source artwork reference');
      return { contents: text.replace(pattern, JSON.stringify(dataArtwork)), loader: 'tsx' };
    });
    builder.onLoad({ filter: /[\\/]ChessCoach\.tsx$/ }, async ({ path }) => {
      const text = await readFile(path, 'utf8'), pattern = /import ChessWorker from "\.\/chess\.worker\.ts\?worker&inline";/g;
      assert.equal([...text.matchAll(pattern)].length, 1, 'Expected inline worker import');
      return { contents: text.replace(pattern, 'class ChessWorker { constructor() { throw new Error("Local analysis is unavailable in this offline preview."); } }'), loader: 'tsx' };
    });
  } }]);
  const siteApps = [], budgets = {}, collection = [];
  let stagedBytes = 0;
  const stage = (id, value) => {
    stagedBytes += Buffer.byteLength(JSON.stringify(value));
    assert.ok(stagedBytes <= 52_000_000 && collection.length < 26, 'Bounded source preview staging');
    collection.push({ id, value });
  };
  for (const id of connectedIds) {
    const definition = catalog.apps.find(app => app.id === id);
    assert.ok(definition, `Missing real app definition: ${id}`);
    const definitionHash = hash(JSON.stringify(definition));
    const sourceHash = hash(json({ sourceTree: connectedTree, definition: definitionHash, dependencies: connectedDependencies, artwork: hash(artwork), adapter: hash(connectedAdapter), packager: packagingHash }));
    let fixture;
    if (['folio', 'atlas', 'agenda', 'subscriptions', 'focus', 'meeting-briefs', 'projects', 'revenue'].includes(id)) {
      const old = await readFile(resolve(here, 'public/demos', id, 'index.html'), 'utf8');
      const serialized = old.match(/<script[^>]*id="demo-records"[^>]*>([\s\S]*?)<\/script>/)?.[1];
      assert.ok(serialized, 'Original fictional input fixture is required'); fixture = JSON.parse(serialized);
    } else fixture = workflowFixture(id, definition);
    assert.ok(Array.isArray(fixture) && fixture.length <= 200 && fixture.every(row => row.payload?.accounts?.length === 0 && row.payload?.sources?.length === 0), 'No fake connected accounts or service evidence');
    const html = documentHtml(id, compiled, connectedAdapter, [['matrix-app-definition', definition], ['demo-records', fixture]], false);
    const value = { html, sha256: hash(html), sourceSha256: sourceHash, sourceTreeSha256: connectedTree, definitionSha256: definitionHash, fictionalOnly: true, packaging: 'Real source, classic IIFE, inline CSS and WebP; preview-only offline adapter.' };
    budgets[id] = validateDocument(value, id);
    stage(id, value);
    siteApps.push({ slug: id, sourceSha: sourceHash, exampleData: true });
  }
  for (const id of defaultIds) {
    const appRoot = resolve(defaults, 'home/apps', id), tree = await sourceDigest(resolve(appRoot, 'src'));
    const manifestBytes = await readFile(resolve(appRoot, 'matrix.json')), manifest = JSON.parse(manifestBytes.toString('utf8'));
    const sharedStyleHash = hash(Buffer.concat([await readFile(resolve(defaults, 'home/apps/_shared/gallery-family.css')), await readFile(resolve(defaults, 'home/apps/_shared/app-identities.css'))]));
    const sourceHash = previewSourceHash({ sourceTree: tree, sharedStyle: sharedStyleHash, definition: hash(manifestBytes), adapter: hash(defaultsAdapter), packager: packagingHash });
    const output = await compile(build, resolve(appRoot, 'src/main.tsx'));
    const html = documentHtml(id, output, defaultsAdapter, [['default-fixture', defaultFixture(id, manifest)]], true);
    const value = { html, sha256: hash(html), sourceSha256: sourceHash, sourceTreeSha256: tree, sharedStyleSha256: sharedStyleHash, definitionSha256: hash(manifestBytes), fictionalOnly: true, packaging: 'Real default-app source, classic IIFE and inline CSS; bounded temporary fixture adapter.' };
    budgets[id] = validateDocument(value, id);
    stage(id, value);
  }
  for (let index = 0; index < originalNames.length; index++) assert.equal(hash(await readFile(resolve(documents, originalNames[index]))), originalDigests[index], `${originalNames[index]} must remain byte-identical`);
  await publishPreviewCollection({ collection, documents, siteOutput, siteApps });
  console.log(JSON.stringify({ currentDocuments: 26, connectedSitePreviews: siteApps.length, unchangedOriginalDocuments: originalNames.length, connectedSourceTreeSha256: connectedTree, maximumBytes: Math.max(...Object.values(budgets)), budgets, sourceManifestSha256: hash(await readFile(resolve(siteOutput, 'manifest.json'))) }, null, 2));
}


/** Compile and validate the complete bounded collection before replacing any output. */
export async function publishPreviewCollection({ collection, documents, siteOutput, siteApps }) {
  assert.equal(collection.length, 26, 'Expected 26 source documents before publication');
  const ids = new Set();
  for (const { id, value } of collection) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(id), 'Duplicate source preview'); ids.add(id);
    validateDocument(value, id);
  }
  assert.equal(siteApps.length, 17, 'Expected 17 connected site previews');
  assert.equal(new Set(siteApps.map(app => app.slug)).size, 17, 'Unique connected site previews');
  for (const app of siteApps) {
    assert.ok(ids.has(app.slug), 'Site preview must be in the validated source collection');
    assert.match(app.sourceSha, /^[a-f0-9]{64}$/);
    assert.equal(app.exampleData, true);
    assert.equal(app.sourceSha, collection.find(item => item.id === app.slug).value.sourceSha256);
  }
  const writes = collection.map(({ id, value }) => ({ destination: resolve(documents, `current-${id}.json`), content: JSON.stringify(value) + '\n' }));
  for (const app of siteApps) writes.push({ destination: resolve(siteOutput, `${app.slug}.html`), content: collection.find(item => item.id === app.slug).value.html });
  writes.push({ destination: resolve(siteOutput, 'manifest.json'), content: JSON.stringify({ apps: siteApps }, null, 2) + '\n' });
  assert.ok(writes.reduce((total, file) => total + Buffer.byteLength(file.content), 0) <= 52_000_000, 'Bounded collection publication');
  await mkdir(documents, { recursive: true });
  await mkdir(siteOutput, { recursive: true });
  for (const file of writes) await writeFile(file.destination, file.content);
}

async function compile(build, entry, plugins = []) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outdir: 'offline-preview-output', entryNames: 'app', write: false, metafile: true, plugins });
  assert.ok(result.outputFiles.length <= 2 && result.outputFiles.every(file => /\.(js|css)$/.test(file.path)), 'No external preview assets');
  const javascript = result.outputFiles.find(file => file.path.endsWith('.js'))?.text, css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  assert.ok(javascript, 'Source bundle is required');
  new Script(javascript, { filename: 'actual-source-iife.js' });
  assert.doesNotMatch(css, /@import\b|url\(\s*["']?(?:https?:|\/|\.\.)/i, 'CSS may not load external assets');
  return { javascript, css };
}

function documentHtml(id, output, adapter, fixtures, isDefault) {
  const nonce = randomBytes(18).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'`;
  const banner = `Fictional example data. Temporary edits only. Changes reset on reload.${id === 'weather' ? ' Example forecast, not live weather.' : ''}`;
  const chrome = '.preview-example-banner{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;pointer-events:none;padding:6px 12px;background:#f6f8ff;color:#39434b;border-top:1px solid #dce1e4;font:10px/1.5 system-ui;text-align:center}body{padding-bottom:28px}';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${id} · fictional example preview</title><style>${styleText(output.css)}\n${chrome}</style></head><body><div id="root"></div><aside class="preview-example-banner" role="note">${banner}</aside>${fixtures.map(([key, data]) => `<script nonce="${nonce}" type="application/json" id="${key}">${json(data)}</script>`).join('')}<script nonce="${nonce}">${scriptText(adapter)}</script><script nonce="${nonce}">${scriptText(output.javascript)}</script></body></html>`;
}

async function sourceDigest(root) {
  const digest = createHash('sha256'); let files = 0;
  async function walk(path, depth) {
    if (depth > 20) throw Error('Source depth exceeds packaging bound');
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(next, depth + 1);
      else if (entry.isFile()) {
        if (++files > 1000) throw Error('Source file count exceeds packaging bound');
        const bytes = await readFile(next); if (bytes.length > maxBytes) throw Error('Source file exceeds packaging bound');
        digest.update(relative(root, next)); digest.update('\0'); digest.update(bytes); digest.update('\0');
      } else throw Error('Source contains unsupported entries');
    }
  }
  await walk(root, 0); return digest.digest('hex');
}
