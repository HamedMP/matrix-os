import { describe, expect, it } from "vitest";
import { APP_IFRAME_SANDBOX, appIframeSandbox, appIframePermissions, injectBridgeIntoAppHtml } from "../../shell/src/components/app-viewer-helpers";

describe("Utilities sandbox policy", () => {
  it("permits explicit result downloads only for Utilities and retains opaque isolation", () => {
    expect(appIframeSandbox("apps/utilities/index.html")).toContain("allow-downloads");
    expect(appIframeSandbox("/apps/utilities/")).toContain("allow-popups-to-escape-sandbox");
    expect(appIframeSandbox("apps/ordinary/index.html")).not.toContain("allow-popups-to-escape-sandbox");
    expect(appIframeSandbox("apps/utilities/index.html")).not.toContain("allow-same-origin");
    expect(appIframeSandbox("apps/ordinary/index.html")).toBe(APP_IFRAME_SANDBOX);
  });
  it("delegates clipboard write only to Utilities", () => {
    expect(appIframePermissions("apps/utilities/index.html")).toBe("clipboard-write");
    expect(appIframePermissions("apps/ordinary/index.html")).toBeUndefined();
  });
  it("adds only model and worker sources for the bundled Utilities route", () => {
    const html = injectBridgeIntoAppHtml("<head></head>", "Utilities", {}, "/apps/utilities/");
    expect(html).toContain("'wasm-unsafe-eval'");
    expect(html).toContain("worker-src 'self' blob: https://cdn.jsdelivr.net");
    expect(html).toContain("https://huggingface.co");
    expect(APP_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });
  it.each([
    "/vm/example/apps/utilities/",
    "/vm/example/~runtime/preview-2/apps/utilities/",
    "https://app.matrix-os.com/vm/example/apps/utilities/",
    "https://app.matrix-os.com/vm/example/~runtime/preview-2/apps/utilities/",
    "http://localhost:3000/vm/test_1/apps/utilities/",
  ])("preserves recording/export policy on the explicit computer route %s", (base) => {
    const html = injectBridgeIntoAppHtml("<head></head>", "Utilities", {}, base);
    expect(html).toContain("media-src 'self' blob:");
    expect(appIframePermissions(base)).toBe("clipboard-write");
    expect(appIframeSandbox(base)).toContain("allow-downloads");
    expect(appIframeSandbox(base)).not.toContain("allow-same-origin");
  });
  it.each([
    "/vm/example/apps/utilities-lookalike/",
    "/vm/example/files/apps/utilities/",
    "/vm/example/apps/utilities/../ordinary/",
    "/vm/example/~runtime/../apps/utilities/",
    "/vm/example/extra/apps/utilities/",
    "/vm/" + "x".repeat(65) + "/apps/utilities/",
    "/vm/example/~runtime/" + "x".repeat(33) + "/apps/utilities/",
  ])("keeps privileged capabilities off unsupported computer routes %s", (base) => {
    const html = injectBridgeIntoAppHtml("<head></head>", "Utilities", {}, base);
    expect(html).not.toContain("media-src 'self' blob:");
    expect(appIframePermissions(base)).toBeUndefined();
    expect(appIframeSandbox(base)).toBe(APP_IFRAME_SANDBOX);
  });
  it.each(["/apps/not-utilities/", "/apps/utilities-lookalike/", "/files/apps/utilities/", "/apps/utilities/../ordinary/"])('keeps ordinary app policy at %s', (base) => {
    const html = injectBridgeIntoAppHtml("<head></head>", "Utilities", {}, base);
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toContain("huggingface");
    expect(html).not.toContain("'wasm-unsafe-eval'");
  });
});
