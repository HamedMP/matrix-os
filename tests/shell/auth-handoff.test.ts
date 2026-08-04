import { describe, expect, it } from "vitest";
import {
  resolveShellAuthRedirectPath,
  resolveShellAuthRedirectUrl,
} from "../../shell/src/lib/auth-handoff.js";

describe("shell auth handoffs", () => {
  it("preserves only the fixed T3 Connect request", () => {
    expect(
      resolveShellAuthRedirectPath(
        "https://app.matrix-os.com/?launch=__terminal__&terminal_action=t3-connect",
      ),
    ).toBe("/?launch=__terminal__&terminal_action=t3-connect");
    expect(
      resolveShellAuthRedirectPath(
        "https://preview.matrix-os.com/vm/pr-1126?launch=__terminal__&terminal_action=t3-connect",
      ),
    ).toBe("/vm/pr-1126?launch=__terminal__&terminal_action=t3-connect");
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

  it("builds an absolute Clerk redirect from the configured public origin", () => {
    expect(
      resolveShellAuthRedirectUrl(
        "http://matrix-platform-preview.internal/vm/pr-1126?launch=__terminal__&terminal_action=t3-connect",
        "https://preview.matrix-os.com",
      ),
    ).toBe(
      "https://preview.matrix-os.com/vm/pr-1126?launch=__terminal__&terminal_action=t3-connect",
    );
  });
});
