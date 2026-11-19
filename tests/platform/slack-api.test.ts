import { describe, expect, it, vi } from "vitest";
import { createSlackApi, SLACK_BOT_SCOPES, SlackApiRateLimitError } from "../../packages/platform/src/slack/api.js";
import { loadSlackThreadContextGrant } from "../../packages/platform/src/slack/thread-context.js";
import { loadSlackAppConfig } from "../../packages/platform/src/slack/wiring.js";

describe("Slack API boundary", () => {
  it("returns a validated channel name from the existing conversation info read", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true, channel: { id: "C123", name: "tech", is_ext_shared: false, is_member: true },
    }));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl });
    await expect(api.conversationInfo({ token: "fixture", channelId: "C123" })).resolves.toMatchObject({
      canAccess: true, channelMetadata: { id: "C123", name: "tech" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["", "x".repeat(81), "tech\nadmin", "tech\u0000", "tech\u202E", "#tech", "<tech>", { text: "tech" }, null, undefined])
  ("omits invalid optional provider channel names without inventing a label: %j", async name => {
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl: async () => Response.json({
      ok: true, channel: { id: "C123", name, is_ext_shared: false, is_member: true },
    }) });
    await expect(api.conversationInfo({ token: "fixture", channelId: "C123" })).resolves.toEqual({
      canAccess: true, isExternalShared: false,
    });
  });

  it("denies a provider response for a different channel before exposing its label", async () => {
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl: async () => Response.json({
      ok: true, channel: { id: "C456", name: "wrong-channel", is_ext_shared: false, is_member: true },
    }) });
    await expect(api.conversationInfo({ token: "fixture", channelId: "C123" })).resolves.toEqual({
      canAccess: false, isExternalShared: false,
    });
  });

  it("checks exact public-channel membership and caps cursor traversal", async () => {
    const page = (members: string[], nextCursor: string) =>
      Response.json({ ok: true, members, response_metadata: { next_cursor: nextCursor } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(page(["U456"], "next"))
      .mockResolvedValueOnce(page(["U123"], "")).mockResolvedValueOnce(page([], "one"))
      .mockResolvedValueOnce(page([], "two")).mockResolvedValueOnce(page([], "three"));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl });
    const input = { token: "xoxb-fixture", channelId: "C123", userId: "U123", signal: AbortSignal.timeout(1_000) };
    await expect(api.hasChannelMember!(input)).resolves.toBe(true);
    await expect(api.hasChannelMember!(input)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://slack.com/api/conversations.members");
    expect(fetchImpl.mock.calls[1]![1].body.get("cursor")).toBe("next");
  });

  it("keeps the exact context grant optional and restricted to Preview", () => {
    const env = { SLACK_PREVIEW_THREAD_CONTEXT_GRANT: JSON.stringify({
      appId: "A123", teamId: "T123", organizationId: "org_preview", ownerId: "user_owner", ownerSlackId: "U123",
      runtimeId: "runtime_preview", botId: "bot_12345678", chatId: "chat_12345678", channelId: "C123",
      threadTs: "123.456", installationGeneration: 1, linkCreatedAt: "2026-09-30T12:00:00.000Z",
    }) };
    expect(loadSlackThreadContextGrant({})).toBeUndefined();
    expect(() => loadSlackThreadContextGrant(env)).toThrow();
    expect(loadSlackThreadContextGrant(env, "pr-3482")).toMatchObject({ channelId: "C123", threadTs: "123.456" });
    expect(() => loadSlackThreadContextGrant({ SLACK_PREVIEW_THREAD_CONTEXT_GRANT: "{bad" }, "pr-3482")).toThrow();
    const legacy = JSON.parse(env.SLACK_PREVIEW_THREAD_CONTEXT_GRANT);
    const withoutRoot = { ...legacy };
    delete withoutRoot.threadTs;
    const configured = (grant: object) => ({ SLACK_PREVIEW_THREAD_CONTEXT_GRANT: JSON.stringify(grant) });
    expect(loadSlackThreadContextGrant(env, "pr-3482")).toEqual(legacy);
    expect(JSON.stringify(loadSlackThreadContextGrant(env, "pr-3482"))).toBe(
      '{"ownerId":"user_owner","botId":"bot_12345678","chatId":"chat_12345678","runtimeId":"runtime_preview","appId":"A123","teamId":"T123","channelId":"C123","threadTs":"123.456","organizationId":"org_preview","ownerSlackId":"U123","installationGeneration":1,"linkCreatedAt":"2026-09-30T12:00:00.000Z"}',
    );
    expect(() => loadSlackThreadContextGrant(configured(withoutRoot), "pr-3482")).toThrow();
    expect(loadSlackThreadContextGrant(configured({ ...withoutRoot, scope: "channel" }), "pr-3482"))
      .toEqual({ ...withoutRoot, scope: "channel" });
    expect(() => loadSlackThreadContextGrant(configured({ ...legacy, scope: "channel" }), "pr-3482")).toThrow();
    expect(() => loadSlackThreadContextGrant(configured({ ...withoutRoot, scope: "thread" }), "pr-3482")).toThrow();
    expect(() => loadSlackThreadContextGrant(configured({ ...legacy, scope: "workspace" }), "pr-3482")).toThrow();
  });

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
  it.each([["2", 2], ["999999", 3600], ["0", 1], ["private-provider-detail", 60], [null, 60]])("preserves only a confirmed rate limit with bounded delay (%s)", async (retryAfter, expected) => {
    const response = new Response("private-provider-detail", { status: 429, headers: retryAfter === null ? {} : { "Retry-After": String(retryAfter) } });
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl: vi.fn().mockResolvedValue(response) });
    await expect(api.postMessage({ token: "secret", channelId: "C123", text: "hello" })).rejects.toMatchObject({ name: "SlackApiRateLimitError", message: "Slack unavailable", retryAfterSeconds: expected });
  });
  it("retains the confirmed rate limit even if rejected-body cleanup fails", async () => {
    const response = new Response("limited", { status: 429 });
    vi.spyOn(response.body!, "cancel").mockRejectedValueOnce(new Error("cleanup failed"));
    const api = createSlackApi({ clientId: "123.456", clientSecret: "secret", fetchImpl: vi.fn().mockResolvedValue(response) });
    await expect(api.postMessage({ token: "secret", channelId: "C123", text: "hello" })).rejects.toBeInstanceOf(SlackApiRateLimitError);
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
