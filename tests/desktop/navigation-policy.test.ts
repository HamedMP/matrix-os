import { describe, expect, it, vi } from "vitest";
import {
  createWindowOpenHandler,
  isAllowedExternalUrl,
  isAllowedShellNavigation,
  normalizeMatrixDesktopUrl,
} from "../../apps/desktop/src/main/security.js";

describe("desktop navigation policy", () => {
  it("accepts only http and https Matrix shell URLs", () => {
    expect(normalizeMatrixDesktopUrl("https://matrix.example.com/shell")).toBe(
      "https://matrix.example.com/shell",
    );
    expect(normalizeMatrixDesktopUrl("http://localhost:3000")).toBe("http://localhost:3000/");

    expect(() => normalizeMatrixDesktopUrl("file:///tmp/index.html")).toThrow("Invalid desktop URL");
    expect(() => normalizeMatrixDesktopUrl("javascript:alert(1)")).toThrow("Invalid desktop URL");
    expect(() => normalizeMatrixDesktopUrl("matrix://shell")).toThrow("Invalid desktop URL");
  });

  it("allows in-shell navigation only within configured Matrix origins", () => {
    const allowedOrigins = new Set(["http://localhost:3000", "https://matrix.example.com"]);

    expect(isAllowedShellNavigation("http://localhost:3000/workspace", allowedOrigins)).toBe(true);
    expect(isAllowedShellNavigation("https://matrix.example.com/apps", allowedOrigins)).toBe(true);
    expect(isAllowedShellNavigation("https://evil.example.com/apps", allowedOrigins)).toBe(false);
    expect(isAllowedShellNavigation("file:///tmp/secret", allowedOrigins)).toBe(false);
  });

  it("opens external URLs only for safe web protocols", () => {
    expect(isAllowedExternalUrl("https://github.com/hamedmp/matrix-os")).toBe(true);
    expect(isAllowedExternalUrl("mailto:support@matrix-os.com")).toBe(true);

    expect(isAllowedExternalUrl("file:///Users/alice/.ssh/id_rsa")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });

  it("denies window.open by default and delegates safe external URLs", async () => {
    const openExternal = vi.fn(async () => {});
    const handler = createWindowOpenHandler({ openExternal });

    expect(await handler({ url: "file:///tmp/secret" })).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();

    expect(await handler({ url: "https://matrix-os.com/docs" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://matrix-os.com/docs");
  });
});
