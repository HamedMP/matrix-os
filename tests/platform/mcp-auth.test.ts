import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createMcpTokenVerifier, McpAuthError, parseMcpRequiredScopes } from "../../packages/platform/src/mcp-auth.js";
import { loadPilotCohortPolicy } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { createPilotCohortAccessGuard } from '../../packages/platform/src/pilot-cohort-access.js';

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

// Mirrors the claim and header shape of Clerk's own OAuth access-token JWT fixture
// (@clerk/backend `mockSignedOAuthAccessTokenJwt`): `typ: at+jwt`, `sid`, `azp`, `nbf`, `jti: oat_...`.
function sign(overrides: JWTPayload = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer, aud: resourceUrl, sub: "user_abc123", client_id: "client_test", azp: "https://claude.ai",
    sid: "sess_abc123", jti: "oat_abc123", scope: "matrix:computer", iat: now, nbf: now - 10, exp: now + 300,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "at+jwt", ...header }).sign(privateKey);
}

function setup(fetchMock = vi.fn().mockImplementation(async () => Response.json({ keys: [jwk] })),
  requiredScopes?: string[]) {
  return { fetchMock, verify: createMcpTokenVerifier({ issuer, resourceUrl, jwksUrl, fetch: fetchMock, requiredScopes }) };
}

/** A Clerk session JWT: `typ: JWT`, a session category, `sid`, no OAuth client or resource audience. */
function signSession(overrides: JWTPayload = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, sub: "user_abc123", sid: "sess_abc123", azp: "https://app.matrix-os.com",
    iat: now, nbf: now - 10, exp: now + 60, v: 2, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT", cat: "cl_B7d4PD111AAA", ...header }).sign(privateKey);
}

async function sizedCohortToken(bytes: number): Promise<string> {
  const base = await sign({ sub: 'user_pilotA', padding: '' }, { padding: '' });
  const estimate = Math.floor((bytes - base.length) * 3 / 4);
  // Base64url omits padding; varying one signed header field covers its
  // length residues without weakening the actual JWT signature verifier.
  for (let headerBytes = 0; headerBytes < 3; headerBytes++) {
    for (let delta = -6; delta <= 6; delta++) {
      const token = await sign({ sub: 'user_pilotA', padding: 'x'.repeat(estimate + delta) }, { padding: 'x'.repeat(headerBytes) });
      if (token.length === bytes) return token;
    }
  }
  throw new Error('Sized JWT fixture unavailable');
}

