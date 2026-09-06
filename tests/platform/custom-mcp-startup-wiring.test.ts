import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCustomMcpProjectionUrl } from "../../packages/platform/src/custom-mcp-projection.js";

describe("Custom MCP platform startup wiring", () => {
  it("targets the owner VPS directly instead of unsupported per-handle subdomains", () => {
    expect(buildCustomMcpProjectionUrl({
      status: "running",
      publicIPv4: "8.8.8.8",
    }, "11111111-1111-4111-8111-111111111111")).toBe(
      "https://8.8.8.8:443/api/internal/mcp-projection/11111111-1111-4111-8111-111111111111",
    );
  });

  it("uses the real encryption-key parser and closes the feature-owned database on shutdown or failed startup", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("cryptoModule.parseCustomMcpEncryptionKey(encryptionKeyRaw)");
    expect(source).not.toContain("cryptoModule.loadCustomMcpEncryptionKey");
    expect(source).toContain("await customDb.destroy()");
    expect(source).toMatch(/registerCustomMcpStartupCleanup\(closeCustomMcpDb\);\s*await customDb\.migrate\(\)/);
    expect(source).toMatch(/catch \(startupError: unknown\)[\s\S]*await customMcpStartupCleanup\?\.\(\)[\s\S]*throw startupError/);
  });
});
