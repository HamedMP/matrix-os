import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above all imports. Module-scope `const`s are dead at
// factory-invocation time, so the factory closes over `undefined` and vitest
// silently falls through to the real @pipedream/sdk. vi.hoisted() creates
// the shared references during the same hoisted phase so they're live when
// the factory runs.
const {
  mockTokensCreate,
  mockAccountsDelete,
  mockAccountsList,
  mockProxyPost,
  mockActionsList,
  mockActionsRun,
  mockAppsList,
} = vi.hoisted(() => ({
  mockTokensCreate: vi.fn(),
  mockAccountsDelete: vi.fn(),
  mockAccountsList: vi.fn(),
  mockProxyPost: vi.fn(),
  mockActionsList: vi.fn(),
  mockActionsRun: vi.fn(),
  mockAppsList: vi.fn(),
}));

vi.mock("@pipedream/sdk", () => {
  return {
    PipedreamClient: class MockPipedreamClient {
      tokens = { create: mockTokensCreate };
      accounts = { delete: mockAccountsDelete, list: mockAccountsList };
      proxy = { post: mockProxyPost };
      actions = { list: mockActionsList, run: mockActionsRun };
      apps = { list: mockAppsList };
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

describe("Pipedream Actions API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("discoverActions", () => {
    it("lists available actions for an app slug", async () => {
      const mockPage = {
        data: [
          {
            key: "gmail-send-email",
            name: "Gmail: Send Email",
            description: "Send an email via Gmail",
            version: "1.0.0",
            configurableProps: [],
          },
          {
            key: "gmail-list-messages",
            name: "Gmail: List Messages",
            description: "List email messages",
            version: "1.0.0",
            configurableProps: [],
          },
        ],
        [Symbol.asyncIterator]: async function* () {
          for (const item of this.data) yield item;
        },
      };
      mockActionsList.mockResolvedValueOnce(mockPage);

      const client = createPipedreamClient(TEST_CONFIG);
      const actions = await client.discoverActions("gmail");

      expect(actions).toHaveLength(2);
      expect(actions[0]).toEqual({
        key: "gmail-send-email",
        name: "Gmail: Send Email",
        description: "Send an email via Gmail",
      });
      expect(actions[1]).toEqual({
        key: "gmail-list-messages",
        name: "Gmail: List Messages",
        description: "List email messages",
      });
      expect(mockActionsList).toHaveBeenCalledWith(
        expect.objectContaining({ app: "gmail" }),
        expect.objectContaining({ timeoutInSeconds: 10 }),
      );
    });

    it("returns empty array when no actions found", async () => {
      const mockPage = {
        data: [],
        [Symbol.asyncIterator]: async function* () {},
      };
      mockActionsList.mockResolvedValueOnce(mockPage);

      const client = createPipedreamClient(TEST_CONFIG);
      const actions = await client.discoverActions("nonexistent_app");

      expect(actions).toEqual([]);
    });

    it("propagates SDK errors from discoverActions", async () => {
      mockActionsList.mockRejectedValueOnce(new Error("API error"));

      const client = createPipedreamClient(TEST_CONFIG);
      await expect(client.discoverActions("gmail")).rejects.toThrow("API error");
    });
  });

  describe("runAction", () => {
    it("runs an action with configured props and returns result", async () => {
      const mockResponse = {
        body: {
          exports: { $summary: "Email sent to alice@example.com" },
          ret: { messageId: "msg_123", threadId: "thread_456" },
        },
      };
      mockActionsRun.mockResolvedValueOnce(mockResponse);

      const client = createPipedreamClient(TEST_CONFIG);
      const result = await client.runAction({
        externalUserId: "user-42",
        componentKey: "gmail-send-email",
        configuredProps: {
          gmail: { authProvisionId: "apn_abc123" },
          to: "alice@example.com",
          subject: "Hello",
          body: "Hi there",
        },
      });

      expect(result).toEqual({
        exports: { $summary: "Email sent to alice@example.com" },
        ret: { messageId: "msg_123", threadId: "thread_456" },
      });
      expect(mockActionsRun).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "gmail-send-email",
          externalUserId: "user-42",
          configuredProps: {
            gmail: { authProvisionId: "apn_abc123" },
            to: "alice@example.com",
            subject: "Hello",
            body: "Hi there",
          },
        }),
        expect.objectContaining({ timeoutInSeconds: 30 }),
      );
    });

    it("handles actions with no return value", async () => {
      const mockResponse = {
        body: {
          exports: { $summary: "Event deleted" },
          ret: undefined,
        },
      };
      mockActionsRun.mockResolvedValueOnce(mockResponse);

      const client = createPipedreamClient(TEST_CONFIG);
      const result = await client.runAction({
        externalUserId: "user-42",
        componentKey: "google_calendar-delete-event",
        configuredProps: {
          google_calendar: { authProvisionId: "apn_xyz" },
          eventId: "evt_123",
        },
      });

      expect(result.exports).toEqual({ $summary: "Event deleted" });
      expect(result.ret).toBeUndefined();
    });

    it("propagates SDK errors from runAction", async () => {
      mockActionsRun.mockRejectedValueOnce(new Error("Action execution failed"));

      const client = createPipedreamClient(TEST_CONFIG);
      await expect(
        client.runAction({
          externalUserId: "user-42",
          componentKey: "gmail-send-email",
          configuredProps: { gmail: { authProvisionId: "apn_abc" } },
        }),
      ).rejects.toThrow("Action execution failed");
    });

    it("uses 30s timeout for action execution", async () => {
      mockActionsRun.mockResolvedValueOnce({
        body: { exports: {}, ret: null },
      });

      const client = createPipedreamClient(TEST_CONFIG);
      await client.runAction({
        externalUserId: "user-42",
        componentKey: "slack-send-message",
        configuredProps: { slack: { authProvisionId: "apn_slack" } },
      });

      expect(mockActionsRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeoutInSeconds: 30 }),
      );
    });
  });
});
