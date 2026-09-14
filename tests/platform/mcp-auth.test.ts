import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createMcpTokenVerifier, McpAuthError } from "../../packages/platform/src/mcp-auth.js";

const issuer = "https://login.example.com";
const resourceUrl = "https://api.matrix-os.com/mcp";
const jwksUrl = `${issuer}/.well-known/jwks.json`;
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
});

function sign(overrides: JWTPayload = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer, aud: resourceUrl, sub: "user_abc123", client_id: "client_test",
    scope: "matrix:computer", iat: now, exp: now + 300, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key", ...header }).sign(privateKey);
}

function setup(fetchMock = vi.fn().mockImplementation(async () => Response.json({ keys: [jwk] }))) {
  return { fetchMock, verify: createMcpTokenVerifier({ issuer, resourceUrl, jwksUrl, fetch: fetchMock }) };
}

describe("hosted MCP OAuth access token verification", () => {
  it("verifies signed resource-bound access tokens through trusted JWKS and caches bounded keys", async () => {
    const { verify, fetchMock } = setup();
    const exp = Math.floor(Date.now() / 1000) + 300;
    expect(await verify(await sign({ exp }))).toEqual({ userId: "user_abc123", clientId: "client_test", expiresAt: exp });
    await verify(await sign());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(jwksUrl);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });

  it.each([
    { iss: "https://attacker.example" }, { aud: "client_test" },
    { aud: [resourceUrl, "https://other.example"] }, { exp: 1 }, { exp: undefined },
    { iat: undefined }, { iat: Math.floor(Date.now() / 1000) + 600 },
    { sub: undefined }, { sub: "org_abc" }, { sub: "user_../alice" },
    { client_id: undefined }, { client_id: "" }, { sid: "sess_123" }, { sid: null },
  ])("rejects invalid or session-shaped claims: %j", async (claims) => {
    await expect(setup().verify(await sign(claims))).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  });

  it.each([
    { scope: undefined }, { scope: "openid profile" }, { scope: "matrix:computer:read" },
    { scope: 42 }, { scope: undefined, scp: ["openid"] },
    { scope: "matrix:computer", scp: ["openid"] },
    { scope: "openid", scp: ["matrix:computer"] },
    { scope: undefined, scp: ["matrix:computer", 42] },
  ])("denies absent, malformed, or conflicting scope grants: %j", async (claims) => {
    await expect(setup().verify(await sign(claims))).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
  });

  it.each([
    { scope: "openid matrix:computer" },
    { scope: undefined, scp: ["openid", "matrix:computer"] },
    { scope: "openid matrix:computer", scp: ["matrix:computer", "openid"] },
  ])("accepts explicit equivalent scope formats: %j", async (claims) => {
    await expect(setup().verify(await sign(claims))).resolves.toMatchObject({ userId: "user_abc123" });
  });

  it("rejects signature tampering, unknown keys, opaque credentials, and oversized tokens", async () => {
    const token = await sign();
    const [header, payload, signature] = token.split(".");
    const tampered = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    for (const invalid of [tampered, await sign({}, { kid: "unknown" }), "sync_secret", "x".repeat(16_385)]) {
      await expect(setup().verify(invalid)).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    }
  });

  it("does not follow token-controlled key URLs", async () => {
    const { verify, fetchMock } = setup();
    await verify(await sign({}, { jku: "https://attacker.example/keys" }));
    expect(String(fetchMock.mock.calls[0][0])).toBe(jwksUrl);
  });

  it.each([
    () => new Response("not json"),
    () => Response.json({ keys: "invalid" }),
    () => Response.json({ keys: [{}] }),
    () => Response.json({ keys: Array.from({ length: 33 }, () => jwk) }),
    () => new Response("x".repeat(65_537)),
    () => new Response("{}", { headers: { "content-length": "65537" } }),
    () => new Response("{}", { status: 503 }),
  ])("treats invalid or excessive JWKS as service failures, not rejected credentials", async (response) => {
    const { verify } = setup(vi.fn().mockImplementation(async () => response()));
    const error = await verify(await sign()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(McpAuthError);
    expect((error as Error).message).toBe("MCP authentication service unavailable");
  });

  it("bounds JWKS fetches to ten seconds and safely reports network failures", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const { verify } = setup(vi.fn().mockRejectedValue(new Error("private network detail")));
      await expect(verify(await sign())).rejects.toThrow("MCP authentication service unavailable");
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally { timeout.mockRestore(); }
  });

  it.each([
    { issuer: "" }, { resourceUrl: "http://api.matrix-os.com/mcp" },
    { jwksUrl: "http://login.example.com/keys" },
    { jwksUrl: "https://secret:pass@login.example.com/keys" },
    { resourceUrl: "https://api.matrix-os.com/mcp#fragment" },
  ])("rejects unsafe trusted configuration at registration: %j", (override) => {
    expect(() => createMcpTokenVerifier({ issuer, resourceUrl, jwksUrl, ...override })).toThrow();
  });

  it("allows explicit loopback HTTP configuration for local development", () => {
    expect(() => createMcpTokenVerifier({
      issuer: "http://localhost:9000", resourceUrl: "http://127.0.0.1:9001/mcp",
      jwksUrl: "http://localhost:9000/keys",
    })).not.toThrow();
  });
});
