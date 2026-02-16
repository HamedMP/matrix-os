import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPushAdapter } from "../../packages/gateway/src/channels/push.js";

describe("Push Notification Adapter", () => {
  let adapter: ReturnType<typeof createPushAdapter>;

  beforeEach(() => {
    adapter = createPushAdapter();
    vi.restoreAllMocks();
  });

  it("has id 'push'", () => {
    expect(adapter.id).toBe("push");
  });

  it("starts without error", async () => {
    await expect(adapter.start({ enabled: true })).resolves.toBeUndefined();
  });

  it("registers push tokens", () => {
    adapter.registerToken("ExponentPushToken[abc123]", "ios");
    const tokens = adapter.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe("ExponentPushToken[abc123]");
    expect(tokens[0].platform).toBe("ios");
  });

  it("removes push tokens", () => {
    adapter.registerToken("ExponentPushToken[abc123]", "ios");
    adapter.removeToken("ExponentPushToken[abc123]");
    expect(adapter.getTokens()).toHaveLength(0);
  });

  it("handles multiple tokens", () => {
    adapter.registerToken("token1", "ios");
    adapter.registerToken("token2", "android");
    expect(adapter.getTokens()).toHaveLength(2);
  });

  it("does not duplicate tokens with same value", () => {
    adapter.registerToken("token1", "ios");
    adapter.registerToken("token1", "ios");
    expect(adapter.getTokens()).toHaveLength(1);
  });

  it("stop clears all tokens", async () => {
    adapter.registerToken("token1", "ios");
    await adapter.stop();
    expect(adapter.getTokens()).toHaveLength(0);
  });

  it("send does nothing with no registered tokens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await adapter.send({
      channelId: "push",
      chatId: "test",
      text: "Hello",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send calls Expo Push API when tokens are registered", async () => {
    adapter.registerToken("ExponentPushToken[test]", "ios");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "1", status: "ok" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await adapter.send({
      channelId: "push",
      chatId: "chat1",
      text: "Test notification",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(opts?.method).toBe("POST");

    const body = JSON.parse(opts?.body as string);
    expect(body).toHaveLength(1);
    expect(body[0].to).toBe("ExponentPushToken[test]");
    expect(body[0].body).toBe("Test notification");
    expect(body[0].title).toBe("Matrix OS");
  });

  it("truncates long message bodies", async () => {
    adapter.registerToken("token", "ios");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "1", status: "ok" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const longMessage = "x".repeat(300);
    await adapter.send({
      channelId: "push",
      chatId: "chat1",
      text: longMessage,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body[0].body.length).toBeLessThanOrEqual(200);
    expect(body[0].body.endsWith("...")).toBe(true);
  });

  it("sets onMessage handler", () => {
    const handler = vi.fn();
    adapter.onMessage = handler;
    expect(adapter.onMessage).toBe(handler);
  });
});
