import { describe, expect, it } from "vitest";
import { buildSupportChatProperties } from "@matrix-os/contracts";

describe("support Chat properties", () => {
  it("uses the active runtime version and native Electron version for Desktop", () => {
    expect(buildSupportChatProperties({
      client: "desktop",
      systemInfo: {
        version: "v2026.08.31-installed",
        runningVersion: "v2026.09.02-running",
        release: { version: "v2026.08.31-release" },
      },
      desktopVersion: "1.4.0-canary.2",
    })).toEqual({
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.02-running",
      matrix_desktop_version: "1.4.0-canary.2",
    });
  });

  it("omits the native app version for Web clients", () => {
    expect(buildSupportChatProperties({
      client: "web",
      systemInfo: { runningVersion: "v2026.09.02-running" },
      desktopVersion: "1.4.0-canary.2",
    })).toEqual({
      matrix_client: "web",
      matrix_bundle_version: "v2026.09.02-running",
    });
  });

  it("falls back to release metadata when no running version is available", () => {
    expect(buildSupportChatProperties({
      client: "web",
      systemInfo: {
        version: "v2026.08.30-package",
        release: { version: "v2026.09.01-release" },
      },
    })).toEqual({
      matrix_client: "web",
      matrix_bundle_version: "v2026.09.01-release",
    });
  });

  it("omits malformed or oversized version metadata", () => {
    expect(buildSupportChatProperties({
      client: "desktop",
      systemInfo: { runningVersion: "../../private/path" },
      desktopVersion: `1.${"0".repeat(129)}`,
    })).toEqual({ matrix_client: "desktop" });
  });
});
