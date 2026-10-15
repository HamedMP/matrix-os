import { describe, expect, it } from "vitest";
import { generatedChatTitle } from "../../packages/ui/src/generated-chat-title";

describe("generatedChatTitle", () => {
  it("uses markdown link text instead of the URL", () => {
    expect(generatedChatTitle("Summarize [the report](https://example.com/report.pdf) for me")).toBe("Summarize the report for me");
  });

  it("stays fast on unmatched link-like prompts", () => {
    const started = performance.now();
    generatedChatTitle("[".repeat(50_000));
    generatedChatTitle("[!](".repeat(25_000));
    generatedChatTitle(`[${"\\[".repeat(25_000)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
