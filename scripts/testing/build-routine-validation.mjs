/** Local qualification artifact only; never publishes or starts a runtime. */
import { mkdir, writeFile, readFile, realpath, symlink, lstat, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bundleScopeWorker } from "../../packages/scope-runtime/scripts/bundle-worker.mjs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const output = process.argv[2];
if (!output) throw new Error("An explicit artifact directory is required");
const root = await realpath(process.cwd());
const out = resolve(output);
if (out === root || out.startsWith(`${root}/`)) throw new Error("Keep qualification artifacts outside the checkout");
await mkdir(out, { recursive: true });
await rm(resolve(out, "build.json"), { force: true });
try { await lstat(resolve(out, "node_modules")); }
catch (error) { if (error.code !== "ENOENT") throw error; await symlink(resolve(root, "node_modules"), resolve(out, "node_modules"), "dir"); }
if (await realpath(resolve(out, "node_modules")) !== await realpath(resolve(root, "node_modules"))) throw new Error("Stale artifact dependencies");
// These exports point to dist. Canonical incremental builds recheck input freshness before bundling.
for (const directory of ["observability", "kernel"]) {
  execFileSync(process.execPath, [resolve(root, "scripts/build-typescript.mjs")], {
    cwd: resolve(root, "packages", directory), timeout: 120000, stdio: "inherit",
  });
}
const artifacts = [];
for (const [entry, name] of [["packages/bot-runtime/src/worker-entry.ts", "bot-worker.mjs"],
  ["tests/fixtures/routine-process.ts", "routine-process.mjs"]]) {
  const result = name === "bot-worker.mjs"
    ? await bundleScopeWorker({ entry, outfile: resolve(out, name), requireShim: true })
    : await build({ entryPoints: [entry], outfile: resolve(out, name), bundle: true, packages: "external",
      platform: "node", format: "esm", target: "node24", sourcemap: true, metafile: true, legalComments: "none",
      banner: { js: 'import { createRequire as __matrixCreateRequire } from "node:module"; const require = __matrixCreateRequire(import.meta.url);' },
      plugins: [{ name: "current-workspace-exports", setup(api) {
        api.onResolve({ filter: /^@(matrix-os|finnaai)\// }, async args => {
          const path = await realpath(fileURLToPath(import.meta.resolve(args.path)));
          if (!path.startsWith(`${root}/`)) throw new Error("Stale workspace export");
          return { path };
        });
      } }],
    });
  const sources = [];
  for (const file of Object.keys(result.metafile.inputs)) {
    if (file.startsWith("<")) continue;
    const bytes = await readFile(resolve(file));
    const actual = await realpath(resolve(file));
    if (/(^|\/)packages\//.test(file) && !actual.startsWith(`${root}/`)) {
      throw new Error(`Stale workspace source: ${relative(root, actual)}`);
    }
    sources.push({ path: file, realPath: actual, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const bytes = await readFile(resolve(out, name));
  artifacts.push({ entry, file: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sources,
    selfContained: name === "bot-worker.mjs", externalImports: Object.values(result.metafile.outputs).flatMap(value => value.imports.filter(i => i.external).map(i => i.path)) });
  await writeFile(resolve(out, `${name}.meta.json`), JSON.stringify(result.metafile, null, 2));
}
await writeFile(resolve(out, "build.json"), JSON.stringify({
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root, node: process.version, builtAt: new Date().toISOString(),
  lockSha256: createHash("sha256").update(await readFile(resolve(root, "pnpm-lock.yaml"))).digest("hex"), artifacts,
}, null, 2));
console.log(JSON.stringify(artifacts.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))));
