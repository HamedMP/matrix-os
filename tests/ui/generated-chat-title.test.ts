import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generatedChatTitle } from "../../packages/ui/src/generated-chat-title";

describe("generatedChatTitle", () => {
  it("uses markdown link text instead of the URL", () => {
    expect(generatedChatTitle("Summarize [the report](https://example.com/report.pdf) for me")).toBe("Summarize the report for me");
  });

  it.each([
    ["Read [report](http://[::1]/x)", "Read report"],
    ["Read [report](https://example.com/[draft]/x)", "Read report"],
    [String.raw`Read [literal \[ bracket](https://example.com/x)`, String.raw`Read literal \[ bracket`],
    ["Read [broken](prefix[the report title](https://example.com/x)", "Read [broken](prefixthe report title"],
  ])("preserves link text in %s", (prompt, expected) => {
    expect(generatedChatTitle(prompt)).toBe(expected);
  });

  it("bounds unmatched and bracketed destination scans with a subprocess deadline", () => {
    const moduleUrl = pathToFileURL(resolve("packages/ui/src/generated-chat-title.ts")).href;
    const script = `import { generatedChatTitle } from ${JSON.stringify(moduleUrl)};
      for (const prompt of ["[".repeat(100_000), "[!](".repeat(100_000), "[x](https://[".repeat(100_000)]) {
        generatedChatTitle(prompt);
      }`;
    expect(() => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      timeout: 2_000, stdio: "pipe",
    })).not.toThrow();
  });
});
