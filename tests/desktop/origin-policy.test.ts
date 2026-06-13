import { describe, expect, it } from "vitest";
import { isNavigationAllowed, resolveLaunchUrl } from "@desktop/main/embeds/origin-policy";

const GATEWAY = "https://app.matrix-os.com";

describe("resolveLaunchUrl", () => {
  it("resolves a relative launch url against the gateway origin", () => {
    expect(resolveLaunchUrl("/apps/notes/", GATEWAY)).toBe("https://app.matrix-os.com/apps/notes/");
  });

  it("preserves query and hash", () => {
    expect(resolveLaunchUrl("/apps/notes/?token=abc#view", GATEWAY)).toBe(
      "https://app.matrix-os.com/apps/notes/?token=abc#view",
    );
  });

  it("rejects protocol-relative urls", () => {
    expect(resolveLaunchUrl("//evil.com/apps", GATEWAY)).toBeNull();
    expect(resolveLaunchUrl("//app.matrix-os.com/apps", GATEWAY)).toBeNull();
  });

  it("rejects absolute urls even when same-origin", () => {
    expect(resolveLaunchUrl("https://evil.com/apps", GATEWAY)).toBeNull();
    expect(resolveLaunchUrl("https://app.matrix-os.com/apps", GATEWAY)).toBeNull();
    expect(resolveLaunchUrl("https://app.matrix-os.com.evil.tld/apps", GATEWAY)).toBeNull();
  });

  it("rejects scheme'd urls", () => {
    expect(resolveLaunchUrl("javascript:alert(1)", GATEWAY)).toBeNull();
    expect(resolveLaunchUrl("data:text/html,hi", GATEWAY)).toBeNull();
  });

  it("rejects empty and non-rooted paths", () => {
    expect(resolveLaunchUrl("", GATEWAY)).toBeNull();
    expect(resolveLaunchUrl("apps/notes", GATEWAY)).toBeNull();
  });

  it("allows path traversal that stays same-origin", () => {
    expect(resolveLaunchUrl("/apps/../api/files", GATEWAY)).toBe(
      "https://app.matrix-os.com/api/files",
    );
    // "/..//evil.com" resolves to a same-origin path ("//evil.com" is a path
    // here, not an authority) — URL resolution + origin equality decides.
    expect(resolveLaunchUrl("/..//evil.com", GATEWAY)).toBe(
      "https://app.matrix-os.com//evil.com",
    );
  });

  it("rejects backslash authority tricks", () => {
    // For special schemes the URL parser treats "/\" like "//" — the resolved
    // origin becomes evil.com, which the origin check rejects.
    expect(resolveLaunchUrl("/\\evil.com", GATEWAY)).toBeNull();
    expect(resolveLaunchUrl("\\\\evil.com", GATEWAY)).toBeNull();
  });

  it("rejects when the gateway origin itself is invalid", () => {
    expect(resolveLaunchUrl("/apps/notes/", "not a url")).toBeNull();
  });
});

describe("isNavigationAllowed", () => {
  const ALLOWED = ["https://app.matrix-os.com"];

  it("allows exact-origin matches only", () => {
    expect(isNavigationAllowed("https://app.matrix-os.com/canvas", ALLOWED)).toBe(true);
    expect(isNavigationAllowed("https://app.matrix-os.com/", ALLOWED)).toBe(true);
  });

  it("rejects scheme, host, and port mismatches", () => {
    expect(isNavigationAllowed("http://app.matrix-os.com/canvas", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("https://app.matrix-os.com:8443/canvas", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("https://evil.com/", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("https://sub.app.matrix-os.com/", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("https://app.matrix-os.com.evil.tld/", ALLOWED)).toBe(false);
  });

  it("rejects invalid urls", () => {
    expect(isNavigationAllowed("not a url", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("", ALLOWED)).toBe(false);
  });

  it("rejects non-http(s) schemes regardless of allowlist", () => {
    expect(isNavigationAllowed("javascript:alert(1)", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("file:///etc/passwd", ALLOWED)).toBe(false);
    expect(isNavigationAllowed("ftp://app.matrix-os.com/", ALLOWED)).toBe(false);
  });

  it("matches against multiple allowed origins", () => {
    const origins = ["https://app.matrix-os.com", "http://localhost:18789"];
    expect(isNavigationAllowed("http://localhost:18789/apps", origins)).toBe(true);
    expect(isNavigationAllowed("http://localhost:9999/apps", origins)).toBe(false);
  });

  it("returns false for an empty allowlist", () => {
    expect(isNavigationAllowed("https://app.matrix-os.com/", [])).toBe(false);
  });

  it("skips malformed allowlist entries without matching", () => {
    expect(isNavigationAllowed("https://app.matrix-os.com/", ["garbage", GATEWAY])).toBe(true);
    expect(isNavigationAllowed("https://evil.com/", ["garbage"])).toBe(false);
  });
});
