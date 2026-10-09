import { appRuntimeNavigation } from "@/lib/app-runtime-navigation";

const runtime = "https://app.matrix-os.com/apps/notes/?session=one-time-token";

describe("app runtime navigation", () => {
  it.each([
    runtime,
    "https://app.matrix-os.com/apps/notes",
    "https://app.matrix-os.com/apps/notes/",
    "https://app.matrix-os.com/apps/notes/editor?id=2#saved",
  ])("keeps the initial session, redirect, and app routes: %s", (target) => {
    expect(appRuntimeNavigation(runtime, target)).toBe("internal");
  });

  it("keeps the selected computer path", () => {
    const selected = "https://app.matrix-os.com/vm/preview/apps/notes/?session=token";
    expect(appRuntimeNavigation(selected, "https://app.matrix-os.com/vm/preview/apps/notes/page"))
      .toBe("internal");
    expect(appRuntimeNavigation(selected, "https://app.matrix-os.com/apps/notes/"))
      .toBe("blocked");
  });

  it.each([
    "https://app.matrix-os.com/apps/notes-other/",
    "https://app.matrix-os.com/apps/tasks/",
    "https://app.matrix-os.com/settings/billing",
    "https://app.matrix-os.com/apps/notes/../../settings",
    "https://app.matrix-os.com/apps/notes/%2f..%2fsettings",
    "https://app.matrix-os.com/apps/notes/%252e%252e/settings",
    "https://app.matrix-os.com.evil.example/apps/notes/",
    "http://app.matrix-os.com/apps/notes/",
    "https://outside.example/",
    "//outside.example/",
    "/apps/notes/",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///apps/notes",
    "matrixos://auth",
    "about:blank",
    "https://user:password@app.matrix-os.com/apps/notes/",
    "https://app.matrix-os.com/apps/notes/\\../settings",
    " https://app.matrix-os.com/apps/notes/",
    "https://app.matrix-os.com/apps/notes/\n",
    "https:app.matrix-os.com/apps/notes/",
    "not a URL",
    "https://app.matrix-os.com/apps/notes/%ZZ",
    "",
    "x".repeat(4_097),
  ])("fails closed without invoking external authorization: %s", (target) => {
    expect(appRuntimeNavigation(runtime, target)).toBe("blocked");
  });

  it("offers only safe cross-origin web links to explicit authorization", () => {
    const allow = jest.fn((url) => url === "https://help.example/guide");
    expect(appRuntimeNavigation(runtime, "https://help.example/guide", allow)).toBe("external");
    expect(appRuntimeNavigation(runtime, "https://help.example/other", allow)).toBe("blocked");
    allow.mockClear();
    for (const target of ["https://app.matrix-os.com/settings", "matrixos://auth", "//help.example", "https://a:b@help.example/"]) {
      expect(appRuntimeNavigation(runtime, target, allow)).toBe("blocked");
    }
    expect(allow).not.toHaveBeenCalled();
  });

  it.each(["broken", "javascript:test", "https://app.matrix-os.com/settings", "https://a:b@app.matrix-os.com/apps/notes/"])
  ("fails closed for an invalid runtime: %s", (source) => {
    expect(appRuntimeNavigation(source, runtime, () => true)).toBe("blocked");
  });

  it("fails closed when external authorization cannot be checked", () => {
    const log = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(appRuntimeNavigation(runtime, "https://help.example/", () => { throw new Error("private detail"); }))
      .toBe("blocked");
    expect(log).toHaveBeenCalledWith("[mobile] app link authorization unavailable", "Error");
    log.mockRestore();
  });
});
