import { describe, expect, it } from "vitest";
import { buildAppJavaScript, singleChunkProblems } from "../single-chunk";

// Outcome: every Docs panel (Review, Assistant, Compare) loads inside the sandboxed app frame.
// Fault: a split-off chunk is fetched from the frame's null origin, refused, and the panel shows
// "This panel stopped working".
describe("Docs bundle", () => {
  it("ships its JavaScript as one file, with no chunk loaded later", async () => {
    expect(singleChunkProblems(await buildAppJavaScript("docs"))).toEqual([]);
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
