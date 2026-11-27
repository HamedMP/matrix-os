// Default apps run in a sandboxed `srcdoc` iframe whose origin is `null`. A
// JavaScript chunk the entry loads later (a `lazy(() => import(...))` panel,
// any dynamic `import()` of a relative file) is fetched as a CORS module
// request from that null origin and is refused, so the part of the app it
// holds never loads. An office app therefore ships its JavaScript as a single
// file. Call `buildAppJavaScript` and `singleChunkProblems` from each app's
// bundle test.

import { resolve } from "node:path";
import { build } from "vite";

export interface BuiltChunk {
  fileName: string;
  code: string;
}

/** Builds `home/apps/<app>` in memory with its own Vite config and returns its JavaScript chunks. */
export async function buildAppJavaScript(app: string): Promise<BuiltChunk[]> {
  // Vitest sets NODE_ENV=test, which Vite would otherwise bundle (React's development build); build what ships.
  const result = await build({
    root: resolve("home/apps", app),
    mode: "production",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => ("output" in output ? output.output : []));
  return outputs.flatMap((output) => (output.type === "chunk" ? [{ fileName: output.fileName, code: output.code }] : []));
}

/** A dynamic `import(` of a relative file, as Rollup writes one for a split-off chunk. */
const RELATIVE_DYNAMIC_IMPORT = /\bimport\(\s*["'`]\.{1,2}\//;

/** Lists why the build is not one self-contained JavaScript file; empty when it is. */
export function singleChunkProblems(chunks: readonly BuiltChunk[]): string[] {
  const problems: string[] = [];
  if (chunks.length !== 1) problems.push(`expected 1 JavaScript file, got ${chunks.length}: ${chunks.map((chunk) => chunk.fileName).join(", ")}`);
  for (const chunk of chunks) {
    if (RELATIVE_DYNAMIC_IMPORT.test(chunk.code)) problems.push(`${chunk.fileName} loads a relative chunk with a dynamic import`);
  }
  return problems;
}
