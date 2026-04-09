import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  connectServiceHandler,
  callServiceHandler,
  type GatewayFetcher,
} from "../../packages/kernel/src/tools/integrations.js";

function mockFetcher(overrides?: {
  status?: number;
  body?: unknown;
  reject?: Error;
}): GatewayFetcher {
  const { status = 200, body = {}, reject } = overrides ?? {};
  return vi.fn(async () => {
    if (reject) throw reject;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  });
}

const originalClerkUserId = process.env.MATRIX_CLERK_USER_ID;

beforeEach(() => {
  delete process.env.MATRIX_CLERK_USER_ID;
});

afterEach(() => {
  if (originalClerkUserId === undefined) {
    delete process.env.MATRIX_CLERK_USER_ID;
  } else {
    process.env.MATRIX_CLERK_USER_ID = originalClerkUserId;
  }
});

describe("connect_service handler", () => {
  it("returns an OAuth URL on success", async () => {
    const fetcher = mockFetcher({
      body: { url: "https://pipedream.com/connect/proj?token=tok&app=gmail", service: "gmail" },
    });

    const result = await connectServiceHandler(
      { service: "gmail", label: "Work Gmail" },
      fetcher,
    );

    expect(result.content[0].text).toContain("https://pipedream.com/connect");
    expect(result.content[0].text).toContain("gmail");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:4000/api/integrations/connect");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.service).toBe("gmail");
    expect(body.label).toBe("Work Gmail");
  });

  it("returns error message on 400 (unknown service)", async () => {
    const fetcher = mockFetcher({
      status: 400,
      body: { error: "Unknown service: fakesvc" },
    });

    const result = await connectServiceHandler(
      { service: "fakesvc" },
      fetcher,
    );

    expect(result.content[0].text).toContain("Unknown service");
  });

  it("returns error on network failure", async () => {
    const fetcher = mockFetcher({
      reject: new Error("connect ECONNREFUSED"),
    });

    const result = await connectServiceHandler(
      { service: "gmail" },
      fetcher,
    );

    expect(result.content[0].text).toMatch(/failed|error|unavailable/i);
  });

  it("passes signal with timeout to fetcher", async () => {
    const fetcher = mockFetcher({
      body: { url: "https://example.com", service: "gmail" },
    });

    await connectServiceHandler({ service: "gmail" }, fetcher);

    const [, opts] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.signal).toBeDefined();
  });

  it("forwards x-platform-user-id when MATRIX_CLERK_USER_ID is set", async () => {
    process.env.MATRIX_CLERK_USER_ID = "user_clerk_123";
    const fetcher = mockFetcher({
      body: { url: "https://example.com", service: "gmail" },
    });

    await connectServiceHandler({ service: "gmail" }, fetcher);

    const [, opts] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-platform-user-id": "user_clerk_123",
    });
  });
});

describe("call_service handler", () => {
  it("returns API response data on success", async () => {
    const fetcher = mockFetcher({
      body: {
        data: { messages: [{ id: "1", subject: "Hello" }] },
        service: "gmail",
        action: "list_messages",
      },
    });

    const result = await callServiceHandler(
      { service: "gmail", action: "list_messages", params: { query: "is:unread" } },
      fetcher,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.messages).toHaveLength(1);
    expect(parsed.service).toBe("gmail");
  });

  it("calls the correct endpoint with params", async () => {
    const fetcher = mockFetcher({
      body: { data: {}, service: "slack", action: "send_message" },
    });

    await callServiceHandler(
      { service: "slack", action: "send_message", params: { channel: "#general", text: "hi" } },
      fetcher,
    );

    const [url, opts] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:4000/api/integrations/call");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.service).toBe("slack");
    expect(body.action).toBe("send_message");
    expect(body.params.channel).toBe("#general");
  });

  it("passes label when provided", async () => {
    const fetcher = mockFetcher({
      body: { data: {}, service: "gmail", action: "list_messages" },
    });

    await callServiceHandler(
      { service: "gmail", action: "list_messages", label: "Work Gmail" },
      fetcher,
    );

    const [, opts] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.label).toBe("Work Gmail");
  });

  it("returns error on 400 (unknown action)", async () => {
    const fetcher = mockFetcher({
      status: 400,
      body: { error: "Unknown action: bad_action for service gmail" },
    });

    const result = await callServiceHandler(
      { service: "gmail", action: "bad_action" },
      fetcher,
    );

    expect(result.content[0].text).toContain("Unknown action");
  });

  it("returns error on 404 (service not connected)", async () => {
    const fetcher = mockFetcher({
      status: 404,
      body: { error: "Service github is not connected" },
    });

    const result = await callServiceHandler(
      { service: "github", action: "list_repos" },
      fetcher,
    );

    expect(result.content[0].text).toContain("not connected");
  });

  it("returns rate limit message on 429", async () => {
    const fetcher = mockFetcher({
      status: 429,
      body: { error: "Rate limited by provider" },
    });

    const result = await callServiceHandler(
      { service: "gmail", action: "list_messages" },
      fetcher,
    );

    expect(result.content[0].text).toMatch(/rate.?limit/i);
  });

  it("returns error on network failure", async () => {
    const fetcher = mockFetcher({
      reject: new Error("ETIMEDOUT"),
    });

    const result = await callServiceHandler(
      { service: "gmail", action: "list_messages" },
      fetcher,
    );

    expect(result.content[0].text).toMatch(/failed|error|unavailable/i);
  });

  it("passes signal with timeout to fetcher", async () => {
    const fetcher = mockFetcher({
      body: { data: {}, service: "gmail", action: "list_messages" },
    });

    await callServiceHandler({ service: "gmail", action: "list_messages" }, fetcher);

    const [, opts] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.signal).toBeDefined();
  });
});
