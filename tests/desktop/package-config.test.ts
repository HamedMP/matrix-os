import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync("apps/desktop/electron-builder.yml", "utf8");

describe("desktop packaging config", () => {
  it("uses signed release metadata for macOS and Windows targets", () => {
    expect(config).toContain("appId: com.matrixos.desktop");
    expect(config).toContain("hardenedRuntime: true");
    expect(config).toContain("entitlements: build/entitlements.mac.plist");
    expect(config).toContain("signAndEditExecutable: true");
    expect(config).toContain("publisherName:");
    expect(config).toContain("Matrix OS");
  });
});
