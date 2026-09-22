import { describe, expect, it } from "vitest";
import { previewKindForPath } from "@desktop/renderer/src/features/files/FilePreviewPane";

describe("Electron File Preview format routing", () => {
  it.each([
    ["report.pdf", "pdf"],
    ["sales.csv", "table"],
    ["sales.tsv", "table"],
    ["interview.mp3", "audio"],
    ["demo.mp4", "video"],
    ["preview.html", "html"],
  ] as const)("routes %s to the %s renderer", (path, expected) => {
    expect(previewKindForPath(path)).toBe(expected);
  });
});
