import { describe, expect, it } from "vitest";
import {
  mergeSavedPages,
  parseSavedPages,
} from "@desktop/renderer/src/features/browser/saved-pages";

describe("Matrix Browser saved pages", () => {
  it("merges imported pages by normalized URL without losing existing titles", () => {
    expect(mergeSavedPages(
      [{ title: "Mine", url: "https://example.com/", folder: "Personal" }],
      [
        { title: "Imported", url: "https://example.com/", folder: "Arc tabs" },
        { title: "Second", url: "https://second.example/", folder: "Arc tabs" },
      ],
    )).toEqual([
      { title: "Mine", url: "https://example.com/", folder: "Personal" },
      { title: "Second", url: "https://second.example/", folder: "Arc tabs" },
    ]);
  });

  it("drops malformed and unsafe pages from persisted browser data", () => {
    expect(parseSavedPages(JSON.stringify([
      { title: "Safe", url: "https://example.com/", folder: "Work" },
      { title: "Unsafe", url: "javascript:alert(1)", folder: "Work" },
      { title: "Credentials", url: "https://user:pass@example.com/", folder: "Work" },
    ]))).toEqual([{ title: "Safe", url: "https://example.com/", folder: "Work" }]);
  });
});
