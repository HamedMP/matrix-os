import { describe, expect, it, vi } from "vitest";
import { oauthClientRequest, registerOAuthClient, selectOAuthClientAuthMethod } from "../../packages/gateway/src/integrations/custom-mcp/oauth-client.js";

describe("OAuth client registration trust boundary", () => {
  it("preserves legacy public clients and selects only advertised supported authentication", () => {
    expect(selectOAuthClientAuthMethod(undefined)).toBe("none");
    expect(selectOAuthClientAuthMethod(["client_secret_basic", "none"])).toBe("none");
    expect(selectOAuthClientAuthMethod(["private_key_jwt", "client_secret_basic"])).toBe("client_secret_basic");
    expect(selectOAuthClientAuthMethod(["client_secret_post"])).toBe("client_secret_post");
  });
  it.each([null, "none", [5], Array(21).fill("none"), ["x".repeat(101)]].map(methods => [methods]))("rejects malformed advertised authentication (%#)", methods => {
    expect(() => selectOAuthClientAuthMethod(methods)).toThrow();
  });
  it("requires setup for an unsupported method or missing registration endpoint before network", async () => {
    expect(() => selectOAuthClientAuthMethod(["private_key_jwt"])).toThrow();
    const request = vi.fn();
    await expect(registerOAuthClient({ redirectUri: "https://matrix.example/callback", request })).rejects.toMatchObject({ code: "oauth_client_setup_required" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([400,401,403,404,405])("classifies registration status %i without exposing its body", async status => {
    const request = vi.fn().mockResolvedValue({ status, body: { error: "private upstream detail" } });
    await expect(registerOAuthClient({ endpoint: "https://auth.example/register", redirectUri: "https://matrix.example/callback", request })).rejects.toMatchObject({ code: "oauth_client_setup_required" });
  });
  it.each([
    { status: 500 }, { status: 201, body: null }, { status: 201, body: [] },
    { status: 201, body: { client_id: "bad id" } }, { status: 201, body: { client_id: "x".repeat(2049) } },
    { status: 201, body: { client_id: "client", client_secret: "unexpected" } },
    { status: 201, body: { client_id: "client", token_endpoint_auth_method: "client_secret_basic" } },
  ])("rejects malformed public registration responses (%#)", async response => {
    const request = vi.fn().mockResolvedValue(response);
    await expect(registerOAuthClient({ endpoint: "https://auth.example/register", redirectUri: "https://matrix.example/callback", request })).rejects.toMatchObject({ code: "upstream" });
  });
  it.each([undefined, "", "bad secret", "x".repeat(8193)])("requires a bounded confidential secret (%#)", async client_secret => {
    const request = vi.fn().mockResolvedValue({ status: 201, body: { client_id: "client", client_secret } });
    await expect(registerOAuthClient({ endpoint: "https://auth.example/register", methods: ["client_secret_basic"], redirectUri: "https://matrix.example/callback", request })).rejects.toMatchObject({ code: "upstream" });
  });
  it.each([-1, 1.5, "123", Number.MAX_SAFE_INTEGER])("rejects invalid client secret expiry (%#)", async client_secret_expires_at => {
    const request = vi.fn().mockResolvedValue({ status: 201, body: { client_id: "client", client_secret: "secret", client_secret_expires_at } });
    await expect(registerOAuthClient({ endpoint: "https://auth.example/register", methods: ["client_secret_basic"], redirectUri: "https://matrix.example/callback", request })).rejects.toMatchObject({ code: "upstream" });
  });
  it.each([0, 1891388800])("retains a validated encrypted-secret expiry (%i)", async client_secret_expires_at => {
    const request = vi.fn().mockResolvedValue({ status: 201, body: { client_id: "client", client_secret: "secret", client_secret_expires_at } });
    expect(await registerOAuthClient({ endpoint: "https://auth.example/register", methods: ["client_secret_basic"], redirectUri: "https://matrix.example/callback", request })).toMatchObject({ clientSecretExpiresAt: client_secret_expires_at });
  });
  it("accepts a public registration without a secret", async () => {
    const request = vi.fn().mockResolvedValue({ status: 201, body: { client_id: "client", token_endpoint_auth_method: "none" } });
    expect(await registerOAuthClient({ endpoint: "https://auth.example/register", redirectUri: "https://matrix.example/callback", request })).toEqual({ clientId: "client" });
  });
});

describe("secret-bearing OAuth request policy", () => {
  const valid = { clientIssuer: "https://auth.example", clientId: "client", clientSecret: "secret", tokenEndpointAuthMethod: "client_secret_basic" as const };
  it.each([{ ...valid, clientIssuer: undefined }, { ...valid, clientId: "bad id" }, { ...valid, clientSecret: undefined }, { ...valid, tokenEndpointAuthMethod: "unreviewed" }, { clientSecret: "secret" }])("rejects incomplete, unsupported or public secret credentials (%#)", oauth => {
    expect(() => oauthClientRequest({ grant_type: "refresh_token" }, oauth as never)).toThrow();
  });
  it("encodes public forms without adding secret authorization", () => {
    expect(oauthClientRequest({ client_id: "client", code: "a+b&c" })).toEqual({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=client&code=a%2Bb%26c" });
  });
});
