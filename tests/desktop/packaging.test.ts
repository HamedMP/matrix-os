import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

describe("desktop packaging", () => {
  it("registers canonical and legacy macOS URL schemes", () => {
    const raw = readFileSync(join(process.cwd(), "desktop/electron-builder.yml"), "utf8");
    const config = parseDocument(raw).toJS() as {
      protocols?: Array<{ schemes?: string[] }>;
    };

    const schemes = config.protocols?.flatMap((protocol) => protocol.schemes ?? []) ?? [];
    expect(schemes).toContain("matrixos");
    expect(schemes).toContain("matrix-os");
  });
});
