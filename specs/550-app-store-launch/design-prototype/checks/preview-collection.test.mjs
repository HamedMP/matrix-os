import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPreviewCollection } from './package-workflow-previews.mjs';

test('a failure in the final source document leaves the existing collection untouched', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'matrix-preview-publication-'));
  try {
    await writeFile(join(destination, 'current-folio.json'), 'previous valid collection');
    const current = JSON.parse(await readFile(new URL('../src/preview-documents/current-folio.json', import.meta.url), 'utf8'));
    const collection = Array.from({ length: 26 }, (_, index) => ({ id: `app-${index}`, value: { ...current } }));
    collection[25].value.sha256 = 'invalid';
    await assert.rejects(publishPreviewCollection({ collection, documents: destination, siteOutput: join(destination, 'site'), siteApps: [] }), /HTML digest/);
    assert.equal(await readFile(join(destination, 'current-folio.json'), 'utf8'), 'previous valid collection');
    assert.deepEqual(await readdir(destination), ['current-folio.json']);
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('an incomplete collection does not create the site destination', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'matrix-preview-publication-'));
  try {
    await assert.rejects(publishPreviewCollection({ collection: [], documents: destination, siteOutput: join(destination, 'site'), siteApps: [] }), /26 source documents/);
    assert.deepEqual(await readdir(destination), []);
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('a validated complete collection publishes all documents and the matching site manifest', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'matrix-preview-publication-'));
  try {
    const current = JSON.parse(await readFile(new URL('../src/preview-documents/current-folio.json', import.meta.url), 'utf8'));
    const collection = Array.from({ length: 26 }, (_, index) => ({ id: `app-${index}`, value: { ...current } }));
    const siteApps = collection.slice(0, 17).map(({ id, value }) => ({ slug: id, sourceSha: value.sourceSha256, exampleData: true }));
    const documents = join(destination, 'documents'), siteOutput = join(destination, 'site');
    await publishPreviewCollection({ collection, documents, siteOutput, siteApps });
    assert.equal((await readdir(documents)).length, 26);
    assert.equal((await readdir(siteOutput)).length, 18);
    assert.deepEqual(JSON.parse(await readFile(join(siteOutput, 'manifest.json'), 'utf8')), { apps: siteApps });
    assert.equal(await readFile(join(siteOutput, 'app-16.html'), 'utf8'), current.html);
  } finally { await rm(destination, { recursive: true, force: true }); }
});
