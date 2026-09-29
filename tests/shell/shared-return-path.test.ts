import { describe, expect, it } from "vitest";
import { normalizeSharedReturnPath } from "../../shell/src/lib/shared-return-path.js";

const origin = "https://app.matrix-os.com";
const scopeId = "7f3c2b8e-4d1a-4c6b-9e2f-1a2b3c4d5e6f";

describe("normalizeSharedReturnPath", () => {
  it("keeps relative and same-origin shared destinations", () => {
    expect(normalizeSharedReturnPath("/shared", origin)).toBe("/shared");
    expect(normalizeSharedReturnPath(`/shared/chat/${scopeId}`, origin)).toBe(`/shared/chat/${scopeId}`);
    expect(normalizeSharedReturnPath(`/shared/invitations/${scopeId}`, origin)).toBe(`/shared/invitations/${scopeId}`);
    expect(normalizeSharedReturnPath(`${origin}/shared/terminal/${scopeId}`, origin)).toBe(`/shared/terminal/${scopeId}`);
    expect(normalizeSharedReturnPath(
      `${origin}/shared/organization-invitation?__clerk_status=sign_in`,
      origin,
    )).toBe("/shared/organization-invitation?__clerk_status=sign_in");
  });

  it("drops fragments from the destination", () => {
    expect(normalizeSharedReturnPath(`/shared/chat/${scopeId}#message`, origin)).toBe(`/shared/chat/${scopeId}`);
  });

  it("rejects open redirects and other origins", () => {
    for (const value of [
      "https://evil.example/shared",
      "http://app.matrix-os.com/shared",
      "https://app.matrix-os.com.evil.example/shared",
      "https://user:pass@app.matrix-os.com/shared",
      "//evil.example/shared",
      "///evil.example/shared",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "shared",
    ]) {
      expect(normalizeSharedReturnPath(value, origin), value).toBe("/");
    }
  });

  it("rejects separators, encodings and control characters that could escape the shared family", () => {
    for (const value of [
      "/shared\\evil",
      "/\\evil.example/shared",
      "/shared/%2F%2Fevil.example",
      "/shared%2fchat",
      "/shared/%5Cevil",
      "/shared//chat",
      "/shared/chat/\u0000",
      "/shared/chat/\n",
      "/shared/chat/\t",
      "/shared/chat/%00",
    ]) {
      expect(normalizeSharedReturnPath(value, origin), JSON.stringify(value)).toBe("/");
    }
  });

  it("returns home for non-shared paths, auth loops and malformed values", () => {
    for (const value of [
      null,
      undefined,
      "",
      "/",
      "/?billing=setup",
      "/sign-in",
      "/sign-up/verify-email-address",
      "/sharedx",
      "/shared/../billing",
      "/shared/%2e%2e/billing",
      "/vm/alice/shared",
      "/api/collaboration/shared",
      "http://[::1",
    ]) {
      expect(normalizeSharedReturnPath(value, origin), String(value)).toBe("/");
    }
  });

  it("rejects over-length destinations", () => {
    expect(normalizeSharedReturnPath(`/shared?x=${"a".repeat(2048)}`, origin)).toBe("/");
    expect(normalizeSharedReturnPath(`/shared?x=${"a".repeat(2030)}`, origin)).toBe(`/shared?x=${"a".repeat(2030)}`);
  });

  it("fails closed on an unusable origin", () => {
    expect(normalizeSharedReturnPath("/shared", "not a url")).toBe("/");
    expect(normalizeSharedReturnPath("/shared", "ftp://app.matrix-os.com")).toBe("/");
  });
});
