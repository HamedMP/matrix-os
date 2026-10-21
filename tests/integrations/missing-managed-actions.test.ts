import { describe, it, expect, vi } from "vitest";
import { GOOGLE_SERVICES } from "../../packages/gateway/src/integrations/google.js";
import { EXPANSION_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-expansion.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { createBoundedManagedAction } from "../../packages/gateway/src/integrations/bounded-managed-action.js";

vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(), randomBytes: () => Buffer.from("fixed-boundary") }));
const cloudId = "12345678-abcd-1234-abcd-123456789012";
const identity = { externalUserId: "user-1", accountId: "apn_1" };
const service = (id: string) => id === "google_drive" ? GOOGLE_SERVICES[id] : EXPANSION_SERVICE_REGISTRY[id];
const request = (serviceId: string, actionId: string, params: Record<string, unknown> = {}) => ({ ...identity, serviceId, actionId, params: serviceId === "posthog" ? { region: "eu", ...params } : params });
const target = (url: string) => Buffer.from(new URL(url).pathname.split("/").at(-1)!, "base64url").toString();
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const setup = (fetcher = vi.fn().mockResolvedValue(json({ ok: true }))) => ({ fetcher, execute: createBoundedManagedAction({ projectId: "proj_1", environment: "production", getAccessToken: async () => "secret", fetcher }) });

