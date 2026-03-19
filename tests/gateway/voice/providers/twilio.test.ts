import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TwilioProvider } from "../../../../packages/gateway/src/voice/providers/twilio.js";
import type { WebhookContext } from "../../../../packages/gateway/src/voice/types.js";
import { createHmac } from "node:crypto";

const TEST_ACCOUNT_SID = "ACtest00000000000000000000000000";
const TEST_AUTH_TOKEN = "test_auth_token_12345";
const TEST_FROM_NUMBER = "+15551234567";

function createTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

describe("TwilioProvider", () => {
  let provider: TwilioProvider;

  beforeEach(() => {
    provider = new TwilioProvider({
      accountSid: TEST_ACCOUNT_SID,
      authToken: TEST_AUTH_TOKEN,
      fromNumber: TEST_FROM_NUMBER,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has name 'twilio'", () => {
    expect(provider.name).toBe("twilio");
  });

  describe("verifyWebhook()", () => {
    it("valid HMAC-SHA1 passes", () => {
      const url = "https://example.com/voice/webhook/twilio";
      const params = {
        CallSid: "CA123",
        CallStatus: "ringing",
      };
      const sig = createTwilioSignature(TEST_AUTH_TOKEN, url, params);

      const ctx: WebhookContext = {
        method: "POST",
        url,
        headers: {
          "x-twilio-signature": sig,
        },
        rawBody: new URLSearchParams(params).toString(),
      };

      const result = provider.verifyWebhook(ctx);
      expect(result.ok).toBe(true);
    });

    it("invalid signature is rejected", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/voice/webhook/twilio",
        headers: {
          "x-twilio-signature": "invalid_signature",
        },
        rawBody: "CallSid=CA123&CallStatus=ringing",
      };

      const result = provider.verifyWebhook(ctx);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("reconstructs URL from X-Forwarded headers", () => {
      const forwardedUrl = "https://proxy.example.com:443/voice/webhook/twilio";
      const params = {
        CallSid: "CA123",
        CallStatus: "ringing",
      };
      const sig = createTwilioSignature(TEST_AUTH_TOKEN, forwardedUrl, params);

      const ctx: WebhookContext = {
        method: "POST",
        url: "http://localhost:4000/voice/webhook/twilio",
        headers: {
          "x-twilio-signature": sig,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "proxy.example.com",
          "x-forwarded-port": "443",
        },
        rawBody: new URLSearchParams(params).toString(),
      };

      const result = provider.verifyWebhook(ctx);
      expect(result.ok).toBe(true);
    });
  });

  describe("parseWebhookEvent()", () => {
    const baseParams = {
      CallSid: "CA123",
      AccountSid: TEST_ACCOUNT_SID,
      From: "+15559876543",
      To: TEST_FROM_NUMBER,
    };

    it("maps queued -> call.initiated", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "queued",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events.length).toBe(1);
      expect(result.events[0]!.type).toBe("call.initiated");
      expect(result.events[0]!.providerCallId).toBe("CA123");
    });

    it("maps ringing -> call.ringing", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "ringing",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.ringing");
    });

    it("maps in-progress -> call.active", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "in-progress",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.active");
    });

    it("maps completed -> call.ended with reason completed", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "completed",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.ended");
      expect((result.events[0] as { reason: string }).reason).toBe("completed");
    });

    it("maps busy -> call.ended with reason busy", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "busy",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.ended");
      expect((result.events[0] as { reason: string }).reason).toBe("busy");
    });

    it("maps no-answer -> call.ended with reason no-answer", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "no-answer",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.ended");
      expect((result.events[0] as { reason: string }).reason).toBe("no-answer");
    });

    it("maps canceled -> call.ended with reason completed", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "canceled",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.ended");
      expect((result.events[0] as { reason: string }).reason).toBe("completed");
    });

    it("maps failed -> call.ended with reason failed", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "failed",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0]!.type).toBe("call.ended");
      expect((result.events[0] as { reason: string }).reason).toBe("failed");
    });

    it("returns TwiML XML in response body", () => {
      const ctx: WebhookContext = {
        method: "POST",
        url: "https://example.com/webhook",
        headers: {},
        rawBody: new URLSearchParams({
          ...baseParams,
          CallStatus: "in-progress",
        }).toString(),
      };

      const result = provider.parseWebhookEvent(ctx);
      expect(result.providerResponseHeaders?.["content-type"]).toBe(
        "text/xml",
      );
      expect(result.providerResponseBody).toContain("<Response>");
    });
  });

  describe("initiateCall()", () => {
    it("constructs correct POST to Twilio API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sid: "CA999" }),
      });
      globalThis.fetch = mockFetch;

      const result = await provider.initiateCall({
        callId: "call-1",
        from: TEST_FROM_NUMBER,
        to: "+15559876543",
        webhookUrl: "https://example.com/webhook",
      });

      expect(result.providerCallId).toBe("CA999");
      expect(result.status).toBe("initiated");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          `api.twilio.com/2010-04-01/Accounts/${TEST_ACCOUNT_SID}/Calls.json`,
        ),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic"),
          }),
        }),
      );

      globalThis.fetch = fetch;
    });
  });

  describe("hangupCall()", () => {
    it("POSTs Status=completed to Twilio", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      globalThis.fetch = mockFetch;

      await provider.hangupCall({
        callId: "call-1",
        providerCallId: "CA999",
        reason: "hangup-bot",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`Calls/CA999.json`),
        expect.objectContaining({ method: "POST" }),
      );

      const bodyArg = mockFetch.mock.calls[0][1].body;
      expect(bodyArg.toString()).toContain("Status=completed");

      globalThis.fetch = fetch;
    });
  });

  describe("playTts()", () => {
    it("generates valid TwiML with <Say>", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      globalThis.fetch = mockFetch;

      await provider.playTts({
        callId: "call-1",
        providerCallId: "CA999",
        text: "Hello caller",
      });

      expect(mockFetch).toHaveBeenCalled();
      const bodyArg = mockFetch.mock.calls[0][1].body;
      const bodyStr = bodyArg.toString();
      expect(bodyStr).toContain("Twiml=");
      const twiml = new URLSearchParams(bodyStr).get("Twiml") ?? "";
      expect(twiml).toContain("<Say>");
      expect(twiml).toContain("Hello caller");
      expect(twiml).toContain("</Say>");

      globalThis.fetch = fetch;
    });
  });

  describe("error handling", () => {
    it("handles 401 Twilio API error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("Invalid credentials"),
      });
      globalThis.fetch = mockFetch;

      await expect(
        provider.initiateCall({
          callId: "call-1",
          from: TEST_FROM_NUMBER,
          to: "+15559876543",
          webhookUrl: "https://example.com/webhook",
        }),
      ).rejects.toThrow(/401/);

      globalThis.fetch = fetch;
    });

    it("handles 429 rate limit error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve("Rate limited"),
      });
      globalThis.fetch = mockFetch;

      await expect(
        provider.initiateCall({
          callId: "call-1",
          from: TEST_FROM_NUMBER,
          to: "+15559876543",
          webhookUrl: "https://example.com/webhook",
        }),
      ).rejects.toThrow(/429/);

      globalThis.fetch = fetch;
    });

    it("handles 500 server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("Server error"),
      });
      globalThis.fetch = mockFetch;

      await expect(
        provider.initiateCall({
          callId: "call-1",
          from: TEST_FROM_NUMBER,
          to: "+15559876543",
          webhookUrl: "https://example.com/webhook",
        }),
      ).rejects.toThrow(/500/);

      globalThis.fetch = fetch;
    });
  });

  describe("E.164 fromNumber validation", () => {
    it("rejects invalid fromNumber", () => {
      expect(
        () =>
          new TwilioProvider({
            accountSid: TEST_ACCOUNT_SID,
            authToken: TEST_AUTH_TOKEN,
            fromNumber: "not-a-number",
          }),
      ).toThrow(/E\.164/);
    });

    it("accepts valid E.164 fromNumber", () => {
      expect(
        () =>
          new TwilioProvider({
            accountSid: TEST_ACCOUNT_SID,
            authToken: TEST_AUTH_TOKEN,
            fromNumber: "+15551234567",
          }),
      ).not.toThrow();
    });
  });
});
