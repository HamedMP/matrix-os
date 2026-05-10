import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  assertSafeBrowserUrl,
  resolveBrowserArtifactPath,
  resolveBrowserProfilePath,
} from "../../packages/mcp-browser/src/security.js";

describe("browser security helpers", () => {
  const homePath = resolve("/tmp/matrix-home");

  it("resolves browser profile names under the owner home", () => {
    expect(resolveBrowserProfilePath(homePath, "work")).toBe(
      join(homePath, "data", "browser-profiles", "work"),
    );
  });

  it("rejects unsafe browser profile names", () => {
    expect(() => resolveBrowserProfilePath(homePath, "../secrets")).toThrow(
      "Invalid browser profile name",
    );
    expect(() => resolveBrowserProfilePath(homePath, "Work")).toThrow(
      "Invalid browser profile name",
    );
  });

  it("confines screenshots and PDFs to the browser artifact directory", () => {
    expect(resolveBrowserArtifactPath(homePath, "page.png", "runs/page.png")).toBe(
      join(homePath, "data", "screenshots", "runs", "page.png"),
    );
    expect(resolveBrowserArtifactPath(homePath, "page.png")).toBe(
      join(homePath, "data", "screenshots", "page.png"),
    );
  });

  it("rejects browser artifact path traversal and absolute paths", () => {
    expect(() => resolveBrowserArtifactPath(homePath, "page.png", "../secret.png")).toThrow(
      "Invalid browser artifact path",
    );
    expect(() => resolveBrowserArtifactPath(homePath, "page.png", "/tmp/page.png")).toThrow(
      "Invalid browser artifact path",
    );
  });

  it("blocks unsupported and local navigation URLs", async () => {
    await expect(assertSafeBrowserUrl("file:///etc/passwd")).rejects.toThrow(
      "Browser navigation URL must use http or https",
    );
    await expect(assertSafeBrowserUrl("http://127.0.0.1:3000")).rejects.toThrow(
      "Browser navigation URL is not allowed",
    );
    await expect(assertSafeBrowserUrl("http://[::1]:3000")).rejects.toThrow(
      "Browser navigation URL is not allowed",
    );
    await expect(assertSafeBrowserUrl("http://[fec0::1]:3000")).rejects.toThrow(
      "Browser navigation URL is not allowed",
    );
  });

  it("checks DNS results for hostname-based navigation URLs", async () => {
    await expect(
      assertSafeBrowserUrl("https://example.com", {
        resolveHostname: async () => ["93.184.216.34"],
      }),
    ).resolves.toBe("https://example.com/");

    await expect(
      assertSafeBrowserUrl("https://internal.example", {
        resolveHostname: async () => ["10.0.0.4"],
      }),
    ).rejects.toThrow("Browser navigation URL is not allowed");

    await expect(
      assertSafeBrowserUrl("https://site-local.example", {
        resolveHostname: async () => ["fec0::1"],
      }),
    ).rejects.toThrow("Browser navigation URL is not allowed");
  });
});
