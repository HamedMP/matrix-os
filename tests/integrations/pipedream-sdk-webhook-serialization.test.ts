import { PipedreamClient } from "@pipedream/sdk";
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
it("serializes per-token server-only webhook URI using the installed SDK without network", async () => {
  const webhookUri = "https://app.example.invalid/api/integrations/gmail/pipedream/callback?attempt=public&proof=server-only";
  const fetcher = vi.fn(async (url, init) => {
    expect(String(url)).toBe("https://api.pipedream.com/v1/connect/proj_spike/tokens");
    expect(JSON.parse(init.body)).toMatchObject({ external_user_id: "synthetic-owner", webhook_uri: webhookUri, expires_in: 600 });
    return Response.json({ token: "ctok_" + "a".repeat(32), expires_at: "2026-10-21T12:10:00Z", connect_link_url: "https://pipedream.com/connect?token=synthetic" });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new PipedreamClient({ projectId: "proj_spike", projectEnvironment: "production", tokenProvider: { getToken: async () => "synthetic-server-token" } });
  const result = await client.tokens.create({ externalUserId: "synthetic-owner", webhookUri, expiresIn: 600 }, { maxRetries: 0, timeoutInSeconds: 10, abortSignal: AbortSignal.timeout(10_000) });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("server-only");
  expect(result.token).toBe("ctok_" + "a".repeat(32));
});
