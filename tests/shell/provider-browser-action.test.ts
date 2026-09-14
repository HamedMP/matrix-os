// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { openProviderAuthorizationPath } from "../../shell/src/lib/provider-browser-action.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider browser authorization", () => {
  it("opens only a contract-valid gateway-relative authorization path", () => {
    window.history.replaceState({}, "", "/vm/preview/settings?runtime=pr-1");
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    expect(openProviderAuthorizationPath("/api/ai/providers/login-attempts/attempt-1/authorize")).toBe(true);
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/vm/preview/~runtime/pr-1/api/ai/providers/login-attempts/attempt-1/authorize`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it.each([
    "https://provider.example/authorize?token=secret",
    "//provider.example/authorize",
    "/api/ai/providers/login-attempts/../authorize",
    "/api/ai/providers/login-attempts/attempt-1/authorize?token=secret",
  ])("rejects non-canonical or external paths: %s", (path) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openProviderAuthorizationPath(path)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
