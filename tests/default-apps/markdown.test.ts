import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../../home/apps/notes/src/markdown";

describe("notes markdown conversion", () => {
  it("renders common markdown blocks for the rich editor", () => {
    const html = markdownToHtml("# Plan\n\n- **Ship** notes\n- Review `board`");

    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Ship</strong>");
    expect(html).toContain("<code>board</code>");
  });
});
