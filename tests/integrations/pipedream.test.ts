import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTokensCreate = vi.fn();
const mockAccountsDelete = vi.fn();
const mockProxyPost = vi.fn();

vi.mock("@pipedream/sdk", () => {
  return {
    PipedreamClient: class MockPipedreamClient {
      tokens = { create: mockTokensCreate };
      accounts = { delete: mockAccountsDelete };
      proxy = { post: mockProxyPost };
    },
  };
});

import {
  createPipedreamClient,
  type PipedreamConfig,
} from "../../packages/gateway/src/integrations/pipedream.js";

const TEST_CONFIG: PipedreamConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  projectId: "test-project-id",
};

describe("Pipedream Connect SDK Wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a connect token for a user", async () => {
    mockTokensCreate.mockResolvedValueOnce({
      token: "ctok_abc123",
      expiresAt: new Date("2026-04-06T00:00:00Z"),
      connectLinkUrl: "https://pipedream.com/connect/test-project-id?token=ctok_abc123",
    });

    const client = createPipedreamClient(TEST_CONFIG);
    const result = await client.createConnectToken("user-42");

    expect(result.token).toBe("ctok_abc123");
    expect(result.expiresAt).toBe("2026-04-06T00:00:00.000Z");
    expect(result.connectLinkUrl).toContain("pipedream.com/connect");
    expect(mockTokensCreate).toHaveBeenCalledOnce();
    expect(mockTokensCreate).toHaveBeenCalledWith(
      { externalUserId: "user-42" },
      expect.objectContaining({ timeoutInSeconds: 10 }),
    );
  });

  it("gets the OAuth URL for a service", () => {
    const client = createPipedreamClient(TEST_CONFIG);
    const url = client.getOAuthUrl("https://pipedream.com/connect/proj_abc?token=ctok_abc123", "gmail");

    expect(url).toContain("pipedream.com");
    expect(url).toContain("gmail");
    expect(url).toContain("ctok_abc123");
  });

  it("calls a service action via proxy", async () => {
    mockProxyPost.mockResolvedValueOnce({ success: true, data: { id: "msg-1" } });

    const client = createPipedreamClient(TEST_CONFIG);
    const result = await client.callAction({
      externalUserId: "user-42",
      accountId: "acct_abc",
      url: "https://api.example.com/send",
      body: { to: "test@example.com", subject: "Hello" },
    });

    expect(result).toEqual({ success: true, data: { id: "msg-1" } });
    expect(mockProxyPost).toHaveBeenCalledOnce();
    expect(mockProxyPost).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: "user-42",
        accountId: "acct_abc",
        url: "https://api.example.com/send",
        body: { to: "test@example.com", subject: "Hello" },
      }),
      expect.objectContaining({ timeoutInSeconds: 10 }),
    );
  });

  it("revokes an account", async () => {
    mockAccountsDelete.mockResolvedValueOnce(undefined);

    const client = createPipedreamClient(TEST_CONFIG);
    await client.revokeAccount("acct_abc");

    expect(mockAccountsDelete).toHaveBeenCalledOnce();
    expect(mockAccountsDelete).toHaveBeenCalledWith(
      "acct_abc",
      expect.objectContaining({ timeoutInSeconds: 10 }),
    );
  });

  it("propagates SDK errors from createConnectToken", async () => {
    mockTokensCreate.mockRejectedValueOnce(new Error("SDK auth failed"));

    const client = createPipedreamClient(TEST_CONFIG);
    await expect(client.createConnectToken("user-42")).rejects.toThrow("SDK auth failed");
  });

  it("propagates SDK errors from callAction", async () => {
    mockProxyPost.mockRejectedValueOnce(new Error("Rate limited"));

    const client = createPipedreamClient(TEST_CONFIG);
    await expect(
      client.callAction({
        externalUserId: "user-42",
        accountId: "acct_abc",
        url: "https://api.example.com/send",
        body: {},
      }),
    ).rejects.toThrow("Rate limited");
  });
});
