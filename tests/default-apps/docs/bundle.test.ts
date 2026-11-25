import { describe, expect, it } from "vitest";
import { type BuiltChunk, buildAppJavaScript, singleChunkProblems } from "../single-chunk";

/** An image the code resolves to a URL beside its chunk: `new URL("x.png", import.meta.url)`. */
const IMAGE_FILE_URL = /new URL\(\s*["'`][^"'`]+\.(?:png|jpe?g|gif|webp|svg)["'`]/;

let built: Promise<BuiltChunk[]> | null = null;
function docsJavaScript(): Promise<BuiltChunk[]> {
  built ??= buildAppJavaScript("docs");
  return built;
}

// Outcome: every Docs panel (Review, Assistant, Compare) loads inside the sandboxed app frame.
// Fault: a split-off chunk is fetched from the frame's null origin, refused, and the panel shows
// "This panel stopped working".
describe("Docs bundle", () => {
  it("ships its JavaScript as one file, with no chunk loaded later", async () => {
    expect(singleChunkProblems(await docsJavaScript())).toEqual([]);
  }, 60_000);

  // Outcome: the start screen artwork shows inside the sandboxed app frame.
  // Fault: the image is a separate file the frame requests from its null origin, and it shows broken.
  it("carries its images inside the JavaScript instead of loading them as files", async () => {
    const code = (await docsJavaScript()).map((chunk) => chunk.code).join("\n");
    expect(IMAGE_FILE_URL.exec(code)?.[0] ?? null).toBeNull();
    expect(code.includes("data:image/png;base64,")).toBe(true);
  }, 60_000);
});

describe("singleChunkProblems", () => {
  it("reports extra chunks and relative dynamic imports", () => {
    expect(singleChunkProblems([{ fileName: "index.js", code: "x()" }])).toEqual([]);
    expect(singleChunkProblems([{ fileName: "index.js", code: 'const p = import("./Panel-1.js")' }])).toEqual(["index.js loads a relative chunk with a dynamic import"]);
    expect(singleChunkProblems([
      { fileName: "index.js", code: "" },
      { fileName: "react.js", code: "" },
    ])).toEqual(["expected 1 JavaScript file, got 2: index.js, react.js"]);
  });
});
