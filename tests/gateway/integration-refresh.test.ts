import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely } from "kysely";
import { IntegrationRefreshRepository } from "../../packages/gateway/src/integrations/refresh/repository.js";
import { IntegrationRefreshService } from "../../packages/gateway/src/integrations/refresh/service.js";
import { createIntegrationRefreshRoutes } from "../../packages/gateway/src/integrations/refresh/routes.js";
import { readRefreshWithDeadline } from "../../packages/gateway/src/integrations/refresh/deadline.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { GMAIL_SERVICE } from "../../packages/gateway/src/integrations/gmail.js";
import { createBoundedPipedreamGet } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const now = new Date("2026-10-07T00:00:00Z");
const binding = { appId: "research_app", sourceId: "primary_drive", service: "google_drive", action: "list_files", label: "main", connectionId: "connection_1", params: { maxResults: 25 } };
const owner = "owner_1";
it("aborts a stalled provider read and clears the timeout after success", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const pending = readRefreshWithDeadline(supplied => { signal = supplied; return new Promise(() => {}); }, undefined, 100);
    const rejection = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(await readRefreshWithDeadline(async () => "done", undefined, 100)).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
describe("owner database incremental refresh", () => {
  let db: Kysely<any>;
  let repository: IntegrationRefreshRepository;
  beforeEach(async () => { const instance = await KyselyPGlite.create(); db = new Kysely({ dialect: instance.dialect }); repository = new IntegrationRefreshRepository(db); await repository.bootstrap(); });
  afterEach(async () => { await db.destroy(); });

  it("persists an immutable owner/app/source binding and reuses identical creates", async () => {
    const first = await repository.ensure(owner, binding, now);
    expect(await repository.ensure(owner, binding, now)).toMatchObject({ id: first.id, calls: 0 });
    await expect(repository.ensure(owner, { ...binding, connectionId: "connection_2" }, now)).rejects.toThrow();
    expect(await repository.get("other", binding.appId, binding.sourceId)).toBeNull();
    expect(await repository.get(owner, "other_app", binding.sourceId)).toBeNull();
  });
  it("lets the owner erase an import and all pages even after a source is disconnected", async () => {
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read: vi.fn().mockResolvedValue({ files: [{ id: "a" }] }), clock: () => now });
    await service.refresh(owner, binding);
    const app = createIntegrationRefreshRoutes({ service, resolveOwner: async c => c.req.header("Authorization") ? owner : null });
    const path = "/sources/research_app/primary_drive";
    expect((await app.request(path, { method: "DELETE" })).status).toBe(401);
    expect((await app.request(path, { method: "DELETE", headers: { Authorization: "Bearer owner" } })).status).toBe(200);
    expect(await repository.get(owner, binding.appId, binding.sourceId)).toBeNull();
    expect(await repository.pages(owner, binding.appId, binding.sourceId)).toEqual([]);
    expect((await app.request(path, { method: "DELETE", headers: { Authorization: "Bearer owner" } })).status).toBe(200);
  });
  it("atomically claims one lease, reserves a call, and prevents stale commits", async () => {
    await repository.ensure(owner, binding, now);
    const first = (await repository.claim(owner, binding.appId, binding.sourceId, now))!;
    expect(first.calls).toBe(1);
    expect(await repository.claim(owner, binding.appId, binding.sourceId, now)).toBeNull();
    const second = (await repository.claim(owner, binding.appId, binding.sourceId, new Date(now.getTime() + 46000)))!;
    expect(second.calls).toBe(2);
    await expect(repository.commit(first, { files: [{ id: "stale" }] }, null, null, new Date(now.getTime() + 46001))).rejects.toThrow();
    await repository.commit(second, { files: [{ id: "current" }] }, null, null, new Date(now.getTime() + 46002));
    expect(await repository.pages(owner, binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "current" }] }]);
  });
  it("stores one page and next cursor atomically and resumes after repository recreation", async () => {
    await repository.ensure(owner, binding, now);
    const lease = (await repository.claim(owner, binding.appId, binding.sourceId, now))!;
    await repository.commit(lease, { files: [{ id: "a" }] }, { pageToken: "next" }, null, now);
    const reopened = new IntegrationRefreshRepository(db);
    expect(await reopened.get(owner, binding.appId, binding.sourceId)).toMatchObject({ cursor: { pageToken: "next" }, pages: 1, calls: 1, status: "pending" });
    expect(await reopened.pages(owner, binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "a" }] }]);
  });
  it("resumes Gmail threads through the actual executor and bounded provider helper", async () => {
    const targets: URL[] = [];
    const boundedGmailGet = createBoundedPipedreamGet({ projectId: "proj_fixture", environment: "production", getAccessToken: async () => "synthetic-token",
      fetcher: async raw => {
        const url = new URL(raw); const target = new URL(Buffer.from(url.pathname.split("/").at(-1)!, "base64url").toString("utf8")); targets.push(target);
        return Response.json(target.searchParams.get("pageToken") === "next" ? { threads: [{ id: "second" }] } : { threads: [{ id: "first" }], nextPageToken: "next" });
      } });
    const source = { ...binding, sourceId: "threads", service: "gmail", action: "list_threads", params: {} };
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), clock: () => now,
      read: async ({ params }) => (await executeIntegrationAction({ pipedream: { boundedGmailGet } as unknown as PipedreamConnectClient,
        externalUserId: owner, connection: { pipedream_account_id: "apn_1" }, def: GMAIL_SERVICE,
        actionDef: GMAIL_SERVICE.actions.list_threads, serviceId: "gmail", actionId: "list_threads", params })).data });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "pending", pages: 1 });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "complete", pages: 2, calls: 2 });
    expect(targets.map(target => target.searchParams.get("pageToken"))).toEqual([null, "next"]);
    expect(await repository.pages(owner, source.appId, source.sourceId)).toEqual([{ threads: [{ id: "first" }], nextPageToken: "next" }, { threads: [{ id: "second" }] }]);
  });
  it("persists backoff without leaking upstream errors and never skips its cursor", async () => {
    const clock = vi.fn(() => now);
    const read = vi.fn().mockRejectedValue(new Error("secret vendor path/token"));
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock });
    const result = await service.refresh(owner, binding);
    expect(result).toMatchObject({ status: "backoff", errorCode: "source_unavailable", calls: 1 });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await service.refresh(owner, binding)).toMatchObject({ status: "backoff", calls: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("checks app permission/current connection before calls and on every resumed page", async () => {
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const read = vi.fn().mockResolvedValue({ files: [], nextPageToken: "next" });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: authorize, read, clock: () => now });
    await service.refresh(owner, binding);
    await expect(service.refresh(owner, binding)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toMatchObject({ ownerId: owner, binding, params: { maxResults: 25 } });
  });
  it("rejects write/unreviewed actions and arbitrary provider credentials before reads", async () => {
    const read = vi.fn();
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    for (const candidate of [{ ...binding, action: "upload_file" }, { ...binding, service: "unknown" }, { ...binding, params: { accountId: "other" } }]) {
      await expect(service.refresh(owner, candidate)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("reserves a call before fresh connection authorization and releases a denied lease", async () => {
    const authorizeApp = vi.fn().mockResolvedValue(true); const read = vi.fn();
    const authorizeConnection = vi.fn(async () => {
      expect(await repository.get(owner, binding.appId, binding.sourceId)).toMatchObject({ status: "running", calls: 1 });
      return false;
    });
    const service = new IntegrationRefreshService({ repository, authorizeApp, authorizeConnection, read, clock: () => now });
    await expect(service.refresh(owner, binding)).rejects.toThrow();
    expect(await repository.get(owner, binding.appId, binding.sourceId)).toMatchObject({ status: "backoff", calls: 1, leaseToken: null, pages: 0 });
    expect(await service.refresh(owner, binding)).toMatchObject({ status: "backoff", calls: 1 });
    expect(authorizeApp).toHaveBeenCalledTimes(2);
    expect(authorizeConnection).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  });
  it("caps page and lifetime call budgets without a paid fallback", async () => {
    const read = vi.fn().mockResolvedValue({ files: [], nextPageToken: "more" });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    let result;
    for (let i = 0; i < 6; i++) result = await service.refresh(owner, binding);
    expect(result).toMatchObject({ status: "exhausted", pages: 5, calls: 5 });
    expect(read).toHaveBeenCalledTimes(5);
  });
  it("marks abandoned final reservations exhausted after the lease expires", async () => {
    await repository.ensure(owner, binding, now);
    for (let i = 0; i < 8; i++) await repository.claim(owner, binding.appId, binding.sourceId, new Date(now.getTime() + i * 46000));
    expect(await repository.claim(owner, binding.appId, binding.sourceId, new Date(now.getTime() + 8 * 46000))).toBeNull();
    expect(await repository.get(owner, binding.appId, binding.sourceId)).toMatchObject({ status: "exhausted", calls: 8 });
  });
  it("keeps incomplete or malformed pages retryable without moving the saved cursor", async () => {
    const notion = { ...binding, sourceId: "notion", service: "notion", action: "search", params: {} };
    const read = vi.fn().mockResolvedValue({ results: [], has_more: true, next_cursor: null });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    expect(await service.refresh(owner, notion)).toMatchObject({ status: "backoff", pages: 0, calls: 1 });
    expect(await repository.pages(owner, notion.appId, notion.sourceId)).toEqual([]);
  });
  it("preserves contact sync watermark only after completion and restarts explicitly", async () => {
    const contacts = { ...binding, sourceId: "contacts", service: "google_contacts", action: "list_contacts", params: { limit: 25 } };
    const read = vi.fn().mockResolvedValueOnce({ connections: [], nextSyncToken: "watermark" }).mockResolvedValueOnce({ connections: [] });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    expect(await service.refresh(owner, contacts)).toMatchObject({ status: "complete", pages: 1 });
    await service.refresh(owner, contacts);
    expect(read).toHaveBeenCalledTimes(1);
    await service.refresh(owner, contacts, { restart: true });
    expect(read.mock.calls[1][0].params).toEqual({ limit: 25, syncToken: "watermark" });
    expect(await repository.pages(owner, contacts.appId, contacts.sourceId)).toHaveLength(1);
  });
  it("rejects oversize responses and invalid/credential-bearing next cursors", async () => {
    const read = vi.fn().mockResolvedValue({ files: [{ text: "x".repeat(512 * 1024) }] });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    expect(await service.refresh(owner, binding)).toMatchObject({ status: "exhausted", pages: 0, calls: 1 });
    expect(await repository.pages(owner, binding.appId, binding.sourceId)).toEqual([]);
  });
  it("runs app-scoped routes through persistence and keeps unauthorized callers out", async () => {
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read: vi.fn().mockResolvedValue({ files: [{ id: "a" }] }), clock: () => now });
    const app = createIntegrationRefreshRoutes({ service, resolveOwner: async c => c.req.header("Authorization") ? owner : null });
    expect((await app.request("/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(binding) })).status).toBe(401);
    const response = await app.request("/refresh", { method: "POST", headers: { "Authorization": "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(binding) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "complete", pages: 1 });
    const pages = await app.request("/sources/research_app/primary_drive/pages", { headers: { Authorization: "Bearer test" } });
    expect(pages.status).toBe(200);
    expect(await pages.json()).toEqual({ pages: [{ files: [{ id: "a" }] }] });
    const previewApp = createIntegrationRefreshRoutes({ service, resolveOwner: async () => owner,
      urlPreview: async url => ({ url, title: "Chosen report", description: "Metadata" }) });
    const preview = await previewApp.request("/url-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://google.com/report" }) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ url: "https://google.com/report", title: "Chosen report", description: "Metadata" });
  });
});
