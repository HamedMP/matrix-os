import { describe, expect, it, vi } from "vitest";
import {
  decryptGitHubCredential,
  decryptGitHubOAuthState,
  encryptGitHubCredential,
  encryptGitHubOAuthState,
  parseGitHubCredentialEncryptionKey,
} from "../../packages/gateway/src/integrations/github-credential-crypto.js";
import {
  GITHUB_REQUIRED_SCOPES,
  GitHubOAuthClient,
  GitHubOAuthError,
  createGitHubAuthorizationRequest,
} from "../../packages/gateway/src/integrations/github-oauth.js";

const key = Buffer.alloc(32, 7);

describe("GitHub integration credential crypto", () => {
  it("round-trips credentials with owner and immutable GitHub identity bound as AAD", () => {
    const envelope = encryptGitHubCredential({ accessToken: "gho_secret", scopes: ["repo", "notifications"] }, key, {
      userId: "owner-1",
      githubUserId: "42",
    });

    expect(envelope).not.toContain("gho_secret");
    expect(decryptGitHubCredential(envelope, key, { userId: "owner-1", githubUserId: "42" })).toEqual({
      accessToken: "gho_secret",
      scopes: ["repo", "notifications"],
    });
    expect(() => decryptGitHubCredential(envelope, key, { userId: "owner-2", githubUserId: "42" })).toThrow();
    expect(() => decryptGitHubCredential(envelope, key, { userId: "owner-1", githubUserId: "43" })).toThrow();
  });

  it("round-trips OAuth state, rejects tampering, and accepts only 32-byte keys", () => {
    const state = encryptGitHubOAuthState({ userId: "owner-1", expiresAt: "2026-10-24T03:00:00.000Z" }, key);
    expect(decryptGitHubOAuthState(state, key)).toEqual({
      userId: "owner-1",
      expiresAt: "2026-10-24T03:00:00.000Z",
    });
    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptGitHubOAuthState(tampered, key)).toThrow();
    expect(parseGitHubCredentialEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(() => parseGitHubCredentialEncryptionKey("too-short")).toThrow(/32 bytes/);
  });
});

describe("GitHub OAuth provider contract", () => {
  it("builds an expiring owner-bound PKCE request with only the approved data scopes", () => {
    const request = createGitHubAuthorizationRequest({
      clientId: "client-123",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      encryptionKey: key,
      userId: "owner-1",
      label: "Work",
      redirectTarget: "web",
      now: new Date("2026-10-24T02:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.matrix-os.com/api/integrations/oauth/github/callback");
    expect(url.searchParams.get("scope")).toBe(GITHUB_REQUIRED_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).not.toBeNull();

    const decoded = decryptGitHubOAuthState<Record<string, unknown>>(url.searchParams.get("state")!, key);
    expect(decoded).toMatchObject({
      userId: "owner-1",
      label: "Work",
      redirectTarget: "web",
      issuedAt: "2026-10-24T02:00:00.000Z",
      expiresAt: "2026-10-24T02:10:00.000Z",
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("exchanges a code through a bounded fixed-origin request and parses optional rotation fields", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      access_token: "gho_access",
      token_type: "bearer",
      scope: "repo,notifications",
      expires_in: 28_800,
      refresh_token: "ghr_refresh",
      refresh_token_expires_in: 15_897_600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new GitHubOAuthClient({
      clientId: "client-123",
      clientSecret: "secret-456",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      fetch: fetchFn,
      now: () => new Date("2026-10-24T02:00:00.000Z"),
    });

    await expect(client.exchangeCode("code-1", "verifier-1")).resolves.toEqual({
      accessToken: "gho_access",
      refreshToken: "ghr_refresh",
      scopes: ["repo", "notifications"],
      expiresAt: "2026-10-24T10:00:00.000Z",
      refreshTokenExpiresAt: "2027-04-26T02:00:00.000Z",
    });
    expect(fetchFn).toHaveBeenCalledWith("https://github.com/login/oauth/access_token", expect.objectContaining({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ accept: "application/json", "content-type": "application/json" }),
    }));
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body).toEqual({
      client_id: "client-123",
      client_secret: "secret-456",
      code: "code-1",
      redirect_uri: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      code_verifier: "verifier-1",
    });
  });

  it("fails closed on oversized or malformed provider responses", async () => {
    const oversized = new GitHubOAuthClient({
      clientId: "client-123",
      clientSecret: "secret-456",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      fetch: vi.fn(async () => new Response("x".repeat(65 * 1024), { status: 200 })),
    });
    await expect(oversized.exchangeCode("code-1", "verifier-1")).rejects.toBeInstanceOf(GitHubOAuthError);

    const malformed = new GitHubOAuthClient({
      clientId: "client-123",
      clientSecret: "secret-456",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      fetch: vi.fn(async () => new Response(JSON.stringify({ access_token: "gho_access", token_type: "mac" }), { status: 200 })),
    });
    await expect(malformed.exchangeCode("code-1", "verifier-1")).rejects.toBeInstanceOf(GitHubOAuthError);
  });

  it("reads the immutable viewer identity, refreshes rotating tokens, and revokes with app authentication", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "octocat", email: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "gho_rotated",
        token_type: "bearer",
        scope: "repo,notifications",
        expires_in: 28_800,
        refresh_token: "ghr_rotated",
        refresh_token_expires_in: 15_897_600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new GitHubOAuthClient({
      clientId: "client-123",
      clientSecret: "secret-456",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      fetch: fetchFn,
      now: () => new Date("2026-10-24T02:00:00.000Z"),
    });

    await expect(client.getViewer("gho_access")).resolves.toEqual({ id: "42", login: "octocat", email: null });
    await expect(client.refreshAccessToken("ghr_refresh")).resolves.toMatchObject({
      accessToken: "gho_rotated",
      refreshToken: "ghr_rotated",
      scopes: ["repo", "notifications"],
    });
    await expect(client.revokeToken("gho_rotated")).resolves.toBeUndefined();

    expect(fetchFn.mock.calls[0]).toEqual(["https://api.github.com/user", expect.objectContaining({
      method: "GET",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ authorization: "Bearer gho_access" }),
    })]);
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body))).toEqual({
      client_id: "client-123",
      client_secret: "secret-456",
      grant_type: "refresh_token",
      refresh_token: "ghr_refresh",
    });
    expect(fetchFn.mock.calls[2]).toEqual(["https://api.github.com/applications/client-123/token", expect.objectContaining({
      method: "DELETE",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({
        authorization: `Basic ${Buffer.from("client-123:secret-456").toString("base64")}`,
      }),
      body: JSON.stringify({ access_token: "gho_rotated" }),
    })]);
  });

  it("treats a revocation validation error as idempotent only after GitHub proves the token is gone", async () => {
    const missingFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Validation failed" }), { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const missingClient = new GitHubOAuthClient({
      clientId: "client-123",
      clientSecret: "secret-456",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      fetch: missingFetch,
    });
    await expect(missingClient.revokeToken("gho_missing")).resolves.toBeUndefined();
    expect(missingFetch.mock.calls.map(([, request]) => request?.method)).toEqual(["DELETE", "POST"]);

    const liveFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Validation failed" }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 }), { status: 200 }));
    const liveClient = new GitHubOAuthClient({
      clientId: "client-123",
      clientSecret: "secret-456",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      fetch: liveFetch,
    });
    await expect(liveClient.revokeToken("gho_still_live")).rejects.toBeInstanceOf(GitHubOAuthError);
  });
});
