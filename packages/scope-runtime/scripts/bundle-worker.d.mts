import type { BuildResult } from "esbuild";

export function bundleScopeWorker(options: {
  entry: string;
  outfile: string;
  requireShim?: boolean;
  write?: boolean;
}): Promise<BuildResult<{ metafile: true }>>;
