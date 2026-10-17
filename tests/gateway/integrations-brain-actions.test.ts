import { describe, expect, it, vi } from "vitest";
import type { BrainIntegrationService } from "../../packages/gateway/src/brain/contracts.js";
import { GITHUB_INTEGRATION_ACTIONS } from "../../packages/gateway/src/brain/sources/github/integration-client.js";
import { createBrainIntegrationCaller } from "../../packages/gateway/src/brain/sources/integration/index.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";

type Params = Record<string, unknown>;

/** Runs a registry action through the real execution path with a fake Pipedream proxy. */
async function proxied(serviceId: string, actionId: string, params: Params) {
  const actionDef = getAction(serviceId, actionId)!;
  const proxyGet = vi.fn().mockResolvedValue({ ok: true });
  const proxyPost = vi.fn().mockResolvedValue({ ok: true });
  const runAction = vi.fn();
  await executeIntegrationAction({
    pipedream: { proxyGet, proxyPost, runAction } as unknown as PipedreamConnectClient,
    externalUserId: "owner", connection: { pipedream_account_id: "account" },
    def: getService(serviceId)!, actionDef, serviceId, actionId, params,
  });
  expect(runAction).not.toHaveBeenCalled();
  return { proxyGet, proxyPost };
}

function valid(serviceId: string, actionId: string, params: Params): boolean {
  return validateActionParams(getAction(serviceId, actionId)!, params).valid;
}

const BRAIN_ACTIONS: [string, string][] = [
  ["github", "list_issues_since"], ["github", "brain_get_pr"], ["github", "brain_list_pr_commits"],
  ["github", "brain_list_pr_reviews"], ["github", "brain_list_pr_review_comments"], ["linear", "brain_issues"],
  ["linear", "brain_comments"], ["linear", "brain_project_updates"], ["google_drive", "brain_list_folder"],
  ["google_drive", "brain_export_text"], ["google_calendar", "brain_list_events"],
];

