import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely } from "kysely";
import { IntegrationRefreshRepository } from "../../packages/gateway/src/integrations/refresh/repository.js";
import { IntegrationRefreshService } from "../../packages/gateway/src/integrations/refresh/service.js";
import { createIntegrationRefreshRoutes } from "../../packages/gateway/src/integrations/refresh/routes.js";
import { readRefreshWithDeadline } from "../../packages/gateway/src/integrations/refresh/deadline.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
import { GMAIL_SERVICE } from "../../packages/gateway/src/integrations/gmail.js";
import { createBoundedPipedreamGet } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

import { REFRESH_LIMITS } from "../../packages/gateway/src/integrations/refresh/contracts.js";

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

  async function claim(at: Date) {
    const job = await repository.get(owner, binding.appId, binding.sourceId);
    return repository.claim(job!, at);
  }
  async function pages(appId: string, sourceId: string) {
    const job = await repository.get(owner, appId, sourceId);
    return repository.pages(owner, job?.id ?? "00000000-0000-0000-0000-000000000000");
  }

  it("preserves a saved MCP note when a replacement reports isError", async () => {
    const source = { ...binding, service: "granola", action: "get_note", params: { noteId: "note_1" } };
    const saved = { isError: false, content: [{ type: "text", text: "saved note" }] };
    const read = vi.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "upstream failed" }] });
    const service = new IntegrationRefreshService({ repository, authorizeApp: async () => true, authorizeConnection: async () => true, read, clock: () => now });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "complete" });
    expect(await service.refresh(owner, source, { restart: true })).toMatchObject({ status: "backoff", pages: 0, errorCode: "source_unavailable" });
    const current = (await repository.get(owner, source.appId, source.sourceId))!;
    expect(current).toMatchObject({ cursor: null, checkpoint: null, replacing: true });
    expect(await repository.pages(owner, current.id)).toEqual([saved]);
    expect(await db.selectFrom("integration_refresh_pending_pages").selectAll().execute()).toEqual([]);
  });
  it.each([true, false])("settles the exact byte ceiling immediately, continuing cursor=%s", async continuing => {
    let job = await repository.ensure(owner, binding, now);
    const data = { content: "x".repeat(REFRESH_LIMITS.maxPageBytes - Buffer.byteLength(JSON.stringify({ content: "" }))) };
    expect(Buffer.byteLength(JSON.stringify(data))).toBe(REFRESH_LIMITS.maxPageBytes);
    for (let i = 0; i < 4; i++) {
      const lease = (await repository.claim(job, now))!;
      job = await repository.commit(lease, data, i < 3 || continuing ? { pageToken: "next" } : null, null, now);
    }
    expect(job).toMatchObject({ status: continuing ? "exhausted" : "complete", errorCode: continuing ? "budget_exhausted" : null, bytes: REFRESH_LIMITS.maxBytes, calls: 4, pages: 4 });
    expect(await repository.claim(job, now)).toBeNull();
    expect(await repository.pages(owner, job.id)).toEqual([data, data, data, data]);
  });
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
    expect(await pages( binding.appId, binding.sourceId)).toEqual([]);
    expect((await app.request(path, { method: "DELETE", headers: { Authorization: "Bearer owner" } })).status).toBe(200);
  });
  it("atomically claims one lease, reserves a call, and prevents stale commits", async () => {
    await repository.ensure(owner, binding, now);
    const first = (await claim( now))!;
    expect(first.calls).toBe(1);
    expect(await claim( now)).toBeNull();
    const second = (await claim( new Date(now.getTime() + 46000)))!;
    expect(second.calls).toBe(2);
    await expect(repository.commit(first, { files: [{ id: "stale" }] }, null, null, new Date(now.getTime() + 46001))).rejects.toThrow();
    await repository.commit(second, { files: [{ id: "current" }] }, null, null, new Date(now.getTime() + 46002));
    expect(await pages( binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "current" }] }]);
  });
  it.each(["connection", "parameters", "identical", "removed"])("pins claims to the ensured source through a %s delete/recreate race", async change => {
    const originalClaim = repository.claim.bind(repository);
    const read = vi.fn().mockResolvedValue({ files: [{ id: "wrong-source" }] });
    const authorizeConnection = vi.fn().mockResolvedValue(true);
    vi.spyOn(repository, "claim").mockImplementationOnce(async (...args) => {
      await repository.remove(owner, binding.appId, binding.sourceId);
      if (change !== "removed") await repository.ensure(owner, { ...binding,
        ...(change === "connection" ? { connectionId: "connection_2" } : {}),
        ...(change === "parameters" ? { params: { maxResults: 10 } } : {}),
      }, now);
      return originalClaim(...args);
    });
    const service = new IntegrationRefreshService({ repository, authorizeConnection, authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    await expect(service.refresh(owner, binding)).rejects.toMatchObject({ code: "conflict" });
    expect(read).not.toHaveBeenCalled(); expect(authorizeConnection).not.toHaveBeenCalled();
    const replacement = await repository.get(owner, binding.appId, binding.sourceId);
    if (change === "removed") expect(replacement).toBeNull();
    else expect(replacement).toMatchObject({ calls: 0, pages: 0, revision: 0, status: "pending" });
    expect(await pages( binding.appId, binding.sourceId)).toEqual([]);
  });
  it("never returns replacement source pages after authorizing the removed source", async () => {
    const read = vi.fn().mockResolvedValue({ files: [{ id: "old" }] });
    const replacementService = new IntegrationRefreshService({ repository, authorizeConnection: async () => true, authorizeApp: async () => true, read: async () => ({ files: [{ id: "other-account" }] }), clock: () => now });
    await replacementService.refresh(owner, binding);
    const service = new IntegrationRefreshService({ repository, authorizeApp: async () => true, read, clock: () => now,
      authorizeConnection: async () => {
        await repository.remove(owner, binding.appId, binding.sourceId);
        await replacementService.refresh(owner, { ...binding, connectionId: "connection_2" });
        return true;
      },
    });
    const snapshot = await service.snapshot(owner, binding.appId, binding.sourceId, true);
    expect(snapshot).toEqual({ pages: [] });
    expect(JSON.stringify(snapshot)).not.toContain("other-account");
  });

  it("stores one page and next cursor atomically and resumes after repository recreation", async () => {
    await repository.ensure(owner, binding, now);
    const lease = (await claim( now))!;
    await repository.commit(lease, { files: [{ id: "a" }] }, { pageToken: "next" }, null, now);
    const reopened = new IntegrationRefreshRepository(db);
    expect(await reopened.get(owner, binding.appId, binding.sourceId)).toMatchObject({ cursor: { pageToken: "next" }, pages: 1, calls: 1, status: "pending" });
    expect(await reopened.pages(owner, (await reopened.get(owner, binding.appId, binding.sourceId))!.id)).toEqual([{ files: [{ id: "a" }] }]);
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
    expect(await pages( source.appId, source.sourceId)).toEqual([{ threads: [{ id: "first" }], nextPageToken: "next" }, { threads: [{ id: "second" }] }]);
  });
  it.each([2500, 1001, 1000, 25, undefined])("bounds Calendar import pages and resumes through the executor, requested=%s", async requested => {
    const source = { ...binding, sourceId: "calendar_events", service: "google_calendar", action: "list_events", params: { calendarId: "calendar_a", ...(requested === undefined ? {} : { maxResults: requested }) } };
    const targets: URL[] = [];
    const expectedSize = Math.min(requested ?? 50, 1000);
    const proxyGet = vi.fn(async (input: { externalUserId: string; accountId: string; url: string; params?: Record<string, unknown> }) => {
      expect(input).toMatchObject({ externalUserId: owner, accountId: "apn_1" });
      const target = new URL(input.url);
      for (const [key, value] of Object.entries(input.params ?? {})) target.searchParams.set(key, String(value));
      targets.push(target);
      const count = target.searchParams.has("pageToken") ? 1 : Number(target.searchParams.get("maxResults"));
      return { items: Array.from({ length: count }, (_, id) => ({ id: String(id) })), ...(target.searchParams.has("pageToken") ? {} : { nextPageToken: "next" }) };
    });
    const definition = getService("google_calendar")!;
    const service = new IntegrationRefreshService({ repository, authorizeConnection: async () => true, authorizeApp: async () => true, clock: () => now,
      read: async ({ params }) => (await executeIntegrationAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient,
        externalUserId: owner, connection: { pipedream_account_id: "apn_1" }, def: definition,
        actionDef: definition.actions.list_events!, serviceId: "google_calendar", actionId: "list_events", params })).data });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "pending", pages: 1, calls: 1 });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "complete", pages: 2, calls: 2 });
    expect(targets.map(url => url.searchParams.get("maxResults"))).toEqual([String(expectedSize), String(expectedSize)]);
    expect(targets.map(url => url.searchParams.get("pageToken"))).toEqual([null, "next"]);
    expect(targets.every(url => url.pathname.endsWith("/calendar_a/events"))).toBe(true);
    expect((await pages(source.appId, source.sourceId)).map(page => (page as { items: unknown[] }).items.length)).toEqual([expectedSize, 1]);
    expect((await repository.get(owner, source.appId, source.sourceId))!.binding.params).toEqual(source.params);
    expect(proxyGet).toHaveBeenCalledTimes(2);
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
    for (let i = 0; i < 8; i++) await claim( new Date(now.getTime() + i * 46000));
    expect(await claim( new Date(now.getTime() + 8 * 46000))).toBeNull();
    expect(await repository.get(owner, binding.appId, binding.sourceId)).toMatchObject({ status: "exhausted", calls: 8 });
  });
  it("keeps incomplete or malformed pages retryable without moving the saved cursor", async () => {
    const notion = { ...binding, sourceId: "notion", service: "notion", action: "search", params: {} };
    const read = vi.fn().mockResolvedValue({ results: [], has_more: true, next_cursor: null });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    expect(await service.refresh(owner, notion)).toMatchObject({ status: "backoff", pages: 0, calls: 1 });
    expect(await pages( notion.appId, notion.sourceId)).toEqual([]);
  });
  it.each([null, {}, { results: "invalid", has_more: true, next_cursor: "skip" }])("preserves the saved snapshot and cursor when a replacement page is malformed: %j", async malformed => {
    const source = { ...binding, sourceId: "notion_records", service: "notion", action: "search", params: {} };
    const saved = { results: [{ id: "saved" }], has_more: false, next_cursor: null };
    const read = vi.fn().mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({ results: [{ id: "candidate" }], has_more: true, next_cursor: "next" })
      .mockResolvedValueOnce(malformed);
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    await service.refresh(owner, source);
    await service.refresh(owner, source, { restart: true });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "backoff", pages: 1, calls: 2 });
    expect(await repository.get(owner, source.appId, source.sourceId)).toMatchObject({ cursor: { startCursor: "next" }, replacing: true });
    expect(await pages( source.appId, source.sourceId)).toEqual([saved]);
  });
  it("restarts a complete contacts snapshot without reusing its delta watermark", async () => {
    const contacts = { ...binding, sourceId: "contacts", service: "google_contacts", action: "list_contacts", params: { limit: 25 } };
    const read = vi.fn().mockResolvedValueOnce({ connections: [{ resourceName: "people/unchanged" }], nextSyncToken: "watermark" }).mockResolvedValueOnce({ connections: [{ resourceName: "people/unchanged" }], nextSyncToken: "new_watermark" });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    expect(await service.refresh(owner, contacts)).toMatchObject({ status: "complete", pages: 1 });
    await service.refresh(owner, contacts);
    expect(read).toHaveBeenCalledTimes(1);
    await service.refresh(owner, contacts, { restart: true });
    expect(read.mock.calls[1][0].params).toEqual({ limit: 25 });
    expect(await repository.get(owner, contacts.appId, contacts.sourceId)).toMatchObject({ checkpoint: { syncToken: "new_watermark" } });
    expect(await pages( contacts.appId, contacts.sourceId)).toHaveLength(1);
  });
  it.each(["denied", "provider failure"])("keeps the last saved import when restart encounters %s", async failure => {
    const authorizeConnection = vi.fn().mockResolvedValue(true);
    const read = vi.fn().mockResolvedValue({ files: [{ id: "saved" }] });
    const service = new IntegrationRefreshService({ repository, authorizeConnection, authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    await service.refresh(owner, binding);
    if (failure === "denied") authorizeConnection.mockResolvedValue(false);
    else read.mockRejectedValue(new Error("provider unavailable"));
    const restart = service.refresh(owner, binding, { restart: true });
    if (failure === "denied") await expect(restart).rejects.toThrow();
    else expect(await restart).toMatchObject({ status: "backoff" });
    expect(await pages( binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "saved" }] }]);
  });
  it("publishes a replacement atomically only after all pages succeed, preserving it through retry and reopen", async () => {
    let time = now;
    const read = vi.fn().mockResolvedValueOnce({ files: [{ id: "saved" }] })
      .mockResolvedValueOnce({ files: [{ id: "new_a" }], nextPageToken: "second" })
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ files: [{ id: "new_b" }] });
    const options = { repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => time };
    const service = new IntegrationRefreshService(options);
    await service.refresh(owner, binding);
    expect(await service.refresh(owner, binding, { restart: true })).toMatchObject({ status: "pending", pages: 1 });
    expect(await pages( binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "saved" }] }]);
    expect(await service.refresh(owner, binding)).toMatchObject({ status: "backoff", pages: 1 });
    expect(await pages( binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "saved" }] }]);
    time = new Date(now.getTime() + 6000);
    const reopenedRepository = new IntegrationRefreshRepository(db);
    await reopenedRepository.bootstrap();
    const reopened = new IntegrationRefreshService({ ...options, repository: reopenedRepository });
    expect(await reopened.refresh(owner, binding)).toMatchObject({ status: "complete", pages: 2, calls: 3 });
    expect(read.mock.calls[3][0].params).toEqual({ maxResults: 25, pageToken: "second" });
    expect(await pages( binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "new_a" }], nextPageToken: "second" }, { files: [{ id: "new_b" }] }]);
  });
  it("bounds unfinished replacements and deletes their staging pages on restart and source removal", async () => {
    const read = vi.fn().mockResolvedValueOnce({ files: [{ id: "saved" }] }).mockResolvedValue({ files: [{ id: "candidate" }], nextPageToken: "more" });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    await service.refresh(owner, binding);
    await service.refresh(owner, binding, { restart: true });
    for (let i = 0; i < 4; i++) await service.refresh(owner, binding);
    const job = (await repository.get(owner, binding.appId, binding.sourceId))!;
    expect(job).toMatchObject({ status: "exhausted", pages: 5, replacing: true });
    expect(await db.selectFrom("integration_refresh_pending_pages").selectAll().execute()).toHaveLength(5);
    expect(await pages( binding.appId, binding.sourceId)).toEqual([{ files: [{ id: "saved" }] }]);
    await repository.restart(job, now);
    expect(await db.selectFrom("integration_refresh_pending_pages").selectAll().execute()).toEqual([]);
    await service.refresh(owner, binding);
    await service.remove(owner, binding.appId, binding.sourceId);
    expect(await db.selectFrom("integration_refresh_pending_pages").selectAll().execute()).toEqual([]);
    expect(await pages( binding.appId, binding.sourceId)).toEqual([]);
  });
  it("imports the registered Gmail search action through the provider executor", async () => {
    const source = { ...binding, sourceId: "gmail_search", service: "gmail", action: "search", params: { query: "from:example@example.test" } };
    const targets: URL[] = [];
    const proxyGet = vi.fn(async (input: { externalUserId: string; accountId: string; url: string; params?: Record<string, unknown> }) => {
      expect(input).toMatchObject({ externalUserId: owner, accountId: "apn_1" });
      const target = new URL(input.url);
      for (const [key, value] of Object.entries(input.params ?? {})) target.searchParams.set(key, String(value));
      targets.push(target);
      return target.searchParams.get("pageToken") ? { messages: [{ id: "second" }] } : { messages: [{ id: "first" }], nextPageToken: "next" };
    });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), clock: () => now,
      read: async ({ params }) => (await executeIntegrationAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient,
        externalUserId: owner, connection: { pipedream_account_id: "apn_1" }, def: GMAIL_SERVICE,
        actionDef: GMAIL_SERVICE.actions.search, serviceId: "gmail", actionId: "search", params })).data });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "pending", pages: 1 });
    expect(await service.refresh(owner, source)).toMatchObject({ status: "complete", pages: 2 });
    expect(targets.map(url => url.searchParams.get("q"))).toEqual([source.params.query, source.params.query]);
    expect(targets.map(url => url.searchParams.get("pageToken"))).toEqual([null, "next"]);
    expect(proxyGet).toHaveBeenCalledTimes(2);
  });
  it("rejects oversize responses and invalid/credential-bearing next cursors", async () => {
    const read = vi.fn().mockResolvedValue({ files: [{ text: "x".repeat(512 * 1024) }] });
    const service = new IntegrationRefreshService({ repository, authorizeConnection: vi.fn().mockResolvedValue(true), authorizeApp: vi.fn().mockResolvedValue(true), read, clock: () => now });
    expect(await service.refresh(owner, binding)).toMatchObject({ status: "exhausted", pages: 0, calls: 1 });
    expect(await pages( binding.appId, binding.sourceId)).toEqual([]);
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
