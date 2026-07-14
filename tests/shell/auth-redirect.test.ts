import { describe, expect, it } from "vitest";

import { resolveShellAuthRedirect } from "../../shell/src/lib/auth-redirect";

describe("resolveShellAuthRedirect", () => {
  it("preserves an owned preview route and its validated runtime slot", () => {
    expect(resolveShellAuthRedirect(
      "https://app.matrix-os.com/vm/pr-703?runtime=preview",
      "https://app.matrix-os.com",
    )).toBe("/vm/pr-703?runtime=preview");
  });

  it("drops unapproved query parameters from same-origin return paths", () => {
    expect(resolveShellAuthRedirect(
      "/vm/pr-703?runtime=preview&token=secret",
      "https://app.matrix-os.com",
    )).toBe("/vm/pr-703?runtime=preview");
  });

  it.each([
    "https://evil.example/vm/pr-703?runtime=preview",
    "//evil.example/vm/pr-703?runtime=preview",
    "not a valid return URL",
  ])("rejects unsafe return target %s", (target) => {
    expect(resolveShellAuthRedirect(target, "https://app.matrix-os.com")).toBe("/");
  });

  it("falls back to the shell root when no return target is present", () => {
    expect(resolveShellAuthRedirect(undefined, "https://app.matrix-os.com")).toBe("/");
  });

  it("falls back to the shell root when the configured app origin is invalid", () => {
    expect(resolveShellAuthRedirect("/vm/pr-703", "not an origin")).toBe("/");
  });
});
