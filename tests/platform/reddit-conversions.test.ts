import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRedditConversionsClient } from "../../packages/platform/src/reddit-conversions.js";

describe("Reddit Conversions API", () => {
  it("sends a bounded, pseudonymous Purchase event", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = createRedditConversionsClient({
      env: {
        REDDIT_PIXEL_ID: "a2_test",
        REDDIT_CONVERSIONS_ACCESS_TOKEN: "secret-token",
      } as NodeJS.ProcessEnv,
      fetcher,
    });

    await expect(client.sendPurchase({
      eventAt: 1_779_753_600_000,
      conversionId: "in_123",
      clerkUserId: "user_123",
      clickId: "reddit-click",
      eventSourceUrl: "https://matrix-os.com/?rdt_cid=reddit-click",
      currency: "usd",
      value: 100,
    })).resolves.toBe("sent");

    expect(fetcher).toHaveBeenCalledWith(
      "https://ads-api.reddit.com/api/v3/pixels/a2_test/conversion_events",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      data: {
        events: [{
          event_at: 1_779_753_600_000,
          action_source: "WEBSITE",
          type: { tracking_type: "PURCHASE" },
          click_id: "reddit-click",
          event_source_url: "https://matrix-os.com/?rdt_cid=reddit-click",
          user: {
            external_id: createHash("sha256").update("user_123").digest("hex"),
          },
          metadata: {
            conversion_id: createHash("sha256").update("in_123").digest("hex"),
            currency: "USD",
            value: 100,
          },
        }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("user_123");
    expect(JSON.stringify(body)).not.toContain("in_123");
  });

  it("sends Sign Up without fake revenue metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = createRedditConversionsClient({
      env: {
        REDDIT_PIXEL_ID: "a2_test",
        REDDIT_CONVERSIONS_ACCESS_TOKEN: "secret-token",
      } as NodeJS.ProcessEnv,
      fetcher,
    });

    await expect(client.sendSignUp({
      eventAt: 1_779_753_600_000,
      conversionId: "cs_trial",
      clerkUserId: "user_123",
    })).resolves.toBe("sent");

    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body.data.events[0]).toEqual({
      event_at: 1_779_753_600_000,
      action_source: "WEBSITE",
      type: { tracking_type: "SIGN_UP" },
      user: {
        external_id: createHash("sha256").update("user_123").digest("hex"),
      },
      metadata: {
        conversion_id: createHash("sha256").update("cs_trial").digest("hex"),
      },
    });
  });

  it("stays disabled when either server credential is absent", async () => {
    const fetcher = vi.fn();
    const client = createRedditConversionsClient({ env: {}, fetcher });

    await expect(client.sendSignUp({
      eventAt: Date.now(),
      conversionId: "cs_123",
      clerkUserId: "user_123",
    })).resolves.toBe("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects zero-value purchases instead of reporting fake revenue", async () => {
    const client = createRedditConversionsClient({
      env: {
        REDDIT_PIXEL_ID: "a2_test",
        REDDIT_CONVERSIONS_ACCESS_TOKEN: "secret-token",
      } as NodeJS.ProcessEnv,
      fetcher: vi.fn(),
    });

    await expect(client.sendPurchase({
      eventAt: Date.now(),
      conversionId: "in_123",
      clerkUserId: "user_123",
      currency: "usd",
      value: 0,
    })).rejects.toThrow("Reddit conversion delivery failed");
  });

  it("fails closed on rejected API responses without exposing the token", async () => {
    const client = createRedditConversionsClient({
      env: {
        REDDIT_PIXEL_ID: "a2_test",
        REDDIT_CONVERSIONS_ACCESS_TOKEN: "secret-token",
      } as NodeJS.ProcessEnv,
      fetcher: vi.fn().mockResolvedValue(new Response("sensitive upstream body", { status: 500 })),
    });

    await expect(client.sendPurchase({
      eventAt: Date.now(),
      conversionId: "in_123",
      clerkUserId: "user_123",
      currency: "usd",
      value: 10,
    })).rejects.toThrow("Reddit conversion delivery failed");
  });
});
