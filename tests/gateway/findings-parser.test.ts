import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFindingsFile, parseFindingsMarkdown } from "../../packages/gateway/src/findings-parser.js";

describe("findings-parser", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-findings-parser-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("parses structured markdown findings and severity counts", () => {
    const result = parseFindingsMarkdown(`
# Review Round 1

## Findings

### Finding F-001
Severity: high
File: packages/gateway/src/auth.ts
Line: 42
Summary: Token comparison is not constant-time
Details: The branch leaks signature validity through timing.

### Finding F-002
Severity: medium
File: packages/gateway/src/routes.ts
Line: 88
Summary: Missing request size limit
`);

    expect(result).toMatchObject({
      ok: true,
      parserStatus: "success",
      findingsCount: 2,
      severityCounts: { high: 1, medium: 1, low: 0 },
      findings: [
        {
          id: "F-001",
          severity: "high",
          file: "packages/gateway/src/auth.ts",
          line: 42,
          summary: "Token comparison is not constant-time",
        },
        {
          id: "F-002",
          severity: "medium",
          file: "packages/gateway/src/routes.ts",
          line: 88,
          summary: "Missing request size limit",
        },
      ],
    });
  });

  it("treats explicit no-findings markdown as successful convergence input", () => {
    const result = parseFindingsMarkdown(`
# Review Round 2

## Findings
None
`);

    expect(result).toEqual({
      ok: true,
      parserStatus: "success",
      findings: [],
      findingsCount: 0,
      severityCounts: { high: 0, medium: 0, low: 0 },
    });
  });

  it("returns explicit parse failures for ambiguous or incomplete reports", () => {
    expect(parseFindingsMarkdown("Looks good to me")).toMatchObject({
      ok: false,
      parserStatus: "failed",
      error: { code: "findings_section_missing" },
    });

    expect(parseFindingsMarkdown(`
## Findings
### Finding F-001
Severity: high
File: packages/gateway/src/auth.ts
Summary: Missing line
`)).toMatchObject({
      ok: false,
      parserStatus: "failed",
      error: { code: "finding_field_missing" },
    });
  });

  it("rejects unsafe file paths instead of returning raw parser output", () => {
    expect(parseFindingsMarkdown(`
## Findings
### Finding F-001
Severity: low
File: ../../.env
Line: 1
Summary: Unsafe path
`)).toMatchObject({
      ok: false,
      parserStatus: "failed",
      error: { code: "invalid_finding_path", message: "Finding path is invalid" },
    });
  });

  it("parses findings from a file path", async () => {
    const path = join(homePath, "round.md");
    await writeFile(path, `
## Findings
### Finding F-001
Severity: low
File: README.md
Line: 3
Summary: Clarify setup
`);

    await expect(parseFindingsFile(path)).resolves.toMatchObject({
      ok: true,
      findingsCount: 1,
      severityCounts: { high: 0, medium: 0, low: 1 },
    });
  });
});