describe("Company Brain registry read actions", () => {
  it.each(BRAIN_ACTIONS)("registers %s/%s as a strict direct read", (serviceId, actionId) => {
    const action = getAction(serviceId, actionId);
    expect(action?.risk).toBe("read");
    expect(action?.directApi).toBeDefined();
    expect(action?.paramsSchema).toBeDefined();
    expect(getService(serviceId)?.connectorKind).toBe("pipedream");
  });

  it("serves the brain caller every action with the params the sources send", async () => {
    const user = { id: "0b6c5d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e", clerk_id: "user_2abc", pipedream_external_id: "ext_1" };
    const services = ["github", "linear", "google_drive", "google_calendar"];
    const db = {
      getUserByClerkId: vi.fn(async () => user), getUserById: vi.fn(async () => user),
      listConnectedServices: vi.fn(async () => services.map((service) => ({
        service, account_label: "work", pipedream_account_id: `apn_${service}`,
      }))),
    };
    // The brain's local transport reads only through the byte-capped raw proxy, never the SDK proxy.
    const proxyGet = vi.fn(async () => ({ items: [] }));
    const proxyPost = vi.fn(async () => ({ data: {} }));
    const boundedProxy = vi.fn(async (request: { method: string; url: string }) =>
      request.method === "POST" ? { data: {} } : request.url.endsWith("/export") ? "Plain text" : { items: [] });
    const caller = createBrainIntegrationCaller({
      db: db as never, pipedream: { proxyGet, proxyPost, boundedProxy } as never,
    });
    const now = "2026-10-02T12:00:00.000Z";
    const calls: [BrainIntegrationService, string, Params][] = [
      ["github", GITHUB_INTEGRATION_ACTIONS.issues, { repo: "octo/repo", since: "2026-01-02T03:04:05Z", page: 1, per_page: 50 }],
      ["github", GITHUB_INTEGRATION_ACTIONS.pull, { repo: "octo/repo", number: 12 }],
      ["github", GITHUB_INTEGRATION_ACTIONS.pull_commits, { repo: "octo/repo", number: 12, per_page: 100 }],
      ["github", GITHUB_INTEGRATION_ACTIONS.pull_reviews, { repo: "octo/repo", number: 12, per_page: 100 }],
      ["github", GITHUB_INTEGRATION_ACTIONS.pull_review_comments, { repo: "octo/repo", number: 12, per_page: 100 }],
      ...["brain_issues", "brain_comments", "brain_project_updates"].map((action): [BrainIntegrationService, string, Params] => [
        "linear", action, { teamKeys: ["ENG"], updatedSince: now, after: null, first: 100 },
      ]),
      ["google_drive", "brain_list_folder", { folderId: "folder_1", pageSize: 1_000 }],
      ["google_drive", "brain_export_text", { fileId: "doc_1" }],
      ["google_calendar", "brain_list_events", {
        calendarId: "primary", timeMin: "2026-09-02T00:00:00.000Z", timeMax: "2026-11-02T00:00:00.000Z", maxResults: 250,
      }],
    ];
    for (const [service, action, params] of calls) {
      const outcome = await caller.call("user_2abc", { service, action, params }, new AbortController().signal);
      expect(outcome.status, `${service}/${action}`).toBe("ok");
    }
    const requests = boundedProxy.mock.calls.map(([request]) => request as { method: string; url: string; maxBytes: number });
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(8);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(3);
    expect(requests.every((request) => request.url.startsWith("https://") && request.maxBytes === 4 * 1024 * 1024))
      .toBe(true);
    expect([proxyGet, proxyPost].map((fn) => fn.mock.calls.length)).toEqual([0, 0]);
    const exported = await caller.call("user_2abc", { service: "google_drive", action: "brain_export_text",
      params: { fileId: "doc_1" } }, new AbortController().signal);
    expect(exported).toEqual({ status: "ok", data: "Plain text" });
  });

  it("keeps the existing actions of the services it extends", () => {
    expect(Object.keys(getService("github")!.actions)).toEqual(expect.arrayContaining(["list_repos", "list_prs"]));
    expect(Object.keys(getService("linear")!.actions)).toEqual(expect.arrayContaining(["list_issues", "create_issue"]));
    expect(Object.keys(getService("google_drive")!.actions)).toEqual(expect.arrayContaining(["list_files", "share_file"]));
    expect(Object.keys(getService("google_calendar")!.actions)).toEqual(expect.arrayContaining(["list_events"]));
  });
});

