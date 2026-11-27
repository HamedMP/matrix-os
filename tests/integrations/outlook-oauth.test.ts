import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOutlookOAuth, createOutlookPKCE } from "../../packages/gateway/src/integrations/outlook/oauth.js";

const clientId = "99c876a4-a5bd-4ad4-82ab-80a7d58ca7ad";
const redirectUri = "https://api.matrix-os.com/api/integrations/outlook/oauth/callback";
const token = {
  token_type: "Bearer",
  access_token: "microsoft-access",
  refresh_token: "microsoft-refresh",
  expires_in: 3600,
  scope: "User.Read Mail.ReadWrite",
};

describe("Matrix Outlook OAuth", () => {
  it("starts separate, least-privilege mail and calendar consent with S256 PKCE", () => {
    const client = createOutlookOAuth({ clientId, clientSecret: "matrix-secret", redirectUri });
    const attempt = createOutlookPKCE();
    expect(createOutlookPKCE()).not.toEqual(attempt);
    const mail = new URL(client.authorize("microsoft_outlook", attempt));
    expect(mail.origin + mail.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(mail.searchParams)).toEqual({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "form_post",
      scope: "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite",
      prompt: "select_account",
      state: attempt.state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
    });
    const calendar = new URL(client.authorize("microsoft_outlook_calendar", attempt));
    expect(calendar.searchParams.get("scope")).toBe(
      "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite",
    );
  });

  it("exchanges a PKCE code and reads the authenticated account from Graph", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(token))
      .mockResolvedValueOnce(Response.json({ id: "microsoft-object-id", mail: "owner@example.com", userPrincipalName: "alias@example.com" }));
    const client = createOutlookOAuth({ clientId, clientSecret: "matrix-secret", redirectUri, fetcher, now: () => 1000 });
    const { verifier } = createOutlookPKCE();
    await expect(client.exchange("microsoft_outlook", "authorization-code", verifier)).resolves.toEqual({
      credentials: { accessToken: "microsoft-access", refreshToken: "microsoft-refresh", expiresAt: 3_601_000 },
      account: { id: "microsoft-object-id", email: "owner@example.com" },
    });
    const [[tokenUrl, tokenRequest], [profileUrl, profileRequest]] = fetcher.mock.calls;
    expect(tokenUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(new URLSearchParams(String(tokenRequest?.body))).toEqual(new URLSearchParams({
      grant_type: "authorization_code", code: "authorization-code", code_verifier: verifier,
      redirect_uri: redirectUri, client_id: clientId, client_secret: "matrix-secret",
      scope: "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite",
    }));
    expect(profileUrl).toBe("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName");
    expect(new Headers(profileRequest?.headers).get("Authorization")).toBe("Bearer microsoft-access");
    for (const request of [tokenRequest, profileRequest]) {
      expect(request).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    }
  });

  it("rejects explicitly reduced scopes and redirects before an account can be linked", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...token, scope: "User.Read" }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.com" } }));
    const client = createOutlookOAuth({ clientId, clientSecret: "matrix-secret", redirectUri, fetcher });
    const { verifier } = createOutlookPKCE();
    await expect(client.exchange("microsoft_outlook", "authorization-code", verifier)).rejects.toMatchObject({ code: "consent_required" });
    await expect(client.exchange("microsoft_outlook", "authorization-code", verifier)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes within the original service scope and handles revoked or throttled grants", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...token, refresh_token: "new-refresh", scope: "https://graph.microsoft.com/Mail.ReadWrite User.Read" }))
      .mockResolvedValueOnce(Response.json({ error: "invalid_grant", error_description: "private upstream details" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "Retry-After": "9" } }));
    const client = createOutlookOAuth({ clientId, clientSecret: "matrix-secret", redirectUri, fetcher, now: () => 1000 });
    await expect(client.refresh("microsoft_outlook", "old-refresh")).resolves.toMatchObject({ refreshToken: "new-refresh" });
    expect(new URLSearchParams(String(fetcher.mock.calls[0][1]?.body))).toEqual(new URLSearchParams({
      grant_type: "refresh_token", refresh_token: "old-refresh", client_id: clientId, client_secret: "matrix-secret",
      scope: "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite",
    }));
    await expect(client.refresh("microsoft_outlook", "old-refresh")).rejects.toMatchObject({
      code: "consent_required", message: "Reconnect Outlook to continue",
    });
    await expect(client.refresh("microsoft_outlook", "old-refresh")).rejects.toMatchObject({ code: "throttled", retryAfter: 9 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("caps token response bytes even without a content length", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ...token, padding: "x".repeat(70_000) })));
    const client = createOutlookOAuth({ clientId, clientSecret: "matrix-secret", redirectUri, fetcher });
    const { verifier } = createOutlookPKCE();
    await expect(client.exchange("microsoft_outlook", "authorization-code", verifier)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
