import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Immutable qualification: actual installed Next loader, SWC and icon data.
// Usage: node smoke.mjs /absolute/repo [production-next-trace] [owned-scratch-root]
const repo = resolve(process.argv[2] ?? "/work/web");
const shell = resolve(repo, "shell");
const requireShell = createRequire(resolve(shell, "package.json"));
const nextVersion = requireShell("next/package.json").version;
const frozen = JSON.parse(await readFile("/work/qualification-input.json", "utf8"));
assert.equal(nextVersion, frozen.tools.next, "Frozen Next version differs");
const iconsPackage = requireShell.resolve("@hugeicons/core-free-icons/package.json");
const metadata = JSON.parse(await readFile(iconsPackage, "utf8"));
assert.equal(metadata.version, frozen.tools.icons);
const barrel = resolve(dirname(iconsPackage), metadata.module);
const source = await readFile(resolve(shell, "src/lib/hugeicons.tsx"), "utf8");
const names = [...new Set([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@hugeicons\/core-free-icons["']/g)]
  .flatMap((match) => match[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/)[0])))];
assert(names.length > 0 && names.length <= 2000, "Unexpected icon import inventory");
assert.deepEqual([...names].sort(), frozen.icons, "Candidate source icon inventory differs");
const { default: loader } = requireShell("next/dist/build/webpack/loaders/next-barrel-loader.js");
const React = requireShell("react");
const { renderToStaticMarkup } = requireShell("react-dom/server");
const { HugeiconsIcon } = requireShell("@hugeicons/react");
const owned = await mkdtemp(resolve(process.argv[4] ?? import.meta.dirname, "matrix-icon-smoke-"));
try {
  const generated = await new Promise((accept, reject) => {
    const context = {
      resourcePath: barrel,
      fs,
      async() {},
      cacheable() {},
      clearDependencies() {},
      getOptions: () => ({ names, swcCacheDir: resolve(owned, "swc-cache") }),
      // This package's barrel contains direct re-exports, no wildcard recursion.
      getResolve: () => async () => { throw new Error("Unexpected wildcard export"); },
      callback: (error, code) => error ? reject(error) : accept(code),
    };
    Promise.resolve(loader.call(context)).catch(reject);
  });
  assert(generated.length < 100_000, "Unexpected optimized output size");
  assert(!generated.includes("export *"), "Optimization fell back to entire barrel");
  const absolute = generated.replace(/from\s+(["'])([^"']+)\1/g, (_, quote, target) =>
    `from ${JSON.stringify(pathToFileURL(resolve(dirname(barrel), target)).href)}`);
  const candidatePath = resolve(owned, "optimized.mjs");
  await writeFile(candidatePath, absolute, { flag: "wx" });
  const original = await import(pathToFileURL(barrel).href);
  const candidate = await import(pathToFileURL(candidatePath).href);
  assert.deepEqual(Object.keys(candidate).sort(), [...names].sort(), "Missing or extra optimized icon exports");
  const svg = (icon) => renderToStaticMarkup(React.createElement(HugeiconsIcon, {
    icon, size: 24, strokeWidth: 1.5, "aria-label": "qualification icon",
  }));
  const verify = (namespace) => {
    assert.deepEqual(Object.keys(namespace).sort(), [...names].sort(), "Missing or extra optimized icon exports");
    for (const name of names) {
      assert(Array.isArray(original[name]) && original[name].length > 0, `${name} missing original SVG paths`);
      assert.equal(namespace[name], original[name], `${name} resolves to different module data`);
      assert.deepEqual(namespace[name], original[name], `${name} SVG data changed`);
      assert.equal(svg(namespace[name]), svg(original[name]), `${name} SVG rendering changed`);
    }
  };
  verify(candidate);
  // Negative control: a mistaken alias to another valid icon must be rejected.
  const pair = names.find((name) => candidate[name] !== candidate[names[0]]);
  assert(pair, "Need two distinct icon arrays for negative control");
  assert.throws(() => verify({ ...candidate, [pair]: original[names[0]] }), /resolves to different module data/);
  const missing = { ...candidate }; delete missing[pair];
  assert.throws(() => verify(missing), /Missing or extra optimized icon exports/);
  const report = {
    nextVersion, iconsVersion: metadata.version, comparedExports: names.length,
    distinctIconModules: new Set(names.map((name) => original[name])).size,
    svgRenderComparisons: names.length, negativeAliasControl: "rejected", missingExportControl: "rejected", trace: null,
  };
  if (process.argv[3]) {
    const raw = await readFile(resolve(process.argv[3]), "utf8");
    assert(raw.length <= 50 * 1024 * 1024, "Trace exceeds qualification bound");
    const rows = raw.trim().split("\n").flatMap((line) => {
      const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed];
    });
    const builds = rows.filter((row) => row.name?.startsWith("build-module") &&
      (row.tags?.name?.includes("@hugeicons+core-free-icons@") ||
        row.tags?.name?.includes("/@hugeicons/core-free-icons/")));
    const paths = new Set(builds.map((row) => row.tags.name));
    const optimized = [...paths].filter((path) => path.includes("__barrel_optimize__"));
    assert(optimized.length > 0, "Production trace has no Hugeicons optimizer request");
    const leaves = [...paths].filter((path) => !path.includes("__barrel_optimize__") && !path.endsWith("/index.js"));
    assert(leaves.length <= report.distinctIconModules, "Production build still traverses unused icon leaves");
    report.trace = { optimizerRequests: optimized.length, uniqueIconLeaves: leaves.length, buildSpans: builds.length };
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(owned, { recursive: true, force: true });
}
