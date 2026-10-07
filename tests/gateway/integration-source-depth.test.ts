import { describe, expect, it, vi } from "vitest";
import { GMAIL_SERVICE } from "../../packages/gateway/src/integrations/gmail.js";
import { GOOGLE_SERVICES } from "../../packages/gateway/src/integrations/google.js";
import { OAUTH_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-oauth.js";
import { EXPANSION_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-expansion.js";
import { GITHUB_DEPTH_ACTIONS } from "../../packages/gateway/src/integrations/github-depth.js";
import { createBoundedPipedreamGet, BoundedPipedreamReadError } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

describe("existing source depth", () => {
  it("discovers calendars and binds events to an explicit encoded calendar", () => {
    const actions = GOOGLE_SERVICES.google_calendar.actions;
    expect(actions.list_calendars.directApi?.url).toBe("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    expect(actions.list_events.paramsSchema?.safeParse({ calendarId: "team@example.com", maxResults: 50 }).success).toBe(true);
    expect(typeof actions.list_events.directApi?.url === "function" && actions.list_events.directApi.url({ calendarId: "team@example.com" })).toContain("team%40example.com/events");
    expect(actions.list_events.paramsSchema?.safeParse({ calendarId: "../other" }).success).toBe(false);
  });
  it("reads one Notion child-block page with the existing reviewed API version", () => {
    const action = EXPANSION_SERVICE_REGISTRY.notion.actions.list_block_children;
    expect(action.risk).toBe("read");
    expect(action.paramsSchema?.safeParse({ blockId: "c02fc1d3-db8b-45c5-a222-27595b15aea7", pageSize: 100, startCursor: "next" }).success).toBe(true);
    expect(action.directApi?.mapParams?.({ pageSize: 50, startCursor: "next" })).toEqual({ page_size: "50", start_cursor: "next" });
    expect(action.paramsSchema?.safeParse({ blockId: "../other", pageSize: 101 }).success).toBe(false);
  });
  it("continues Notion search and database query from the durable refresh cursor", () => {
    const actions = EXPANSION_SERVICE_REGISTRY.notion.actions;
    expect(actions.search.directApi?.mapBody?.({ query: "Plan", startCursor: "next", pageSize: 25 })).toEqual({ query: "Plan", start_cursor: "next", page_size: 25 });
    expect(actions.query_database.directApi?.mapBody?.({ databaseId: "c02fc1d3-db8b-45c5-a222-27595b15aea7", startCursor: "next", pageSize: 25 })).toEqual({ start_cursor: "next", page_size: 25 });
    expect(actions.search.paramsSchema?.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(actions.query_database.paramsSchema?.safeParse({ databaseId: "../secret" }).success).toBe(false);
  });
  it("classifies Todoist mutations as writes and maps only approved task fields", () => {
    const actions = OAUTH_SERVICE_REGISTRY.todoist.actions;
    expect(actions.create_task.risk).toBe("write");
    expect(actions.update_task.risk).toBe("write");
    expect(actions.complete_task.risk).toBe("write");
    expect(actions.create_task.directApi?.mapBody?.({ content: "Plan", projectId: "project_1", priority: 4 })).toEqual({ content: "Plan", project_id: "project_1", priority: 4 });
    expect(actions.update_task.paramsSchema?.safeParse({ taskId: "task_1" }).success).toBe(false);
    expect(actions.create_task.paramsSchema?.safeParse({ content: "", priority: 5 }).success).toBe(false);
  });
  it("provides paged GitHub reviews, files and checks with strict repository validation", () => {
    for (const id of ["get_pr", "list_pr_reviews", "list_pr_files", "list_check_runs"]) expect(GITHUB_DEPTH_ACTIONS[id].risk).toBe("read");
    expect(GITHUB_DEPTH_ACTIONS.list_pr_reviews.paramsSchema?.safeParse({ repo: "owner/repo", pullNumber: 12, page: 2, perPage: 50 }).success).toBe(true);
    expect(GITHUB_DEPTH_ACTIONS.list_pr_reviews.paramsSchema?.safeParse({ repo: "owner/..", pullNumber: 12 }).success).toBe(false);
    expect(GITHUB_DEPTH_ACTIONS.list_check_runs.paramsSchema?.safeParse({ repo: "owner/repo", ref: "../secret" }).success).toBe(false);
  });
  it("provides paged read-only Stripe payouts, refunds, charges and balance reconciliation", () => {
    for (const id of ["list_payouts", "list_refunds", "list_charges", "list_balance_transactions"]) {
      const action = EXPANSION_SERVICE_REGISTRY.stripe.actions[id];
      expect(action.risk).toBe("read");
      expect(action.paramsSchema?.safeParse({ limit: 101 }).success).toBe(false);
    }
    expect(EXPANSION_SERVICE_REGISTRY.stripe.actions.list_balance_transactions.directApi?.mapParams?.({ payoutId: "po_123", startingAfter: "txn_1", limit: 20 })).toEqual({ limit: "20", starting_after: "txn_1", payout: "po_123" });
  });
  it("reads HubSpot contact/deal details and explicitly selected activity object types", () => {
    const actions = OAUTH_SERVICE_REGISTRY.hubspot.actions;
    expect(actions.get_contact.paramsSchema?.safeParse({ contactId: "123", properties: ["email", "firstname"] }).success).toBe(true);
    expect(actions.get_contact.directApi?.mapParams?.({ properties: ["email", "firstname"] })).toEqual({ properties: "email,firstname" });
    expect(actions.list_activities.paramsSchema?.safeParse({ activityType: "notes", limit: 50 }).success).toBe(true);
    expect(actions.list_activities.paramsSchema?.safeParse({ activityType: "../contacts" }).success).toBe(false);
  });
  it("uses the selected owner/account bounded seam for Gmail attachment reads", async () => {
    const boundedGmailGet = vi.fn().mockResolvedValue({ size: 3, data: "YWJj" });
    await executeIntegrationAction({ pipedream: { boundedGmailGet } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: GMAIL_SERVICE,
      actionDef: GMAIL_SERVICE.actions.get_attachment, serviceId: "gmail", actionId: "get_attachment",
      params: { messageId: "abc", attachmentId: "attach_1" } });
    expect(boundedGmailGet).toHaveBeenCalledExactlyOnceWith({ externalUserId: "owner", accountId: "account", kind: "attachment", id: "abc", attachmentId: "attach_1" });
  });
  it("executes reviewed direct task writes with immutable account binding and no component fallback", async () => {
    const proxyPost = vi.fn().mockResolvedValue({ id: "task_1" });
    const runAction = vi.fn();
    const service = OAUTH_SERVICE_REGISTRY.todoist;
    await executeIntegrationAction({ pipedream: { proxyPost, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: service,
      actionDef: { ...service.actions.create_task, componentKey: "todoist-create-task" }, serviceId: "todoist", actionId: "create_task",
      params: { content: "Plan", projectId: "project_1", dueDate: "2026-10-09" } });
    expect(proxyPost).toHaveBeenCalledExactlyOnceWith({ externalUserId: "owner", accountId: "account", url: "https://api.todoist.com/api/v1/tasks", body: { content: "Plan", project_id: "project_1", due_date: "2026-10-09" } });
    expect(runAction).not.toHaveBeenCalled();
  });
  it("rejects account/host overrides and malformed write params before network execution", async () => {
    const proxyPost = vi.fn();
    const service = OAUTH_SERVICE_REGISTRY.todoist;
    for (const params of [{ content: "Plan", accountId: "other" }, { taskId: "../other", content: "Plan" }, { content: "Plan", priority: 5 }]) {
      await expect(executeIntegrationAction({ pipedream: { proxyPost } as unknown as PipedreamConnectClient,
        externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: service,
        actionDef: service.actions.create_task, serviceId: "todoist", actionId: "create_task", params })).rejects.toThrow("Invalid action parameters");
    }
    expect(proxyPost).not.toHaveBeenCalled();
  });
  it("validates selected-calendar writes and preserves required event chronology", () => {
    const actions = GOOGLE_SERVICES.google_calendar.actions;
    expect(actions.create_event.paramsSchema?.safeParse({ calendarId: "team@example.com", summary: "Plan", start: "2026-10-09T09:00:00+02:00", end: "2026-10-09T10:00:00+02:00" }).success).toBe(true);
    expect(actions.create_event.paramsSchema?.safeParse({ summary: "Plan", start: "2026-10-09T10:00:00Z", end: "2026-10-09T09:00:00Z" }).success).toBe(false);
    expect(actions.update_event.paramsSchema?.safeParse({ eventId: "abc" }).success).toBe(false);
  });
});

describe("bounded Gmail attachments", () => {
  const input = { externalUserId: "owner", accountId: "account", kind: "attachment", id: "abc", attachmentId: "attach_1" };
  const get = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => createBoundedPipedreamGet({ projectId: "project", environment: "production", getAccessToken: async () => "token", fetcher });
  it("returns validated base64 data from the fixed Gmail host without redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ size: 3, data: "YWJj" }));
    expect(await get(fetcher)(input)).toEqual({ size: 3, data: "YWJj" });
    const [url, init] = fetcher.mock.calls[0];
    const proxy = new URL(url);
    const target = Buffer.from(proxy.pathname.split("/").at(-1)!, "base64url").toString();
    expect(target).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/attachments/attach_1");
    expect(proxy.searchParams.get("account_id")).toBe("account");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([{ size: 2, data: "YWJj" }, { size: 3, data: "!!!!" }, { size: 1048577, data: "" }])("rejects malformed or oversize attachment bodies %j", async (body) => {
    await expect(get(async () => Response.json(body))(input)).rejects.toBeInstanceOf(BoundedPipedreamReadError);
  });
  it("cancels an oversized streamed response before parsing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); }, cancel });
    await expect(get(async () => new Response(body))(input)).rejects.toBeInstanceOf(BoundedPipedreamReadError);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects invalid attachment IDs without resolving credentials or contacting upstream", async () => {
    const fetcher = vi.fn();
    await expect(get(fetcher)({ ...input, attachmentId: "../other" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects upstream failure and advertised oversize without parsing or retry", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("not-json", { status: 200, headers: { "content-length": "2000000" } }));
    await expect(get(fetcher)(input)).rejects.toBeInstanceOf(BoundedPipedreamReadError);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(get(async () => new Response("not-json", { status: 401 }))(input)).rejects.toBeInstanceOf(BoundedPipedreamReadError);
  });
  it("honors cancellation while reading a stalled stream", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { abort.abort(); }, cancel }, { highWaterMark: 0 });
    await expect(get(async () => new Response(body))(input, abort.signal)).rejects.toBeInstanceOf(BoundedPipedreamReadError);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("fails closed if the bounded seam is missing instead of switching to paid actions", async () => {
    const proxyGet = vi.fn(); const runAction = vi.fn();
    await expect(executeIntegrationAction({ pipedream: { proxyGet, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: GMAIL_SERVICE,
      actionDef: GMAIL_SERVICE.actions.get_attachment, serviceId: "gmail", actionId: "get_attachment",
      params: { messageId: "abc", attachmentId: "attach_1" } })).rejects.toBeInstanceOf(BoundedPipedreamReadError);
    expect(proxyGet).not.toHaveBeenCalled(); expect(runAction).not.toHaveBeenCalled();
  });
});
