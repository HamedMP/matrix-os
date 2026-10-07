import { Hono } from "hono";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { describe, expect, it, vi } from "vitest";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const sha = "a".repeat(40);
const ticketId = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
type Case = [string, string, Record<string, unknown>, string, Record<string, string> | undefined];
const cases: Case[] = [
  ["posthog", "list_tickets", { region: "eu", projectId: 123, limit: 50, offset: 100 }, "https://eu.posthog.com/api/projects/123/conversations/tickets/", { limit: "50", offset: "100" }],
  ["posthog", "get_ticket", { region: "us", projectId: 123, ticketId }, `https://us.posthog.com/api/projects/123/conversations/tickets/${ticketId}/`, undefined],
  ["posthog", "list_ticket_messages", { region: "eu", projectId: 123, ticketId, limit: 50, offset: 100 }, `https://eu.posthog.com/api/projects/123/conversations/tickets/${ticketId}/messages/`, { limit: "50", offset: "100" }],
  ["github", "get_pr", { repo: "owner/repo", pull_number: 12 }, "https://api.github.com/repos/owner/repo/pulls/12", undefined],
  ["github", "list_pr_reviews", { repo: "owner/repo", pull_number: 12, page: 2, per_page: 50 }, "https://api.github.com/repos/owner/repo/pulls/12/reviews", { page: "2", per_page: "50" }],
  ["github", "list_check_runs", { repo: "owner/repo", sha, page: 2, per_page: 50 }, `https://api.github.com/repos/owner/repo/commits/${sha}/check-runs`, { page: "2", per_page: "50", filter: "latest" }],
  ["github", "get_combined_status", { repo: "owner/repo", sha, page: 2, per_page: 50 }, `https://api.github.com/repos/owner/repo/commits/${sha}/status`, { page: "2", per_page: "50" }],
  ["slack", "list_thread_replies", { channel: "C0123456789", ts: "1712345678.123456", cursor: "next+/=", limit: 15 }, "https://slack.com/api/conversations.replies", { channel: "C0123456789", ts: "1712345678.123456", cursor: "next+/=", limit: "15" }],
];

describe("developer read capabilities", () => {
  it.each(cases)("maps %s/%s through the selected connection's GET proxy", async (serviceId, actionId, params, url, query) => {
    const action = getAction(serviceId, actionId);
    expect(action).toBeDefined();
    expect(action!.risk).toBe("read");
    expect(validateActionParams(action!, params)).toEqual({ valid: true });
    const response = { state: "pending", messages: [], response_metadata: { next_cursor: "more" } };
    const proxyGet = vi.fn().mockResolvedValue(response);
    const runAction = vi.fn();
    const result = await executeIntegrationAction({
      pipedream: { proxyGet, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "selected-account" },
      def: getService(serviceId)!, actionDef: { ...action!, componentKey: "discovered-alternative" },
      serviceId, actionId, params,
    });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: "owner", accountId: "selected-account", url, params: query }));
    expect(runAction).not.toHaveBeenCalled();
    // Preserve upstream pending/empty/continuation information; never fabricate CI success.
    expect(result).toEqual({ data: response });
  });

  it.each([
    ["posthog", "list_tickets", { region: "http://localhost", projectId: 123 }],
    ["posthog", "list_tickets", { region: "eu", projectId: 0 }],
    ["posthog", "list_tickets", { region: "eu", projectId: "123" }],
    ["posthog", "list_tickets", { region: "eu", projectId: 1, offset: -1 }],
    ["posthog", "list_tickets", { region: "eu", projectId: 1, limit: 101 }],
    ["posthog", "get_ticket", { region: "eu", projectId: 1, ticketId: "../secrets" }],
    ["posthog", "list_ticket_messages", { region: "eu", projectId: 1, ticketId, limit: 101 }],
    ["posthog", "list_tickets", { region: "eu", projectId: 1, next: "https://evil.invalid" }],
    ["github", "get_pr", { repo: "owner/..", pull_number: 1 }],
    ["github", "get_pr", { repo: "owner/repo", pull_number: 0 }],
    ["github", "get_pr", { repo: "owner/repo", pull_number: 1.5 }],
    ["github", "get_pr", { repo: "owner/repo/extra", pull_number: 1 }],
    ["github", "list_pr_reviews", { repo: "owner/repo", pull_number: 1, page: 0 }],
    ["github", "list_pr_reviews", { repo: "owner/repo", pull_number: 1, per_page: 101 }],
    ["github", "list_check_runs", { repo: "owner/repo", sha: "main" }],
    ["github", "list_check_runs", { repo: "owner/repo", sha: `${sha}/../x` }],
    ["github", "get_combined_status", { repo: "owner/repo", sha, url: "https://evil.invalid" }],
    ["slack", "list_thread_replies", { channel: "#general", ts: "1712345678.123456" }],
    ["slack", "list_thread_replies", { channel: "C0123456789", ts: "1712345678/../x" }],
    ["slack", "list_thread_replies", { channel: "C0123456789", ts: "1712345678.123456", cursor: "bad\ncursor" }],
    ["slack", "list_thread_replies", { channel: "C0123456789", ts: "1712345678.123456", limit: 101 }],
  ] as [string, string, Record<string, unknown>][])("rejects invalid %s/%s before any proxy call", async (serviceId, actionId, params) => {
    const action = getAction(serviceId, actionId);
    expect(action).toBeDefined();
    const proxyGet = vi.fn();
    await expect(executeIntegrationAction({
      pipedream: { proxyGet } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "selected-account" },
      def: getService(serviceId)!, actionDef: action!, serviceId, actionId, params,
    })).rejects.toThrow("Invalid action parameters");
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("allows a full SHA-256 commit ID without accepting branch aliases", () => {
    const action = getAction("github", "list_check_runs");
    expect(action).toBeDefined();
    expect(validateActionParams(action!, { repo: "owner/repo", sha: "b".repeat(64) }).valid).toBe(true);
  });
});


