import { describe, it, expect } from "vitest";
import { formatForChannel } from "../../../packages/gateway/src/channels/format.js";

describe("formatForChannel", () => {
  const markdown = "**Hello** _world_\n\n- item 1\n- item 2\n\n`code`";

  it("passes markdown through for discord", () => {
    const result = formatForChannel("discord", markdown);
    expect(result).toContain("**Hello**");
    expect(result).toContain("_world_");
  });

  it("converts bold and italic to Telegram MarkdownV2", () => {
    const result = formatForChannel("telegram", "**bold** and _italic_");
    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
  });

  it("escapes Telegram special characters", () => {
    const result = formatForChannel("telegram", "price is $10.50 (USD)");
    expect(result).toContain("\\$");
    expect(result).toContain("\\.");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
  });

  it("converts bold to Slack mrkdwn format", () => {
    const result = formatForChannel("slack", "**bold** text");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("**");
  });

  it("converts inline code for Slack", () => {
    const result = formatForChannel("slack", "use `npm install`");
    expect(result).toContain("`npm install`");
  });

  it("strips markdown for WhatsApp to plain text", () => {
    const result = formatForChannel("whatsapp", "**bold** and _italic_ and `code`");
    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
    expect(result).toContain("code");
  });

  it("handles empty string", () => {
    expect(formatForChannel("telegram", "")).toBe("");
    expect(formatForChannel("discord", "")).toBe("");
  });

  it("handles plain text without formatting", () => {
    const plain = "Just a simple message";
    expect(formatForChannel("telegram", plain)).toContain("Just a simple message");
    expect(formatForChannel("discord", plain)).toBe(plain);
    expect(formatForChannel("slack", plain)).toBe(plain);
    expect(formatForChannel("whatsapp", plain)).toBe(plain);
  });

  it("preserves code blocks for Telegram", () => {
    const result = formatForChannel("telegram", "```\nconst x = 1;\n```");
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
  });

  it("converts links for Slack", () => {
    const result = formatForChannel("slack", "[click here](https://example.com)");
    expect(result).toContain("<https://example.com|click here>");
  });
});
