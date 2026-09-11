import { describe, expect, it, vi } from "vitest";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";
import { executeIntegrationAction, validateActionParams } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const cases: [string, string, Record<string, unknown>, Record<string, string>][] = [
  ["google_calendar", "list_events", { pageToken: "next+/=", maxResults: 30 }, { pageToken: "next+/=", maxResults: "30" }],
  ["google_drive", "list_files", { pageToken: "next+/=", maxResults: 30 }, { pageToken: "next+/=", pageSize: "30" }],
  ["github", "list_repos", { page: 2, per_page: 50 }, { page: "2", per_page: "50" }],
  ["github", "get_notifications", { page: 3, per_page: 20, all: true }, { page: "3", per_page: "20", all: "true" }],
  ["github", "list_issues", { repo: "owner/repo", page: 2, per_page: 50 }, { page: "2", per_page: "50" }],
  ["github", "list_prs", { repo: "owner/repo", page: 2, per_page: 50 }, { page: "2", per_page: "50" }],
  ["slack", "list_channels", { cursor: "opaque", limit: 50 }, { cursor: "opaque", limit: "50" }],
  ["slack", "list_messages", { channel: "C123", cursor: "opaque" }, { channel: "C123", cursor: "opaque" }],
  ["slack", "search", { query: "meetings", page: 2, count: 50 }, { page: "2", count: "50" }],
  ["discord", "list_servers", { after: "18446744073709551615", limit: 50 }, { after: "18446744073709551615", limit: "50" }],
  ["discord", "list_messages", { channelId: "123456789012345678", before: "18446744073709551615" }, { before: "18446744073709551615" }],
];

describe("managed list pagination", () => {
  it.each(cases)("forwards %s/%s continuation with filters", async (serviceId, actionId, params, expected) => {
    const actionDef = getAction(serviceId, actionId)!;
    const response = { items: [], nextPageToken: "next", response_metadata: { next_cursor: "more" } };
    const proxyGet = vi.fn().mockResolvedValue(response);
    const runAction = vi.fn();
    expect(validateActionParams(actionDef, params)).toEqual({ valid: true });
    const result = await executeIntegrationAction({
      pipedream: { proxyGet, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" },
      def: getService(serviceId)!, actionDef, serviceId, actionId, params,
    });
    expect(result).toEqual({ data: response });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining(expected) }));
  });

  it("requests Drive's continuation and completeness fields", () => {
    expect(getAction("google_drive", "list_files")!.directApi!.mapParams!({}).fields).toContain("nextPageToken");
    expect(getAction("google_drive", "list_files")!.directApi!.mapParams!({}).fields).toContain("incompleteSearch");
  });

  it.each([
    ["google_calendar", "list_events", { maxResults: 2501 }],
    ["google_drive", "list_files", { maxResults: 0 }],
    ["google_drive", "list_files", { pageToken: "x".repeat(2049) }],
    ["github", "list_repos", { page: -1 }],
    ["github", "list_issues", { repo: "owner/repo", per_page: 101 }],
    ["github", "list_prs", { repo: "owner/repo", page: 1.5 }],
    ["slack", "list_channels", { cursor: "a\nb" }],
    ["slack", "list_messages", { channel: "C123", limit: 0 }],
    ["slack", "search", { query: "a", count: 101 }],
    ["discord", "list_servers", { after: 123456789012345678 }],
    ["discord", "list_messages", { channelId: "123456789012345678", before: "1", after: "2" }],
  ] as [string, string, Record<string, unknown>][])("rejects invalid %s/%s boundaries", (serviceId, actionId, params) => {
    expect(validateActionParams(getAction(serviceId, actionId)!, params).valid).toBe(false);
  });

  it("does not let discovered component keys replace reviewed direct pagination mappings", async () => {
    const proxyGet = vi.fn();
    const runAction = vi.fn();
    const actionDef = { ...getAction("gmail", "list_messages")!, componentKey: "gmail-list-messages" };
    await executeIntegrationAction({
      pipedream: { proxyGet, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: getService("gmail")!,
      actionDef, serviceId: "gmail", actionId: "list_messages", params: { pageToken: "next" },
    });
    expect(proxyGet).toHaveBeenCalledOnce();
    expect(runAction).not.toHaveBeenCalled();
  });
});