describe("GitHub brain actions", () => {
  it("lists issues and pull requests since a time, every state, oldest update first", async () => {
    const { proxyGet } = await proxied("github", "list_issues_since", {
      repo: "octo/hello.world", since: "2026-01-02T03:04:05Z", page: 2, per_page: 50,
    });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account", url: "https://api.github.com/repos/octo/hello.world/issues",
      params: { state: "all", sort: "updated", direction: "asc", since: "2026-01-02T03:04:05Z", page: "2", per_page: "50" },
    }));
    const defaults = await proxied("github", "list_issues_since", { repo: "octo/repo", since: "2026-01-02T03:04:05Z" });
    expect(defaults.proxyGet.mock.calls[0]![0].params).toMatchObject({ page: "1", per_page: "50" });
  });

  it("gets one pull request and pages its commits, reviews and review comments", async () => {
    expect((await proxied("github", "brain_get_pr", { repo: "octo/repo", number: 12 })).proxyGet)
      .toHaveBeenCalledWith(expect.objectContaining({ url: "https://api.github.com/repos/octo/repo/pulls/12" }));
    for (const [actionId, suffix] of [
      ["brain_list_pr_commits", "commits"], ["brain_list_pr_reviews", "reviews"],
      ["brain_list_pr_review_comments", "comments"],
    ] as const) {
      const { proxyGet } = await proxied("github", actionId, { repo: "octo/repo", number: 12, per_page: 100 });
      expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
        url: `https://api.github.com/repos/octo/repo/pulls/12/${suffix}`, params: { per_page: "100" },
      }));
      const paged = await proxied("github", actionId, { repo: "octo/repo", number: 12, page: 3 });
      expect(paged.proxyGet.mock.calls[0]![0].params).toEqual({ page: "3", per_page: "100" });
    }
  });

  it.each([
    ["list_issues_since", { repo: "octo/repo" }],
    ["list_issues_since", { repo: "octo/repo", since: "yesterday" }],
    ["list_issues_since", { repo: "octo/repo", since: "2026-01-02" }],
    ["list_issues_since", { repo: "octo/../repo", since: "2026-01-02T03:04:05Z" }],
    ["list_issues_since", { repo: "octo/..", since: "2026-01-02T03:04:05Z" }],
    ["list_issues_since", { repo: "octo/repo", since: "2026-01-02T03:04:05Z", per_page: 101 }],
    ["list_issues_since", { repo: "octo/repo", since: "2026-01-02T03:04:05Z", page: 0 }],
    ["list_issues_since", { repo: "octo/repo", since: "2026-01-02T03:04:05Z", state: "open" }],
    ["brain_get_pr", { repo: "octo/repo" }],
    ["brain_get_pr", { repo: "octo/repo", number: 0 }],
    ["brain_get_pr", { repo: "octo/repo", number: 1.5 }],
    ["brain_get_pr", { repo: "octo/repo", number: "12" }],
    ["brain_get_pr", { repo: "octo/repo", number: 1_000_000_000 }],
    ["brain_list_pr_commits", { repo: "octo/repo", number: 12, per_page: 0 }],
    ["brain_list_pr_reviews", { repo: "a/b/c", number: 12 }],
    ["brain_list_pr_review_comments", { repo: "octo/repo", number: -1 }],
  ] as [string, Params][])("refuses %s params %j", (actionId, params) => {
    expect(valid("github", actionId, params)).toBe(false);
  });

  it("refuses path values again where they are built into a URL", () => {
    const url = (actionId: string, params: Params) => {
      const make = getAction("github", actionId)!.directApi!.url;
      return typeof make === "function" ? make(params) : make;
    };
    expect(() => url("brain_get_pr", { repo: "octo/repo", number: 1.5 })).toThrow("positive integer");
    expect(() => url("brain_get_pr", { repo: "octo/repo", number: "12/../../x" })).toThrow("positive integer");
    expect(() => url("brain_list_pr_reviews", { repo: "octo/repo", number: 0 })).toThrow("positive integer");
    expect(() => url("list_issues_since", { repo: "octo/../x" })).toThrow("owner/name");
  });
});

