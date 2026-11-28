import { describe, expect, it } from "vitest";
import { type BuiltChunk, buildAppJavaScript, singleChunkProblems } from "../single-chunk";

/** An image the code resolves to a URL beside its chunk: `new URL("x.png", import.meta.url)`. */
const IMAGE_FILE_URL = /new URL\(\s*["'`][^"'`]+\.(?:png|jpe?g|gif|webp|svg)["'`]/;

let built: Promise<BuiltChunk[]> | null = null;
function sheetsJavaScript(): Promise<BuiltChunk[]> {
  built ??= buildAppJavaScript("sheets");
  return built;
}

describe("Sheets bundle", () => {
  // Outcome: Sheets loads all of its code inside the sandboxed app frame.
  // Fault: a split-off chunk (a separate React chunk, or a lazily loaded panel) is fetched from the
  // frame's null origin, refused, and the app or a panel never loads.
  it("ships its JavaScript as one file, with no chunk loaded later", async () => {
    expect(singleChunkProblems(await sheetsJavaScript())).toEqual([]);
  }, 60_000);

  // Outcome: the artwork of the "No recent workbooks" state shows inside the sandboxed app frame.
  // Fault: the image is a separate file the frame requests from its null origin, and it shows broken.
  it("carries its images inside the JavaScript instead of loading them as files", async () => {
    const code = (await sheetsJavaScript()).map((chunk) => chunk.code).join("\n");
    expect(IMAGE_FILE_URL.exec(code)?.[0] ?? null).toBeNull();
    expect(code.includes("data:image/png;base64,")).toBe(true);
  }, 60_000);
});