describe("hosted MCP OAuth access token verification", () => {
  it('preserves the real MCP token size contract through the global cohort guard', async () => {
    const policy = loadPilotCohortPolicy({ MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: 'user_pilotA' });
    const verify = createMcpTokenVerifier({ issuer, resourceUrl, jwksUrl,
      fetch: vi.fn(async () => Response.json({ keys: [jwk] })), pilotCohortPolicy: policy });
    const consumed = vi.fn(verify);
    const app = new Hono();
    app.use('*', createPilotCohortAccessGuard({ policy, jwtSecret: 'fictional-matrix-secret-at-least-32-characters' }));
    app.get('/mcp', async c => c.json(await consumed(c.req.header('authorization')!.slice(7))));
    for (const bytes of [8913, 16384]) {
      const token = await sizedCohortToken(bytes);
      expect(token.length).toBe(bytes);
      expect(await verify(token)).toMatchObject({ userId: 'user_pilotA' });
      const response = await app.request('/mcp', { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ userId: 'user_pilotA' });
    }
    const oversized = await sizedCohortToken(16385);
    consumed.mockClear();
    const response = await app.request('/mcp', { headers: { authorization: `Bearer ${oversized}` } });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Access unavailable' });
    expect(consumed).not.toHaveBeenCalled();
  });
  it('refuses valid noncohort OAuth identities after resource/signature verification', async () => {
    const verify = createMcpTokenVerifier({ issuer, resourceUrl, jwksUrl,
      fetch: vi.fn(async () => Response.json({ keys: [jwk] })),
      pilotCohortPolicy: loadPilotCohortPolicy({ MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: 'user_pilotA' }),
    });
    await expect(verify(await sign())).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    await expect(verify(await sign({ sub: 'user_pilotA' }))).resolves.toMatchObject({ userId: 'user_pilotA' });
  });
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
    { aud: [resourceUrl] }, { aud: ["https://other.example", resourceUrl] },
  ])("accepts an audience array that includes the canonical resource: %j", async (claims) => {
    await expect(setup().verify(await sign(claims))).resolves.toMatchObject({ userId: "user_abc123" });
  });

  it("accepts Clerk OAuth tokens that carry the authorizing session id and either access-token typ", async () => {
    await expect(setup().verify(await sign({ sid: "sess_123" }))).resolves.toMatchObject({ clientId: "client_test" });
    await expect(setup().verify(await sign({}, { typ: "application/at+jwt" }))).resolves.toMatchObject({ userId: "user_abc123" });
  });

  it("tolerates small clock skew between Clerk and the platform", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(setup().verify(await sign({ iat: now + 3, nbf: now + 3 }))).resolves.toMatchObject({ userId: "user_abc123" });
  });

  it("never applies clock skew to expiry, so recently expired tokens get a renewable 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const exp of [now, now - 2]) {
      await expect(setup().verify(await sign({ iat: now - 300, nbf: now - 300, exp })))
        .rejects.toMatchObject({ status: 401, code: "invalid_token" });
    }
  });

  it.each([
    ["session token", () => signSession()],
    ["session token with a resource audience", () => signSession({ aud: resourceUrl, client_id: "client_test", scope: "matrix:computer" })],
    ["JWT-template token", () => sign({}, { typ: "JWT" })],
    ["untyped token", () => sign({}, { typ: undefined })],
    ["session category", () => sign({}, { cat: "cl_B7d4PD111AAA" })],
    ["M2M category", () => sign({}, { cat: "cl_B7d4PD333AAA" })],
    ["M2M subject", () => sign({ sub: "mch_abc123" })],
  ])("rejects non-OAuth Clerk tokens signed by the same instance: %s", async (_name, token) => {
    await expect(setup().verify(await token())).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  });

  it("serves repeated and concurrent verifications from one JWKS fetch", async () => {
    const { verify, fetchMock } = setup();
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => sign({ sub: `user_u${i}` })));
    const principals = await Promise.all(tokens.map(verify));
    expect(principals.map((p) => p.userId)).toEqual(tokens.map((_, i) => `user_u${i}`));
    await verify(tokens[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { iss: "https://attacker.example" }, { iss: `${issuer}/` }, { aud: "client_test" }, { aud: undefined },
    { aud: ["https://other.example"] }, { aud: [`${resourceUrl}/extra`] }, { aud: "https://api.matrix-os.com" },
    { exp: 1 }, { exp: undefined }, { nbf: Math.floor(Date.now() / 1000) + 600 },
    { iat: undefined }, { iat: Math.floor(Date.now() / 1000) + 600 },
    { sub: undefined }, { sub: "org_abc" }, { sub: "user_../alice" },
    { client_id: undefined }, { client_id: "" },
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

  it("enforces every configured required scope instead of a hard-coded scope", async () => {
    const custom = setup(undefined, ["profile", "email"]);
    await expect(custom.verify(await sign({ scope: "openid email profile" }))).resolves.toMatchObject({ userId: "user_abc123" });
    await expect(custom.verify(await sign({ scope: "matrix:computer profile" })))
      .rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
  });

  it.each([
    [undefined, ["matrix:computer"]], ["", ["matrix:computer"]], ["  ", ["matrix:computer"]],
    ["matrix:computer", ["matrix:computer"]], ["profile, email  matrix:computer,email", ["profile", "email", "matrix:computer"]],
  ])("parses MATRIX_MCP_REQUIRED_SCOPES %j", (raw, expected) => {
    expect(parseMcpRequiredScopes(raw)).toEqual(expected);
  });

  it.each(['matrix"computer', "a\\b", "x".repeat(257), Array.from({ length: 17 }, (_, i) => `s${i}`).join(" ")])(
    "rejects unsafe MATRIX_MCP_REQUIRED_SCOPES %j", (raw) => {
      expect(() => parseMcpRequiredScopes(raw)).toThrow("Invalid MCP configuration");
    });

  it("logs one coarse, credential-free diagnostic line per rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { verify } = setup();
      const token = await sign({ aud: ["https://other.example"], client_id: "client_secretish", sub: "user_private1" });
      await expect(verify(token)).rejects.toMatchObject({ code: "invalid_token" });
      await expect(verify("oat_opaque_secret_value")).rejects.toMatchObject({ code: "invalid_token" });
      await expect(verify(await signSession())).rejects.toMatchObject({ code: "invalid_token" });
      await expect(verify(await sign({ scope: "openid" }))).rejects.toMatchObject({ code: "insufficient_scope" });
      expect(warn).toHaveBeenCalledTimes(4);
      const lines = warn.mock.calls.map((call) => call.map(String).join(" "));
      expect(lines[0]).toMatch(/^\[mcp\] auth rejected: audience /);
      expect(lines[0]).toContain('"aud":"array"');
      expect(lines[0]).toContain('"audIncludesResource":false');
      expect(lines[0]).toContain('"typ":"at+jwt"');
      expect(lines[0]).toContain(`"iss":"${issuer}"`);
      expect(lines[0]).toContain('"clientId":true');
      expect(lines[0]).toContain('"sid":true');
      expect(lines[1]).toMatch(/^\[mcp\] auth rejected: opaque_token /);
      expect(lines[1]).toContain('"kind":"opaque"');
      expect(lines[2]).toMatch(/^\[mcp\] auth rejected: token_type /);
      expect(lines[2]).toContain('"typ":"JWT"');
      expect(lines[3]).toMatch(/^\[mcp\] auth rejected: scope /);
      for (const line of lines) {
        for (const secret of [token, "oat_opaque", "client_secretish", "user_private1", "sess_abc123", "openid", "https://other.example"]) {
          expect(line).not.toContain(secret);
        }
      }
    } finally { warn.mockRestore(); }
  });

  it("never echoes an untrusted issuer value into diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(setup().verify(await sign({ iss: "https://evil.example/\n[mcp] forged" }))).rejects.toMatchObject({ code: "invalid_token" });
      const line = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      expect(line).toMatch(/^\[mcp\] auth rejected: issuer /);
      expect(line).toContain('"iss":"other"');
      expect(line).not.toContain("forged");
    } finally { warn.mockRestore(); }
  });

  it("rejects signature tampering, unknown keys, opaque credentials, and oversized tokens", async () => {
    const token = await sign();
    const [header, payload, signature] = token.split(".");
    const tampered = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    for (const invalid of [tampered, await sign({}, { kid: "unknown" }), "sync_secret", "oat_8XOIucKvqHVr5tYP123", "x".repeat(16_385)]) {
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
