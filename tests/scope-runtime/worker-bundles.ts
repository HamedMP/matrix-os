import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleScopeWorker } from "../../packages/scope-runtime/scripts/bundle-worker.mjs";

/** Builds a worker exactly as the package build does, into a throwaway directory. */
export async function buildWorkerBundle(entry: string, options: { requireShim?: boolean } = {}) {
  // Node resolves the entry URL through macOS's /var -> /private/var alias.
  // Use the same canonical path in argv so the real worker entry guard runs.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "scope-worker-bundle-")));
  const outfile = join(directory, "worker.mjs");
  const result = await bundleScopeWorker({ entry, outfile, requireShim: options.requireShim ?? false });
  return {
    outfile,
    inputs: Object.keys(result.metafile.inputs),
    imports: Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path)),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