describe("Linear brain actions", () => {
  const params = { teamKeys: ["ENG", "OPS2"], updatedSince: "2026-01-02T03:04:05.000Z", first: 40, after: "cursor_1" };

  it.each([
    ["brain_issues", "MatrixBrainIssues", "issues", "filter: { team: { key: { in: $teamKeys } }, updatedAt: { gte: $since } }"],
    ["brain_comments", "MatrixBrainComments", "comments",
      "filter: { issue: { team: { key: { in: $teamKeys } } }, updatedAt: { gte: $since } }"],
    ["brain_project_updates", "MatrixBrainProjectUpdates", "projectUpdates",
      "filter: { project: { accessibleTeams: { some: { key: { in: $teamKeys } } } }, updatedAt: { gte: $since } }"],
  ])("%s posts one bounded GraphQL page with variables only", async (actionId, operation, field, filter) => {
    expect(valid("linear", actionId, params)).toBe(true);
    const { proxyPost } = await proxied("linear", actionId, params);
    const call = proxyPost.mock.calls[0]![0] as { url: string; body: { query: string; variables: Params } };
    expect(call.url).toBe("https://api.linear.app/graphql");
    const query = call.body.query.replace(/\s+/g, " ");
    expect(query).toContain(
      `query ${operation}($teamKeys: [String!]!, $since: DateTimeOrDuration!, $first: Int!, $after: String)`,
    );
    expect(query).toContain(`${field}(first: $first, after: $after, includeArchived: true, orderBy: updatedAt, ${filter}`);
    expect(query).toContain("pageInfo { hasNextPage endCursor }");
    expect(query).not.toContain("ENG");
    expect(query).not.toContain("cursor_1");
    expect(call.body.variables).toEqual({
      teamKeys: ["ENG", "OPS2"], since: "2026-01-02T03:04:05.000Z", first: 40, after: "cursor_1",
    });
  });

  it("asks for the fields the brain reads", () => {
    const query = (actionId: string) => (getAction("linear", actionId)!.directApi!.mapBody!(params) as { query: string })
      .query.replace(/\s+/g, " ");
    expect(query("brain_issues")).toContain(
      "nodes { id identifier title description url updatedAt dueDate priority archivedAt trashed creator { id } "
        + "assignee { id } state { name type } labels(first: 20) { nodes { name } } project { name } }",
    );
    expect(query("brain_comments")).toContain(
      "nodes { id body url updatedAt archivedAt user { id } issue { id identifier title } }",
    );
    expect(query("brain_project_updates")).toContain(
      "nodes { id body url updatedAt archivedAt health user { id } project { id name } }",
    );
  });

  it("starts at the first page and defaults the page size", async () => {
    const first = { teamKeys: ["ENG"], updatedSince: "2026-01-02T03:04:05+05:30", after: null };
    expect(valid("linear", "brain_issues", first)).toBe(true);
    const { proxyPost } = await proxied("linear", "brain_issues", first);
    expect(proxyPost.mock.calls[0]![0].body.variables).toEqual({
      teamKeys: ["ENG"], since: "2026-01-02T03:04:05+05:30", first: 50, after: null,
    });
  });

  it.each([
    { updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: [], updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: "ENG", updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: ["eng"], updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: ["ENG\" } }"], updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: ["ABCDEFGHIJK"], updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: Array.from({ length: 21 }, (_, i) => `T${i}`), updatedSince: "2026-01-02T03:04:05Z" },
    { teamKeys: ["ENG"], updatedSince: "P2W" },
    { teamKeys: ["ENG"], updatedSince: "2026-01-02T03:04:05Z", first: 101 },
    { teamKeys: ["ENG"], updatedSince: "2026-01-02T03:04:05Z", after: "" },
    { teamKeys: ["ENG"], updatedSince: "2026-01-02T03:04:05Z", after: "x".repeat(513) },
    { teamKeys: ["ENG"], updatedSince: "2026-01-02T03:04:05Z", filter: { id: { eq: "x" } } },
  ] as Params[])("refuses brain_issues params %j", (bad) => {
    expect(valid("linear", "brain_issues", bad)).toBe(false);
  });
});

describe("Google Drive brain actions", () => {
  it("lists one folder's children that are not trashed, shared drives included", async () => {
    const { proxyGet } = await proxied("google_drive", "brain_list_folder", {
      folderId: "folder_A-1", pageSize: 200, pageToken: "next+/=",
    });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://www.googleapis.com/drive/v3/files",
      params: {
        q: "'folder_A-1' in parents and trashed = false",
        fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink,"
          + "lastModifyingUser(emailAddress),capabilities(canDownload))",
        pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true", pageToken: "next+/=",
      },
    }));
    const first = await proxied("google_drive", "brain_list_folder", { folderId: "root" });
    expect(first.proxyGet.mock.calls[0]![0].params).toMatchObject({ pageSize: "1000" });
    expect(first.proxyGet.mock.calls[0]![0].params).not.toHaveProperty("pageToken");
  });

  it("exports a Google Doc as plain text", async () => {
    const { proxyGet } = await proxied("google_drive", "brain_export_text", { fileId: "doc_1-x" });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://www.googleapis.com/drive/v3/files/doc_1-x/export", params: { mimeType: "text/plain" },
    }));
  });

  it.each([
    ["brain_list_folder", { folderId: "a' or name contains 'x" }],
    ["brain_list_folder", { folderId: "a\\b" }],
    ["brain_list_folder", { folderId: "" }],
    ["brain_list_folder", { folderId: "x".repeat(257) }],
    ["brain_list_folder", { folderId: "f", pageSize: 1001 }],
    ["brain_list_folder", { folderId: "f", pageToken: "a b" }],
    ["brain_list_folder", { folderId: "f", query: "x" }],
    ["brain_export_text", { fileId: "../about" }],
    ["brain_export_text", { fileId: "d", mimeType: "application/pdf" }],
    ["brain_export_text", {}],
  ] as [string, Params][])("refuses %s params %j", (actionId, params) => {
    expect(valid("google_drive", actionId, params)).toBe(false);
  });

  it("refuses an unchecked id where it is built into the query or the URL", () => {
    const drive = (actionId: string) => getAction("google_drive", actionId)!.directApi!;
    expect(() => drive("brain_list_folder").mapParams!({ folderId: "a' or 'b" })).toThrow("Drive id");
    const url = drive("brain_export_text").url;
    expect(() => (typeof url === "function" ? url({ fileId: "../x" }) : url)).toThrow("Drive id");
  });
});

