import { describe, expect, it } from "vitest";
import { safeUrlTransform } from "@desktop/renderer/src/features/editor/MarkdownPreview";

describe("safeUrlTransform", () => {
  it("allows http, https, mailto, and relative markdown links", () => {
    expect(safeUrlTransform("https://matrix-os.com/docs")).toBe("https://matrix-os.com/docs");
    expect(safeUrlTransform("http://localhost:5173")).toBe("http://localhost:5173");
    expect(safeUrlTransform("mailto:hello@matrix-os.com")).toBe("mailto:hello@matrix-os.com");
    expect(safeUrlTransform("./guide.md")).toBe("./guide.md");
  });

  it("strips javascript links", () => {
    expect(safeUrlTransform("javascript:alert(1)")).toBe("");
  });
});
