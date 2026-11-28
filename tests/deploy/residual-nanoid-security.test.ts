import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

const root = createRequire(new URL("../../package.json", import.meta.url));
const excalidraw = createRequire(root.resolve("@excalidraw/excalidraw"));
const converter = createRequire(excalidraw.resolve("@excalidraw/mermaid-to-excalidraw"));
const nanoidRoot = dirname(converter.resolve("nanoid"));
const entries = ["index.js", "index.browser.js", "non-secure/index.js", "async/index.js", "async/index.browser.js", "async/index.native.js", "nanoid.js"];

// Every published implementation executes in a bounded child. Native's optional
// expo-random bridge is the sole fixture: real Node CSPRNG supplies those bytes.
// The bridge enforces expo-random's documented 1024-byte per-call maximum.
// It checks the actual native algorithm without claiming an iPhone validation.
const program = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { webcrypto, randomFill, randomFillSync } from 'node:crypto';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
const [directory, entry, scenario] = process.argv.slice(1);
const cryptoCalls = [];
const cryptoBridge = { getRandomValues(bytes) { cryptoCalls.push(bytes.byteLength); return webcrypto.getRandomValues(bytes); } };
const context = createContext({ crypto: cryptoBridge, Buffer, console });
const modules = new Map();
let entropyFailed = false, entropyCalls = 0;
function entropyFill(bytes) {
  entropyCalls++;
  const failAt = scenario === 'entropy' ? 1 : scenario.startsWith('entropy-') ? 2 : -1;
  if (entropyCalls === failAt && !entropyFailed) {
    entropyFailed = true; bytes.fill(0); throw Error('synthetic entropy failure');
  }
  return randomFillSync(bytes);
}
async function load(path) {
  if (modules.has(path)) return modules.get(path);
  const m = new SourceTextModule(readFileSync(path, 'utf8'), { context, identifier: path });
  modules.set(path, m);
  await m.link(async (specifier, parent) => {
    if (specifier === 'crypto') return new SyntheticModule(['randomFill', 'randomFillSync'], function () {
      this.setExport('randomFill', randomFill); this.setExport('randomFillSync', entropyFill);
    }, { context });
    if (specifier === 'expo-random') return new SyntheticModule(['getRandomBytesAsync'], function () {
      this.setExport('getRandomBytesAsync', async n => {
        if (n > 1024) throw new TypeError('expo-random byteCount exceeds 1024');
        cryptoCalls.push(n); return webcrypto.getRandomValues(new Uint8Array(n));
      });
    }, { context });
    return load(resolve(parent.identifier, '..', specifier));
  });
  return m;
}
const module = await load(join(directory, entry)); await module.evaluate(); const n = module.namespace;
async function rejects(action) {
  let rejected = false;
  try { await action(); } catch (e) { assert.equal(e.name, 'RangeError'); rejected = true; }
  assert.equal(rejected, true, 'invalid size accepted');
}
if (scenario.startsWith('entropy')) {
  if (scenario === 'entropy-refill') for (let i = 0; i < 128; i++) n.nanoid();
  if (scenario === 'entropy-growth') n.nanoid();
  assert.throws(() => n.nanoid(scenario === 'entropy-growth' ? 3000 : 21), /synthetic entropy failure/);
  const ids = new Set(Array.from({ length: 256 }, () => n.nanoid()));
  assert.equal(ids.size, 256);
  for (const id of ids) assert.notEqual(id, 'u'.repeat(21));
} else if (scenario === 'invalid') {
  for (const size of [-1, 0.5, NaN, Infinity, -Infinity, 2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    await rejects(() => n.nanoid(size));
    if (n.random) await rejects(() => n.random(size));
    if (n.customAlphabet) {
      await rejects(() => n.customAlphabet('abc', size)());
      await rejects(() => n.customAlphabet('abc', 21)(size));
    }
    if (n.customRandom) {
      await rejects(() => n.customRandom('abc', size, n.random)());
      await rejects(() => n.customRandom('abc', 21, n.random)(size));
    }
  }
} else if (scenario === 'zero') {
  assert.equal(await n.nanoid(0), '');
  if (n.random) assert.equal((await n.random(0)).length, 0);
  if (n.customAlphabet) {
    assert.equal(await n.customAlphabet('abc', 0)(), '');
    assert.equal(await n.customAlphabet('abc', 21)(0), '');
    assert.equal((await n.customAlphabet('abc', 0)(7)).length, 7);
  }
  if (n.customRandom) {
    let calls = 0;
    assert.equal(n.customRandom('abc', 0, () => { calls++; throw Error('must not request entropy'); })(), '');
    assert.equal(calls, 0);
  }
} else if (scenario === 'compatibility') {
  const ids = new Set();
  for (let i = 0; i < 256; i++) { const id = await n.nanoid(); assert.match(id, /^[A-Za-z0-9_-]{21}$/); ids.add(id); }
  assert.equal(ids.size, 256);
  assert.equal((await n.nanoid(7)).length, 7);
  if (n.customAlphabet) for (const alphabet of ['a', 'abc', '0123456789abcdef']) {
    const generator = n.customAlphabet(alphabet, 17);
    assert.equal((await generator()).length, 17);
    assert.equal((await generator(3)).length, 3);
    assert.ok([...(await generator())].every(c => alphabet.includes(c)));
  }
  if (n.customRandom) assert.equal(n.customRandom('abc', 7, size => new Uint8Array(size))(), 'aaaaaaa');
} else if (scenario === 'large') {
  const limit = entry === 'async/index.native.js' ? 1024 : 65536;
  assert.equal((await n.nanoid(Math.min(limit, 50000))).length, Math.min(limit, 50000));
  if (n.random) assert.equal((await n.random(Math.min(limit, 50000))).length, Math.min(limit, 50000));
  if (n.customAlphabet) for (const defaultSize of [21, 0, 50000]) for (const size of [50000, 257]) {
    cryptoCalls.length = 0;
    const id = await n.customAlphabet('abc', defaultSize)(size);
    assert.equal(id.length, size); assert.match(id, /^[abc]+$/);
    assert.ok(cryptoCalls.every(count => count <= limit));
    if (defaultSize === 21 && (entry.includes('browser') || entry.includes('native'))) {
      assert.ok(cryptoCalls.every(count => count === 34), 'nonzero default batch changed');
    }
  }
  if (n.customRandom) for (const defaultSize of [21, 0]) {
    const requested = [];
    const id = n.customRandom('abc', defaultSize, size => { requested.push(size); return new Uint8Array(size); })(50000);
    assert.equal(id, 'a'.repeat(50000));
    if (defaultSize === 21) assert.ok(requested.every(size => size === 34), 'nonzero default batch changed');
    else assert.ok(requested.every(size => size > 0 && size <= 65536));
    const batches = [];
    const exact = n.customRandom('ab', 5, size => { batches.push(size); return new Uint8Array(size); })(30);
    assert.equal(exact, 'a'.repeat(30));
    const expected = entry.includes('browser') ? 5 : 4;
    assert.ok(batches.every(size => size === expected), 'legacy integer rounding changed');
  }
} else if (scenario === 'pool') {
  await n.nanoid();
  for (const size of [-1, 0.5, 2 ** 31]) await rejects(() => n.nanoid(size));
  const ids = new Set(Array.from({ length: 256 }, () => n.nanoid()));
  assert.equal(ids.size, 256);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{21}$/);
}
process.stdout.write('passed');
`;

function verify(entry: string, scenario: string) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", program, nanoidRoot, entry, scenario], {
    timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 32_768, env: {},
  });
  expect(result.error, `${entry}/${scenario} exceeded its process deadline`).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe("passed");
}

describe.each(entries)("nanoid 4 security backport (%s)", entry => {
  it("rejects invalid sizes before entropy or iteration", () => verify(entry, "invalid"));
  it("returns empty results for zero sizes without looping", () => verify(entry, "zero"));
  it("preserves valid default, custom and explicit size APIs", () => verify(entry, "compatibility"));
  it("preserves large overrides within entropy-provider batch limits", () => verify(entry, "large"));
});
it("keeps the Node entropy pool intact after invalid requests", () => verify("index.js", "pool"));
it.each(["entropy", "entropy-refill", "entropy-growth"])("discards a pool after %s failure", scenario => verify("index.js", scenario));

it("preserves the actual Mermaid converter's image/file ID linkage", async () => {
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const entry = pathToFileURL(join(dirname(excalidraw.resolve("@excalidraw/mermaid-to-excalidraw")), "converter/types/graphImage.js")).href;
  const { GraphImageConverter } = await import(/* @vite-ignore */ entry);
  const graph = { type: "graphImage", width: 17, height: 23, mimeType: "image/png", dataURL: "data:image/png;base64,c3ludGhldGlj" };
  const first = GraphImageConverter.convert(graph, {}), second = GraphImageConverter.convert(graph, {});
  const id = first.elements[0].fileId;
  expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  expect(second.elements[0].fileId).not.toBe(id);
  expect(first.elements[0]).toMatchObject({ type: "image", width: 17, height: 23 });
  expect(first.files[id]).toEqual({ id, mimeType: graph.mimeType, dataURL: graph.dataURL });
});
