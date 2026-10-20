import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { extractRawText } from "../../packages/kernel/src/tools/web-utils.js";

describe("extractRawText", () => {
  it.each([
    ["ordinary markup", "<h1>Hello</h1><p>World</p>", "Hello World"],
    ["whitespace", " <p> Hello\n\t World </p> ", "Hello World"],
    ["script content", "before<script>hidden <div>text</div></script>after", "beforeafter"],
    ["style content", "before<style>.hidden { color: red; }</style>after", "beforeafter"],
    ["case-insensitive elements", "<SCRIPT data-x='1'>hidden</sCrIpT><STYLE>hidden</style>visible", "visible"],
    ["repeated complete elements", "a<script>hidden</script>b<script>hidden</script>c", "abc"],
    ["unmatched script opening", "before<script>visible text", "before visible text"],
    ["unmatched style opening", "before<style>visible text", "before visible text"],
    ["unterminated markup", "text <unfinished", "text <unfinished"],
    ["empty brackets", "before<>after", "before<>after"],
  ])("preserves %s fallback behavior", (_label, html, expected) => {
    expect(extractRawText(html)).toBe(expected);
  });

  // A subprocess bounds the test even if synchronous extraction regresses.
  it.each([
    ["script openings", "<script>", "tail"],
    ["style openings", "<style>", "tail"],
    ["unterminated tags", "<", undefined],
  ])("finishes bounded malformed input with repeated %s", async (_label, token, expected) => {
    const moduleUrl = new URL("../../packages/kernel/src/tools/web-utils.ts", import.meta.url).href;
    const script = `
      import { extractRawText } from ${JSON.stringify(moduleUrl)};
      const input = ${JSON.stringify(token)}.repeat(100_000) + "tail";
      const expected = ${expected === undefined ? "input" : JSON.stringify(expected)};
      process.stdout.write(String(extractRawText(input) === expected));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 2_000,
      maxBuffer: 1024,
    });
    expect(stdout).toBe("true");
  });
});


describe("raw element tag boundaries", () => {
  it("drops raw bodies closed with whitespace or attributes", () => {
    expect(extractRawText('<p>Keep</p><script>secret()</script ><style>p{}</style foo="bar"><p>Also</p>')).toBe("Keep Also");
  });
  it("keeps script/style-prefixed ordinary element text", () => {
    expect(extractRawText("<scripture>Visible</scripture><styleguide>Still visible</styleguide><script>hidden</script><style>hidden</style>"))
      .toBe("Visible Still visible");
  });
  it("removes balanced split fragments while returning plain text", () => {
    const text = extractRawText("<p>A</p><scr<script></script>ipt>evil()</script><p>B</p>");
    expect(text).not.toMatch(/<script|<style/i);
    expect(text).toContain("A"); expect(text).toContain("B");
  });
});
