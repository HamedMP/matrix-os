import { describe, expect, it } from "vitest";
import { resolveShellAuthRedirectPath } from "../../shell/src/lib/auth-handoff.js";

describe("shell auth handoffs", () => {
  it("preserves only the fixed T3 Connect request", () => {
    expect(
      resolveShellAuthRedirectPath(
        "https://app.matrix-os.com/?launch=__terminal__&terminal_action=t3-connect",
      ),
    ).toBe("/?launch=__terminal__&terminal_action=t3-connect");
    expect(resolveShellAuthRedirectPath("/?launch=__terminal__")).toBe("/");
    expect(resolveShellAuthRedirectPath("/?terminal_action=t3-connect")).toBe("/");
    expect(
      resolveShellAuthRedirectPath(
        "https://evil.example/?launch=__terminal__&terminal_action=t3-connect",
      ),
    ).toBe("/?launch=__terminal__&terminal_action=t3-connect");
  });

  it("drops unrelated query data", () => {
    expect(resolveShellAuthRedirectPath("/?session=secret")).toBe("/");
    expect(resolveShellAuthRedirectPath(undefined)).toBe("/");
  });
});
