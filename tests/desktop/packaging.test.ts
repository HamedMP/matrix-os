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

  it("uses the minimal Electron hardened-runtime entitlements for macOS", () => {
    const root = process.cwd();
    const raw = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");
    const config = parseDocument(raw).toJS() as {
      mac?: { entitlements?: string; entitlementsInherit?: string; hardenedRuntime?: boolean };
    };

    expect(config.mac?.hardenedRuntime).toBe(true);
    expect(config.mac?.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac?.entitlementsInherit).toBe("build/entitlements.mac.plist");

    const entitlements = readFileSync(join(root, "desktop/build/entitlements.mac.plist"), "utf8");
    const entitlementKeys = Array.from(entitlements.matchAll(/<key>([^<]+)<\/key>/g), (match) => match[1]);

    expect(entitlementKeys).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]);
    expect(entitlementKeys).not.toContain("com.apple.security.app-sandbox");
    expect(entitlementKeys).not.toContain("com.apple.security.network.client");
    expect(entitlementKeys).not.toContain("com.apple.security.files.user-selected.read-write");
  });
});
