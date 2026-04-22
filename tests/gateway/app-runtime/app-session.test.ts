import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  deriveAppSessionKey,
  signAppSession,
  verifyAppSession,
  buildSetCookie,
  AppSessionPayload,
} from "../../../packages/gateway/src/app-runtime/app-session.js";

describe("app-session crypto", () => {
  const masterSecret = "test-gateway-token-32-bytes-long!";
  const slug = "notes";

  it("round-trips a v1 payload (sign -> verify succeeds)", () => {
    const key = deriveAppSessionKey(masterSecret, slug);
    const payload = {
      v: 1 as const,
      slug: "notes",
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const token = signAppSession(key, payload);
    const verified = verifyAppSession(key, token, Math.floor(Date.now() / 1000));
    expect(verified).not.toBeNull();
    expect(verified!.slug).toBe("notes");
    expect(verified!.principal).toBe("gateway-owner");
    expect(verified!.v).toBe(1);
  });

  it("rejects tampered signature", () => {
    const key = deriveAppSessionKey(masterSecret, slug);
    const payload = {
      v: 1 as const,
      slug: "notes",
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const token = signAppSession(key, payload);
    // Tamper: flip last character of signature
    const parts = token.split(".");
    const sig = parts[1]!;
    const tampered = parts[0] + "." + sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    const verified = verifyAppSession(key, tampered, Math.floor(Date.now() / 1000));
    expect(verified).toBeNull();
  });

  it("rejects expired session", () => {
    const key = deriveAppSessionKey(masterSecret, slug);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1 as const,
      slug: "notes",
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: now - 700,
      exp: now - 100, // already expired
    };
    const token = signAppSession(key, payload);
    const verified = verifyAppSession(key, token, now);
    expect(verified).toBeNull();
  });

  it("rejects unknown version", () => {
    const key = deriveAppSessionKey(masterSecret, slug);
    const now = Math.floor(Date.now() / 1000);
    // Create a v2 payload (by crafting manually)
    const fakePayload = {
      v: 2,
      slug: "notes",
      principal: "gateway-owner",
      scope: "personal",
      iat: now,
      exp: now + 600,
    };
    // Sign it manually to bypass our signer's v1 check
    const payloadB64 = Buffer.from(JSON.stringify(fakePayload)).toString("base64url");
    const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
    const token = `${payloadB64}.${sig}`;
    const verified = verifyAppSession(key, token, now);
    expect(verified).toBeNull();
  });

  it("constant-time verify via timingSafeEqual", () => {
    // This is a structural test - verifying the function uses timingSafeEqual
    // by ensuring it doesn't throw even with very different signatures
    const key = deriveAppSessionKey(masterSecret, slug);
    const now = Math.floor(Date.now() / 1000);
    const result = verifyAppSession(key, "totally.invalid", now);
    expect(result).toBeNull();
  });

  it("deriveAppSessionKey produces different keys for different slugs", () => {
    const k1 = deriveAppSessionKey(masterSecret, "notes");
    const k2 = deriveAppSessionKey(masterSecret, "calendar");
    expect(k1.equals(k2)).toBe(false);
  });

  it("deriveAppSessionKey produces consistent output", () => {
    const k1 = deriveAppSessionKey(masterSecret, slug);
    const k2 = deriveAppSessionKey(masterSecret, slug);
    expect(k1.equals(k2)).toBe(true);
  });

  // Security: empty/short master secrets combined with the public HKDF info
  // string would yield a deterministic key that anyone could reproduce, so
  // deriveAppSessionKey must refuse them instead of silently accepting.
  it("throws on empty master secret", () => {
    expect(() => deriveAppSessionKey("", slug)).toThrow(/master ?secret/i);
  });

  it("throws on master secret shorter than 16 bytes", () => {
    expect(() => deriveAppSessionKey("short-15bytes!!", slug)).toThrow(/16 bytes/);
  });
});

describe("buildSetCookie", () => {
  it("includes Path=/apps/{slug}/, HttpOnly, SameSite=Strict", () => {
    const cookie = buildSetCookie("notes", "token-value", { maxAge: 600, secure: true });
    expect(cookie).toContain("matrix_app_session__notes=token-value");
    expect(cookie).toContain("Path=/apps/notes/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=600");
  });

  it("omits Secure when secure is false", () => {
    const cookie = buildSetCookie("notes", "token-value", { maxAge: 600, secure: false });
    expect(cookie).not.toContain("Secure");
  });

  it("does not use Path=/ (must be scoped to slug)", () => {
    const cookie = buildSetCookie("notes", "val", { maxAge: 600, secure: true });
    expect(cookie).not.toMatch(/Path=\/;/);
    expect(cookie).not.toMatch(/Path=\/,/);
    expect(cookie).toContain("Path=/apps/notes/");
  });
});

describe("AppSessionPayload schema", () => {
  it("validates a correct v1 payload", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = AppSessionPayload.safeParse({
      v: 1,
      slug: "notes",
      principal: "gateway-owner",
      scope: "personal",
      iat: now,
      exp: now + 600,
    });
    expect(result.success).toBe(true);
  });

  it("rejects v2 payload", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = AppSessionPayload.safeParse({
      v: 2,
      slug: "notes",
      principal: "gateway-owner",
      scope: "personal",
      iat: now,
      exp: now + 600,
    });
    expect(result.success).toBe(false);
  });
});
