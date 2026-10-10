import { describe, expect, it, vi } from "vitest";
import { createSlackApi, SLACK_BOT_SCOPES } from "../../packages/platform/src/slack/api.js";
import { loadSlackAppConfig } from "../../packages/platform/src/slack/wiring.js";

describe("Slack API boundary", () => {
  it("posts bounded plain text with mentions, broadcast and unfurls disabled and a deadline", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: "123.456" })));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl });
    await api.postMessage({ token: "xoxb-secret", channelId: "C123", text: "<@U123> <!channel> & hi", threadTs: "123.123" });
    const request = fetchImpl.mock.calls[0][1];
    expect(request.signal).toBeInstanceOf(AbortSignal); expect(request.redirect).toBe("error");
    expect(request.body.get("text")).toBe("&lt;@U123&gt; &lt;!channel&gt; &amp; hi");
    expect(request.body.get("mrkdwn")).toBe("false"); expect(request.body.get("unfurl_links")).toBe("false");
    expect(request.body.get("thread_ts")).toBe("123.123");
    await expect(api.postMessage({ token: "xoxb-secret", channelId: "C123", text: "x".repeat(35_001) })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("rejects provider errors without exposing them and bounds oversized API responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "secret-path" })))
      .mockResolvedValueOnce(new Response("x".repeat(256 * 1024 + 1)));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl });
    await expect(api.addReaction({ token: "secret", channelId: "C123", ts: "123.456", name: "eyes" })).rejects.toThrow("Slack unavailable");
    await expect(api.history({ token: "secret", channelId: "C123" })).rejects.toThrow("Slack unavailable");
  });
  it("treats Slack's exact already_reacted response as idempotent reaction success only", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "already_reacted" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "already_reacted" })));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl });
    await expect(api.addReaction({ token: "secret", channelId: "C123", ts: "123.456", name: "eyes" })).resolves.toBeUndefined();
    await expect(api.postMessage({ token: "secret", channelId: "C123", text: "hello" })).rejects.toThrow("Slack unavailable");
  });
  it("verifies OAuth returned bot scopes and refuses unsupported rotating or enterprise installations", async () => {
    const result = { ok: true, app_id: "A123", team: { id: "T123" }, bot_user_id: "UBOT", access_token: "xoxb-secret", token_type: "bot", scope: SLACK_BOT_SCOPES.join(","), is_enterprise_install: false };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(result)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...result, scope: "chat:write" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...result, expires_in: 3600 })));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl });
    expect(await api.exchangeCode({ code: "code", redirectUri: "https://app.matrix-os.com/api/slack/oauth/callback" })).toMatchObject({ appId: "A123", teamId: "T123" });
    await expect(api.exchangeCode({ code: "code", redirectUri: "https://app.matrix-os.com/api/slack/oauth/callback" })).rejects.toThrow();
    await expect(api.exchangeCode({ code: "code", redirectUri: "https://app.matrix-os.com/api/slack/oauth/callback" })).rejects.toThrow();
  });
  it("fails closed for partially configured apps and unsafe redirect origins", () => {
    expect(loadSlackAppConfig({})).toBeNull(); expect(() => loadSlackAppConfig({ SLACK_APP_ID: "A123" })).toThrow();
    const env = { SLACK_APP_ID: "A123", SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "c".repeat(32), SLACK_SIGNING_SECRET: "s".repeat(32), SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"), SLACK_PUBLIC_BASE_URL: "https://app.matrix-os.com" };
    expect(loadSlackAppConfig(env)?.publicBaseUrl).toBe(env.SLACK_PUBLIC_BASE_URL);
    expect(() => loadSlackAppConfig({ ...env, SLACK_PUBLIC_BASE_URL: "https://attacker@example.com/" })).toThrow();
    expect(() => loadSlackAppConfig({ ...env, SLACK_TOKEN_ENCRYPTION_KEY: "short" })).toThrow();
  });
});