describe("missing managed action mappings", () => {
  it("declares implemented bounded mappings and explicit write risk", () => {
    for (const id of ["google_drive", "jira", "posthog"]) {
      for (const [name, action] of Object.entries(service(id).actions)) {
        if (id === "google_drive" && name !== "upload_file") continue;
        expect(action.paramsSchema, `${id}/${name}`).toBeDefined();
        expect(action.directApi, `${id}/${name}`).toBeDefined();
      }
    }
    expect(service("google_drive").actions.upload_file.risk).toBe("write");
    for (const name of ["create_issue", "update_issue", "add_comment"]) expect(service("jira").actions[name].risk).toBe("write");
    expect(service("posthog").actions.create_insight.risk).toBe("write");
    expect(service("posthog").actions.update_insight.risk).toBe("write");
  });
  it("executes Drive UTF-8 multipart upload through the exact connection with forwarded content type", async () => {
    const { execute, fetcher } = setup();
    await execute(request("google_drive", "upload_file", { name: "notes.txt", content: "héllo", folderId: "folder_1" }));
    const [url, init] = fetcher.mock.calls[0];
    expect(target(url)).toContain("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    expect(new URL(url).searchParams.get("account_id")).toBe("apn_1");
    expect(init.method).toBe("POST");
    expect(init.headers["x-pd-proxy-content-type"]).toMatch(/^multipart\/related; boundary=/);
    expect(init.body).toContain('"parents":["folder_1"]');
    expect(init.body).toContain("héllo");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([{ name: "a", content: "a".repeat(8193) }, { name: "a", content: "ok", mimeType: "text/plain\r\nX: y" }, { name: "a", content: "ok", url: "https://attacker.test" }])("rejects invalid upload before token or network", async params => {
    const { execute, fetcher } = setup();
    await expect(execute(request("google_drive", "upload_file", params))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preflights Jira cloud resources using the same connection and uses current enhanced JQL search", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json([{ id: cloudId, name: "Team", scopes: ["read:jira-work"] }])).mockResolvedValueOnce(json({ issues: [] }));
    const { execute } = setup(fetcher);
    await execute(request("jira", "search_issues", { cloudId, jql: "project = TEAM", maxResults: 10 }));
    expect(target(fetcher.mock.calls[0][0])).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect(target(fetcher.mock.calls[1][0])).toContain(`/ex/jira/${cloudId}/rest/api/3/search/jql?`);
    expect(target(fetcher.mock.calls[1][0])).toContain("maxResults=10");
    expect(fetcher.mock.calls.every(([url]) => new URL(url).searchParams.get("account_id") === "apn_1")).toBe(true);
  });
  it("rejects Jira writes outside the selected account's sites before mutation", async () => {
    const { execute, fetcher } = setup(vi.fn().mockResolvedValue(json([])));
    await expect(execute(request("jira", "create_issue", { cloudId, projectKey: "TEAM", issueType: "Task", summary: "A" }))).rejects.toThrow("Integration action unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("maps Jira writes without accepting generic fields or arbitrary hosts", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json([{ id: cloudId }])).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await setup(fetcher).execute(request("jira", "update_issue", { cloudId, issueKey: "TEAM-1", fields: { summary: "Updated" } }));
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT", body: '{"fields":{"summary":"Updated"}}' });
    await expect(setup().execute(request("jira", "update_issue", { cloudId, issueKey: "TEAM-1", fields: { customfield_1: "unsafe" } }))).rejects.toThrow();
  });
  it("rejects unbounded query structures and PostHog host injection", async () => {
    for (const params of [{ projectId: 1, query: { kind: "HogQLQuery", query: "delete from events" } }, { projectId: 1, host: "https://attacker.test" }]) {
      const { execute, fetcher } = setup();
      await expect(execute(request("posthog", "query", params))).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it.each([401, 403, 500])("returns a generic failure for provider status %s", async status => {
    const { execute } = setup(vi.fn().mockResolvedValue(new Response("private upstream secret", { status })));
    await expect(execute(request("posthog", "list_projects"))).rejects.toThrow("Integration action unavailable");
  });
  it("rejects overlarge streamed bodies and declared lengths", async () => {
    for (const response of [new Response("a".repeat(1048577)), new Response("{}", { headers: { "content-length": "1048577" } })]) {
      const { execute } = setup(vi.fn().mockResolvedValue(response));
      await expect(execute(request("posthog", "list_projects"))).rejects.toThrow("Integration action unavailable");
    }
  });
  it("uses only explicit fixed PostHog region origins", async () => {
    const { execute, fetcher } = setup();
    await execute(request("posthog", "list_insights", { projectId: 7, limit: 10, offset: 20 }));
    expect(target(fetcher.mock.calls[0][0])).toBe("https://eu.posthog.com/api/projects/7/insights/?limit=10&offset=20");
  });
  it("maps each Jira action to its reviewed endpoint and preserves bodies", async () => {
    const body = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };
    for (const [actionId, params, method, path, payload] of [
      ["list_projects", { cloudId }, "GET", "/project/search?maxResults=25&startAt=0", undefined],
      ["get_issue", { cloudId, issueKey: "TEAM-1" }, "GET", "/issue/TEAM-1?", undefined],
      ["create_issue", { cloudId, projectKey: "TEAM", issueType: "Task", summary: "New", description: body }, "POST", "/issue", { fields: { project: { key: "TEAM" }, issuetype: { name: "Task" }, summary: "New", description: body } }],
      ["add_comment", { cloudId, issueKey: "TEAM-1", body }, "POST", "/issue/TEAM-1/comment", { body }],
    ] as const) {
      const fetcher = vi.fn().mockResolvedValueOnce(json([{ id: cloudId }])).mockResolvedValueOnce(json({ ok: true }));
      await setup(fetcher).execute(request("jira", actionId, params));
      expect(target(fetcher.mock.calls[1][0])).toContain(path);
      expect(fetcher.mock.calls[1][1].method).toBe(method);
      expect(fetcher.mock.calls[1][1].body).toBe(payload ? JSON.stringify(payload) : undefined);
    }
    const { execute, fetcher } = setup();
    await execute(request("jira", "list_sites"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("creates and updates PostHog insights with constrained queries and metadata", async () => {
    const query = { kind: "TrendsQuery", dateRange: { date_from: "2026-10-01", date_to: "2026-10-10" }, series: [{ kind: "EventsNode", event: "$pageview" }] };
    for (const [actionId, params, method, path, payload] of [
      ["get_insight", { projectId: 7, insightId: 8 }, "GET", "/api/projects/7/insights/8/", undefined],
      ["query", { projectId: 7, query }, "POST", "/api/projects/7/query/", { query, refresh: "blocking" }],
      ["create_insight", { projectId: 7, name: "Views", query: { kind: "InsightVizNode", source: query }, description: "Counts" }, "POST", "/api/projects/7/insights/", { name: "Views", query: { kind: "InsightVizNode", source: query }, description: "Counts" }],
      ["update_insight", { projectId: 7, insightId: 8, name: "Updated" }, "PATCH", "/api/projects/7/insights/8/", { name: "Updated" }],
    ] as const) {
      const { execute, fetcher } = setup();
      await execute(request("posthog", actionId, params));
      expect(target(fetcher.mock.calls[0][0])).toBe(`https://eu.posthog.com${path}`);
      expect(fetcher.mock.calls[0][1].method).toBe(method);
      expect(fetcher.mock.calls[0][1].body).toBe(payload ? JSON.stringify(payload) : undefined);
    }
  });
  it("bounds schemas for Jira and PostHog and rejects unknown operations", async () => {
    const invalid = [
      request("jira", "get_issue", { cloudId: "../private", issueKey: "TEAM-1" }),
      request("jira", "get_issue", { cloudId, issueKey: "TEAM-1/../../secret" }),
      request("jira", "update_issue", { cloudId, issueKey: "TEAM-1", fields: {} }),
      request("posthog", "update_insight", { projectId: 1, insightId: 2 }),
      request("posthog", "list_projects", { limit: 101 }),
      request("posthog", "get_insight", { projectId: Infinity, insightId: 1 }),
      request("posthog", "query", { projectId: 1, query: { kind: "TrendsQuery", dateRange: { date_from: "2026-01-01", date_to: "2026-10-01" }, series: [{ kind: "EventsNode", event: "e" }] } }),
      request("posthog", "query", { projectId: 1, query: { kind: "TrendsQuery", dateRange: { date_from: "2026-02-30", date_to: "2026-03-01" }, series: [{ kind: "EventsNode", event: "e" }] } }),
      request("google_drive", "delete_everything"),
      request("posthog", "constructor"),
    ];
    for (const input of invalid) {
      const { execute, fetcher } = setup();
      await expect(execute(input)).rejects.toThrow("Integration action unavailable");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("applies the deadline before token resolution and across a stalled response body", async () => {
    vi.useFakeTimers();
    try {
      const getAccessToken = vi.fn(() => new Promise<string>(() => undefined));
      const fetcher = vi.fn();
      const controller = new AbortController();
      const execute = createBoundedManagedAction({ projectId: "proj_1", environment: "production", getAccessToken, fetcher });
      const result = expect(execute(request("posthog", "list_projects"), controller.signal)).rejects.toThrow("Integration action unavailable");
      await Promise.resolve();
      controller.abort();
      await result;
      expect(fetcher).not.toHaveBeenCalled();
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); } });
      const nextController = new AbortController();
      const fixture = setup(vi.fn().mockResolvedValue(new Response(body)));
      const bodyResult = expect(fixture.execute(request("posthog", "list_projects"), nextController.signal)).rejects.toThrow("Integration action unavailable");
      await vi.advanceTimersByTimeAsync(1);
      nextController.abort();
      await bodyResult;
    } finally { vi.useRealTimers(); }
  });
  it("rejects invalid JSON and aborts before calling the transport", async () => {
    const { execute } = setup(vi.fn().mockResolvedValue(new Response("not JSON")));
    await expect(execute(request("posthog", "list_projects"))).rejects.toThrow("Integration action unavailable");
    const fixture = setup();
    const controller = new AbortController(); controller.abort();
    await expect(fixture.execute(request("posthog", "list_projects"), controller.signal)).rejects.toThrow("Integration action unavailable");
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it("handles defaults, optional fields, US region and rejects missing region", async () => {
    const fixture = setup();
    await fixture.execute(request("posthog", "list_projects", { region: "us", limit: 5, offset: 1 }));
    expect(target(fixture.fetcher.mock.calls[0][0])).toBe("https://us.posthog.com/api/projects/?limit=5&offset=1");
    await expect(fixture.execute({ ...request("posthog", "list_projects"), params: {} })).rejects.toThrow();
    await setup().execute({ ...identity, serviceId: "jira", actionId: "list_sites" });
    await setup().execute(request("google_drive", "upload_file", { name: "x", content: "", mimeType: "text/markdown" }));
    const fetcher = vi.fn().mockResolvedValueOnce(json([{ id: cloudId }])).mockResolvedValueOnce(json({ issues: [] }));
    await setup(fetcher).execute(request("jira", "search_issues", { cloudId, jql: "project = TEAM", nextPageToken: "next" }));
    expect(target(fetcher.mock.calls[1][0])).toContain("nextPageToken=next");
    const create = vi.fn().mockResolvedValueOnce(json([{ id: cloudId }])).mockResolvedValueOnce(json({ id: "1" }));
    await setup(create).execute(request("jira", "create_issue", { cloudId, projectKey: "TEAM", issueType: "Task", summary: "New" }));
    expect(create.mock.calls[1][1].body).not.toContain("description");
    await setup().execute(request("posthog", "create_insight", { projectId: 1, name: "Views", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", dateRange: { date_from: "2026-10-01", date_to: "2026-10-02" }, series: [{ kind: "EventsNode", event: "e" }] } } }));
    await setup().execute(request("posthog", "update_insight", { projectId: 1, insightId: 2, description: "Updated" }));
    await setup().execute(request("posthog", "list_insights", { projectId: 1 }));
  });
  it("fails closed on an unavailable registry mapping or multipart boundary collision", async () => {
    const def = EXPANSION_SERVICE_REGISTRY.jira.actions.list_sites;
    const original = def.directApi;
    try {
      def.directApi = undefined;
      await expect(setup().execute(request("jira", "list_sites"))).rejects.toThrow();
    } finally { def.directApi = original; }
    const content = `matrix_${Buffer.from("fixed-boundary").toString("hex")}`;
    const { execute, fetcher } = setup();
    await expect(execute(request("google_drive", "upload_file", { name: "x", content }))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the default fetch transport with a deadline and keeps non-Error failures private", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ results: [] }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const execute = createBoundedManagedAction({ projectId: "proj_1", environment: "production", getAccessToken: async () => "secret" });
      await execute(request("posthog", "list_projects"));
      expect(fetcher).toHaveBeenCalledOnce();
      await expect(setup(vi.fn().mockRejectedValue("private failure")).execute(request("posthog", "list_projects"))).rejects.toThrow("Integration action unavailable");
    } finally { vi.unstubAllGlobals(); }
  });
  it("handles failed cancellation and non-JSON bytes without leaking the provider body", async () => {
    const body = new ReadableStream({ cancel() { throw new Error("private cancel reason"); } });
    await expect(setup(vi.fn().mockResolvedValue(new Response(body, { status: 401 }))).execute(request("posthog", "list_projects"))).rejects.toThrow();
    const malformed = new Uint8Array([0xff]);
    await expect(setup(vi.fn().mockResolvedValue(new Response(malformed))).execute(request("posthog", "list_projects"))).rejects.toThrow();
  });
  it("routes managed execution to the bounded seam before component fallback", async () => {
    const boundedManagedAction = vi.fn().mockResolvedValue({ id: "file_1" });
    const def = GOOGLE_SERVICES.google_drive;
    const result = await executeIntegrationAction({ pipedream: { boundedManagedAction } as any, externalUserId: identity.externalUserId,
      connection: { pipedream_account_id: identity.accountId }, def, actionDef: def.actions.upload_file,
      serviceId: "google_drive", actionId: "upload_file", params: { name: "notes.txt", content: "hello" } });
    expect(result.data).toEqual({ id: "file_1" });
    expect(boundedManagedAction).toHaveBeenCalledWith(request("google_drive", "upload_file", { name: "notes.txt", content: "hello" }));
  });
});

describe("new mappings preserve read-only route authority", () => {
  it("rejects Drive, Jira and PostHog writes before accessing account credentials", async () => {
    const { createIntegrationReadCallRoutes } = await import("../../packages/gateway/src/integrations/read-call.js");
    const listConnectedServices = vi.fn();
    const boundedManagedAction = vi.fn();
    const app = createIntegrationReadCallRoutes({ db: { listConnectedServices } as any, pipedream: { boundedManagedAction } as any, resolveUserId: async () => "owner_1" });
    for (const [service, action] of [["google_drive", "upload_file"], ["jira", "create_issue"], ["jira", "update_issue"], ["jira", "add_comment"], ["posthog", "create_insight"], ["posthog", "update_insight"]]) {
      const response = await app.request("/read-call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service, action, label: "Work", params: {} }) });
      expect(response.status).toBe(403);
    }
    expect(listConnectedServices).not.toHaveBeenCalled();
    expect(boundedManagedAction).not.toHaveBeenCalled();
  });
});

describe("shared bounded service proxy transport", () => {
  it("forwards form bytes and validated tenant headers without changing selected identity", async () => {
    const { createBoundedIntegrationProxy } = await import("../../packages/gateway/src/integrations/bounded-proxy-transport.js");
    const fetcher = vi.fn().mockResolvedValue(json({ id: "cus_1" }));
    const execute = createBoundedIntegrationProxy({ projectId: "proj_1", environment: "production", getAccessToken: async () => "secret", allowedOrigins: ["https://api.stripe.com"], fetcher });
    await execute({ ...identity, url: "https://api.stripe.com/v1/customers", method: "POST", body: "name=Review+example", contentType: "application/x-www-form-urlencoded", tenantId: cloudId });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: "name=Review+example", headers: { "x-pd-proxy-content-type": "application/x-www-form-urlencoded", "x-pd-proxy-xero-tenant-id": cloudId } });
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("account_id")).toBe(identity.accountId);
  });
  it("rejects unapproved origins, URL credentials/fragments, oversized bodies and header injection before token resolution", async () => {
    const { createBoundedIntegrationProxy } = await import("../../packages/gateway/src/integrations/bounded-proxy-transport.js");
    const getAccessToken = vi.fn(async () => "secret");
    const fetcher = vi.fn();
    const execute = createBoundedIntegrationProxy({ projectId: "proj_1", environment: "production", getAccessToken, allowedOrigins: ["https://api.stripe.com"], fetcher });
    const input = { ...identity, url: "https://api.stripe.com/v1/customers", method: "POST" as const };
    for (const override of [{ url: "https://attacker.test" }, { url: "https://api.stripe.com@attacker.test" }, { url: "https://user:secret@api.stripe.com/v1/customers" }, { url: "https://api.stripe.com/v1/customers#secret" }, { body: "x".repeat(65_537) }, { contentType: "application/json\r\nAuthorization: attacker" }, { tenantId: "../tenant" }]) {
      await expect(execute({ ...input, ...override })).rejects.toThrow("Integration action unavailable");
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createBoundedIntegrationProxy({ projectId: "proj_1", environment: "production", getAccessToken, allowedOrigins: ["https://api.stripe.com/v1"] })).toThrow();
  });
});
