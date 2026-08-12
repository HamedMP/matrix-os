import { describe, expect, it } from "vitest";
import { safeExternalHttpUrl } from "@desktop/main/external-url";

describe("safeExternalHttpUrl", () => {
  it("allows normalized HTTP and HTTPS URLs", () => {
    expect(safeExternalHttpUrl("https://example.org/docs")).toBe("https://example.org/docs");
    expect(safeExternalHttpUrl("http://localhost:3000/status")).toBe(
      "http://localhost:3000/status",
    );
  });

  it("rejects unsafe schemes, credentials, and malformed values", () => {
    expect(safeExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalHttpUrl("https://user:pass@example.org/private")).toBeNull();
    expect(safeExternalHttpUrl("not a URL")).toBeNull();
  });
});
