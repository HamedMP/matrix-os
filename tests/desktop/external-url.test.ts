import { describe, expect, it } from "vitest";
import { safeExternalHttpUrl, safeChatgptAuthorizationUrl } from "@desktop/main/external-url";

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


describe("safeChatgptAuthorizationUrl", () => {
  it("opens returning-account authorization with a long ID token hint", () => {
    const url = new URL("https://auth.openai.com/api/accounts/authorize");
    url.searchParams.set("id_token_hint", "signed-id-token.".repeat(220));
    expect(url.toString().length).toBeGreaterThan(2048);
    expect(safeExternalHttpUrl(url.toString())).toBeNull();
    expect(safeChatgptAuthorizationUrl(url.toString())).toBe(url.toString());
  });

  it.each([
    "https://other.example/api/accounts/authorize",
    "https://auth.openai.com.evil.example/api/accounts/authorize",
    "http://auth.openai.com/api/accounts/authorize",
    "https://user:password@auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com/other",
    "https://auth.openai.com/api/accounts/authorize#fragment",
    "https://auth.openai.com/api/accounts/authorize?hint=" + "x".repeat(32768),
    "invalid URL",
  ])("rejects authorization outside the fixed provider boundary", value => {
    expect(safeChatgptAuthorizationUrl(value)).toBeNull();
  });
});
