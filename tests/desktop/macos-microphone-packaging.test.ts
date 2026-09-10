import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Electron macOS microphone packaging", () => {
  it("declares a user-facing purpose and the hardened-runtime audio entitlement", async () => {
    const [builder, entitlements] = await Promise.all([
      readFile("desktop/electron-builder.yml", "utf8"),
      readFile("desktop/build/entitlements.mac.plist", "utf8"),
    ]);
    expect(builder).toContain("NSMicrophoneUsageDescription:");
    expect(entitlements).toContain("<key>com.apple.security.device.audio-input</key>");
    expect(entitlements).toMatch(/com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
  });
});
