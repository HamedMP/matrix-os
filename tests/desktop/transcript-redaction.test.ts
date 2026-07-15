import { describe, expect, it } from "vitest";
import { redactCredentialsForDisplay } from "../../desktop/src/renderer/src/lib/transcript-redaction";

describe("redactCredentialsForDisplay", () => {
  it("masks unambiguous credential patterns", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: Bearer abc123.def-456", "Bearer"],
      ["key is sk-proj-Abc123_def456ghi789", "sk-"],
      [`stripe ${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")}`, "sk_live_"],
      ["aws AKIAIOSFODNN7EXAMPLE", "AKIA"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P", "eyJ"],
      ["gh ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_"],
      ["gh fine-grained github_pat_11ABCDEFG0abcdefghijkl", "github_pat_"],
      ["gitlab glpat-XXyyZZ11-aabbccdd", "glpat-"],
      ["slack xoxb-1234567890-abcdefghij", "xox"],
    ];
    for (const [input, marker] of cases) {
      const output = redactCredentialsForDisplay(input);
      expect(output, input).toContain("[redacted]");
      expect(output, input).not.toContain(input.split(" ").at(-1) as string);
      expect(output.toLowerCase(), `${input} should not keep the secret after ${marker}`).not.toMatch(
        /(sk-proj-abc|sk_live_4ec39|akiaiosfodnn7|ghp_16c7|github_pat_11ab|glpat-xxyyzz|xoxb-1234)/,
      );
    }
  });

  it("masks credentials embedded in connection strings", () => {
    const output = redactCredentialsForDisplay("postgres://matrix:S3cret!@db.internal:5432/app");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("S3cret!");
  });

  it("masks password assignments without eating the surrounding prose", () => {
    const output = redactCredentialsForDisplay("set PASSWORD=hunter2 in the env file");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("in the env file");
  });

  it("masks quoted password assignments", () => {
    const cases = [
      'password="hunter2" in .env',
      "password: 'hunter2' in yaml",
      "password: `hunter2` in a template",
      'DB_PASSWORD = "hunter2"',
    ];
    for (const input of cases) {
      const output = redactCredentialsForDisplay(input);
      expect(output, input).toContain("[redacted]");
      expect(output, input).not.toContain("hunter2");
    }
  });

  it("leaves ordinary coding vocabulary untouched", () => {
    const prose = [
      "The token count exceeded the limit, so I trimmed the prompt.",
      "Keep this value secret by moving it into an env var.",
      "The dev server listens on localhost:3000.",
      "I fixed the unique constraint violation in the Zod schema; see the stack trace in /Users/dev/app/log.txt.",
      "Two issues remain in packages/gateway/src/index.ts.",
      "OpenAI and Anthropic models are both routed through the proxy.",
    ].join("\n");
    expect(redactCredentialsForDisplay(prose)).toBe(prose);
  });

  it("preserves markdown structure around redactions", () => {
    const input = "Run this:\n\n```bash\nexport API_KEY=sk-proj-Abc123_def456ghi789\n```\n\nThen restart.";
    const output = redactCredentialsForDisplay(input);
    expect(output).toContain("```bash");
    expect(output).toContain("Then restart.");
    expect(output).not.toContain("sk-proj-Abc123_def456ghi789");
  });
});
