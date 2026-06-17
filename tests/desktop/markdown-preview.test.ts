import { describe, expect, it } from "vitest";
import {
  MARKDOWN_PREVIEW_CLASS_NAME,
  safeUrlTransform,
} from "@desktop/renderer/src/features/editor/MarkdownPreview";

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

  it("suppresses bullets on GFM task lists", () => {
    expect(MARKDOWN_PREVIEW_CLASS_NAME).toContain("[&_ul.contains-task-list]:!list-none");
    expect(MARKDOWN_PREVIEW_CLASS_NAME).toContain("[&_li.task-list-item]:!list-none");
  });
});
