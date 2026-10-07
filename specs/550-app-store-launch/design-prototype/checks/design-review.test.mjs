import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { reviewApps, reviewKey, reviewSize } from '../src/review-model.ts';

test('every review entry has two self-contained, integrity-checked source documents', () => {
  assert.equal(reviewApps.length, 17);
  for (const app of reviewApps) for (const edition of ['current', 'original']) {
    const key = reviewKey(app.id, edition);
    const { html, sha256, fictionalOnly } = JSON.parse(readFileSync(new URL(`../src/preview-documents/${key}.json`, import.meta.url), 'utf8'));
    assert.equal(fictionalOnly, true);
    assert.ok(html.length > 1000 && html.length <= 2_000_000);
    assert.equal(createHash('sha256').update(html).digest('hex'), sha256);
    assert.match(html, /connect-src (?:'|&#x27;)none/);
    assert.match(html, /form-action (?:'|&#x27;)none/);
    assert.match(html, /base-uri (?:'|&#x27;)none/);
    // Classic script bodies escape closing tags, including tag-shaped strings.
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length >= 3);
    for (const [, attrs, code] of scripts) {
      assert.ok(!/\bsrc\s*=|type="module"/.test(attrs));
      assert.match(attrs, /nonce="[^"]+"/);
      if (!attrs.includes('application/json')) new Script(code);
    }
    assert.ok(!html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').match(/<link[^>]+rel="stylesheet"/));
  }
  const loader = readFileSync(new URL('../src/usePreviewDocument.ts', import.meta.url), 'utf8');
  assert.ok(loader.includes("'./preview-documents/*.json'"));
  assert.ok(loader.includes('reviewKey(id, edition)'));
});
test('untrusted identifiers and editions cannot become preview keys', () => {
  for (const id of ['../secret', 'https://example.com', 'notes?owner=other', 'unknown']) assert.throws(() => reviewKey(id, 'current'));
  assert.throws(() => reviewKey('notes', '../secret'));
});
test('phone, tablet and desktop are actual distinct app widths', () => {
  assert.deepEqual(reviewSize('phone'), { width: 390, height: 760 });
  assert.deepEqual(reviewSize('tablet'), { width: 768, height: 900 });
  assert.deepEqual(reviewSize('desktop'), { width: 1200, height: 750 });
});
