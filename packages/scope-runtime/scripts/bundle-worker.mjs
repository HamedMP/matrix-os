/**
 * Bundles a scope-runtime worker entry into one self-contained ESM file. A
 * workload root mounts a single worker file, so the output may import only
 * Node built-ins. Used by the package builds and by the bundle tests.
 *
 *   node scripts/bundle-worker.mjs <entry.ts> <outfile.mjs> [--require-shim]
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const REQUIRE_SHIM = "import { createRequire as __matrixCreateRequire } from \"node:module\";\n"
  + "const require = __matrixCreateRequire(import.meta.url);";

export async function bundleScopeWorker({ entry, outfile, requireShim = false, write = true }) {
  return build({
    entryPoints: [entry],
    outfile,
    write,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: write,
    metafile: true,
    legalComments: "none",
    logLevel: "error",
    ...(requireShim ? { banner: { js: REQUIRE_SHIM } } : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entry, outfile, flag] = process.argv.slice(2);
  if (!entry || !outfile || (flag !== undefined && flag !== "--require-shim")) {
    console.error("usage: bundle-worker.mjs <entry> <outfile> [--require-shim]");
    process.exit(2);
  }
  await bundleScopeWorker({ entry, outfile, requireShim: flag === "--require-shim" });
}