describe("developer reads through the authenticated scoped route", () => {
  function setup(owner: string | null = "owner") {
    const proxyGet = vi.fn().mockResolvedValue({ count: 0, next: null, results: [] });
    const proxyPost = vi.fn();
    const listConnectedServices = vi.fn(async () => [
      { id: "connection", service: "posthog", account_label: "Support", pipedream_account_id: "support-account" },
    ]);
    const db = { listConnectedServices, getUserById: vi.fn(async () => ({ pipedream_external_id: "external-owner" })), touchServiceUsage: vi.fn() } as unknown as PlatformDb;
    const app = new Hono();
    app.route("/api/integrations", createIntegrationReadCallRoutes({
      db, pipedream: { proxyGet, proxyPost } as unknown as PipedreamConnectClient, resolveUserId: async () => owner,
    }));
    const read = (body: unknown) => app.request("/api/integrations/read-call", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { read, proxyGet, proxyPost, listConnectedServices };
  }

  it("preserves an authenticated empty ticket page and selected account", async () => {
    const { read, proxyGet, proxyPost, listConnectedServices } = setup();
    const response = await read({ service: "posthog", action: "list_tickets", label: "Support", params: { region: "eu", projectId: 123 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { count: 0, next: null, results: [] } });
    expect(listConnectedServices).toHaveBeenCalledWith("owner");
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "support-account", externalUserId: "external-owner", url: "https://eu.posthog.com/api/projects/123/conversations/tickets/" }));
    expect(proxyPost).not.toHaveBeenCalled();
  });

  it("rejects an attempted external write and arbitrary-host ticket read before connection lookup", async () => {
    const { read, proxyGet, proxyPost, listConnectedServices } = setup();
    expect((await read({ service: "github", action: "create_issue", label: "Support", params: { repo: "owner/repo", title: "No write" } })).status).toBe(403);
    expect((await read({ service: "posthog", action: "list_tickets", label: "Support", params: { region: "https://127.0.0.1", projectId: 123 } })).status).toBe(400);
    expect(proxyGet).not.toHaveBeenCalled();
    expect(proxyPost).not.toHaveBeenCalled();
    expect(listConnectedServices).not.toHaveBeenCalled();
  });

  it("does not retrieve accounts or provider data without an authenticated owner", async () => {
    const { read, proxyGet, listConnectedServices } = setup(null);
    expect((await read({ service: "posthog", action: "list_tickets", label: "Support", params: { region: "eu", projectId: 123 } })).status).toBe(401);
    expect(listConnectedServices).not.toHaveBeenCalled();
    expect(proxyGet).not.toHaveBeenCalled();
  });
});