describe("Google Calendar brain action", () => {
  const window = { timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-03-01T00:00:00.000Z" };

  it("lists one calendar's event instances in a window, cancelled included", async () => {
    const { proxyGet } = await proxied("google_calendar", "brain_list_events", {
      calendarId: "team@group.calendar.google.com", ...window, maxResults: 100, pageToken: "p2",
    });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events",
      params: {
        singleEvents: "true", showDeleted: "true", orderBy: "startTime", maxAttendees: "50", ...window,
        maxResults: "100",
        fields: "nextPageToken,items(id,status,htmlLink,summary,description,location,visibility,start,end,updated,"
          + "organizer(email),attendees(email,responseStatus,resource))",
        pageToken: "p2",
      },
    }));
  });

  it("narrows by updatedMin when given and defaults the page size", async () => {
    const { proxyGet } = await proxied("google_calendar", "brain_list_events", {
      calendarId: "primary", ...window, updatedMin: "2026-01-15T10:00:00+01:00",
    });
    expect(proxyGet.mock.calls[0]![0].params).toMatchObject({ updatedMin: "2026-01-15T10:00:00+01:00", maxResults: "250" });
    const plain = await proxied("google_calendar", "brain_list_events", { calendarId: "primary", ...window });
    expect(plain.proxyGet.mock.calls[0]![0].params).not.toHaveProperty("updatedMin");
    expect(plain.proxyGet.mock.calls[0]![0].params).not.toHaveProperty("pageToken");
  });

  it.each([
    { calendarId: ".", ...window },
    { calendarId: "..", ...window },
    { calendarId: "a b", ...window },
    { calendarId: "a\u0085b", ...window },
    { calendarId: "x".repeat(257), ...window },
    { calendarId: "primary", timeMin: window.timeMin },
    { calendarId: "primary", timeMin: "2026-01-01", timeMax: window.timeMax },
    { calendarId: "primary", timeMin: window.timeMax, timeMax: window.timeMin },
    { calendarId: "primary", ...window, updatedMin: "today" },
    { calendarId: "primary", ...window, maxResults: 251 },
    { calendarId: "primary", ...window, pageToken: "" },
    { calendarId: "primary", ...window, q: "secret" },
  ] as Params[])("refuses params %j", (params) => {
    expect(valid("google_calendar", "brain_list_events", params)).toBe(false);
  });

  it("refuses dot path ids where the URL is built", () => {
    const url = getAction("google_calendar", "brain_list_events")!.directApi!.url;
    const build = (calendarId: unknown) => (typeof url === "function" ? url({ calendarId }) : url);
    expect(() => build("..")).toThrow("calendar id");
    expect(() => build(42)).toThrow("calendar id");
    expect(build("a/b")).toBe("https://www.googleapis.com/calendar/v3/calendars/a%2Fb/events");
  });
});
