import { describe, expect, it } from "vitest";
import { authenticatedPlatformHeaders } from "../e2e/helpers/authenticated-platform-headers.js";

describe("authenticatedPlatformHeaders", () => {
  it("reproduces browser cookie and Origin headers for same-origin platform requests", () => {
    const headers = authenticatedPlatformHeaders({
      request: "https://app.matrix-os.com/api/collaboration/direct-sessions",
      platformOrigin: "https://app.matrix-os.com",
      cookieHeader: "__session=member-session",
    });

    expect(headers.get("cookie")).toBe("__session=member-session");
    expect(headers.get("origin")).toBe("https://app.matrix-os.com");
  });

  it("does not forward authentication headers to another origin", () => {
    const headers = authenticatedPlatformHeaders({
      request: "https://runtime.example/api/collaboration/direct-sessions",
      headers: { "x-request-id": "request-1" },
      platformOrigin: "https://app.matrix-os.com",
      cookieHeader: "__session=member-session",
    });

    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("x-request-id")).toBe("request-1");
  });
});
