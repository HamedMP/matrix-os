import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { GallerySyncRepository } from "../../packages/gateway/src/app-gallery/sync-repository.js";
import { GallerySyncService } from "../../packages/gateway/src/app-gallery/sync-service.js";
import catalog from "../../home/system/app-gallery.json";
import type { KernelEvent } from "../../packages/kernel/src/kernel.js";

const owner = "owner_1";
const account = { service: "gmail", label: "Work", connectionId: "gmail_work", expectedEmail: "work@example.test" };
const input = { requestId: "d38f91fb-8ac6-421d-9476-7451e3137321", accounts: [account], start: "2026-10-01", end: "2026-10-18", context: "", scope: "work" as const, keepUpdated: true };
describe("tracked Gallery sync", () => {
  let db: Kysely<any>, repository: GallerySyncRepository, service: GallerySyncService;
  let clock: Date;
  let onDispatch: (message: string, event: (event: KernelEvent) => void | Promise<void>) => Promise<void>;
  const inventory = vi.fn(), readRecords = vi.fn(), installed = vi.fn();
  beforeEach(async () => {
    db = new Kysely({ dialect: (await createTestPGlite()).dialect });
    repository = new GallerySyncRepository(db);
    await repository.bootstrap();
    clock = new Date("2026-10-19T00:00:00Z");
    inventory.mockResolvedValue([{ ...account, email: account.expectedEmail }]);
    readRecords.mockResolvedValue({ added: 0, updated: 0 });
    installed.mockResolvedValue(true);
    onDispatch = async (_message, event) => {
      await event({ type: "init", sessionId: "session_1" });
      await event({ type: "result", data: { sessionId: "session_1", cost: 0, turns: 1, tokensIn: 0, tokensOut: 0, result: JSON.stringify({ galleryImport: "complete", skipped: 0 }) } });
    };
    service = new GallerySyncService({ repository, catalog: async () => catalog.apps, installed, inventory,
      records: readRecords, clock: () => clock,
      dispatch: async (message, _session, event) => onDispatch(message, event),
    });
  });
  afterEach(async () => { await service.close(); await db.destroy(); vi.clearAllMocks(); });
  it("durably queues a selected-account import, and repeated submissions are idempotent", async () => {
    const first = await service.start(owner, "people", input);
    expect(first.status).toBe("queued");
    expect(await service.start(owner, "people", input)).toEqual(first);
    expect((await repository.get(owner, "people"))?.selection.accounts).toEqual([account]);
    expect(await service.status("another_owner", "people")).toBeNull();
  });
  it("reports actual per-account execution, verifies saved records, and schedules a refresh", async () => {
    await service.start(owner, "subscriptions", input);
    readRecords.mockResolvedValue({ added: 3, updated: 1 });
    onDispatch = async (message, event) => {
      expect(message).toContain('"connectionId":"gmail_work"');
      expect(message).toContain('"expectedEmail":"work@example.test"');
      expect(message).toContain("/api/integrations/read-call");
      expect(message).toContain("importRunId");
      await event({ type: "init", sessionId: "session_1" });
      const snapshot = await service.status(owner, "subscriptions");
      expect(snapshot).toMatchObject({ status: "running", sources: [{ status: "running", label: "Work" }] });
      await event({ type: "result", data: { sessionId: "session_1", cost: 0, turns: 1, tokensIn: 0, tokensOut: 0, result: '{"galleryImport":"complete","skipped":0}' } });
    };
    await service.tick();
    expect(await service.status(owner, "subscriptions")).toMatchObject({ status: "complete", added: 3, updated: 1, keepUpdated: true, lastCheckedAt: clock.toISOString(), nextCheckAt: "2026-10-19T00:01:00.000Z" });
    expect(readRecords).toHaveBeenCalledWith("subscriptions", expect.any(String), expect.any(Date));
  });
  it("checks for new records with an overlapping incremental date range, never the old end date", async () => {
    await service.start(owner, "people", input);
    await service.tick();
    clock = new Date("2026-10-20T00:00:00Z");
    const messages: string[] = [];
    const complete = onDispatch;
    onDispatch = async (message, event) => { messages.push(message); await complete(message, event); };
    await service.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('"start":"2026-10-18","end":"2026-10-20"');
  });
  it("does not claim success for an assistant question or a failed result", async () => {
    await service.start(owner, "people", input);
    onDispatch = async (_message, event) => { await event({ type: "result", data: { sessionId: "s", cost: 0, turns: 1, tokensIn: 0, tokensOut: 0, result: "Please approve this import." } }); };
    await service.tick();
    expect(await service.status(owner, "people")).toMatchObject({ status: "failed", error: "import_incomplete", nextCheckAt: null });
  });
  it("exposes partial coverage and stops automatic retries until the owner retries", async () => {
    await service.start(owner, "people", input);
    onDispatch = async (_message, event) => { await event({ type: "result", data: { sessionId: "s", cost: 0, turns: 1, tokensIn: 0, tokensOut: 0, result: '{"galleryImport":"partial","skipped":2}' } }); };
    await service.tick();
    expect(await service.status(owner, "people")).toMatchObject({ status: "partial", skipped: 2, lastCheckedAt: null, nextCheckAt: null });
    const next = vi.fn(); onDispatch = next;
    clock = new Date("2026-10-20T00:00:00Z"); await service.tick();
    expect(next).not.toHaveBeenCalled();
  });
  it("reports records already saved when a later account fails", async () => {
    const other = { ...account, label: "Personal", connectionId: "gmail_personal", expectedEmail: "personal@example.test" };
    inventory.mockResolvedValue([account, other].map(a => ({ ...a, email: a.expectedEmail })));
    await service.start(owner, "people", { ...input, accounts: [account, other] });
    let calls = 0; const complete = onDispatch;
    onDispatch = async (message, event) => { if (++calls === 2) throw new Error("Provider unavailable"); await complete(message, event); };
    readRecords.mockResolvedValue({ added: 3, updated: 1 });
    await service.tick();
    expect(await service.status(owner, "people")).toMatchObject({ status: "failed", error: "unavailable", added: 3, updated: 1, nextCheckAt: null });
  });
  it("retains the original import failure when saved-count verification is unavailable", async () => {
    await service.start(owner, "people", input);
    inventory.mockResolvedValue([]); readRecords.mockRejectedValue(new Error("Database unavailable"));
    await service.tick();
    expect(readRecords).toHaveBeenCalledOnce();
    expect(await service.status(owner, "people")).toMatchObject({ status: "failed", error: "connection_changed", nextCheckAt: null });
  });
  it("rejects account replacement, ambiguous labels, unsupported sources and missing installations", async () => {
    inventory.mockResolvedValue([{ ...account, connectionId: "replacement", email: account.expectedEmail }]);
    await expect(service.start(owner, "people", input)).rejects.toThrow();
    inventory.mockResolvedValue([{ ...account, email: account.expectedEmail }, { ...account, connectionId: "other", email: account.expectedEmail }]);
    await expect(service.start(owner, "people", input)).rejects.toThrow();
    inventory.mockResolvedValue([{ ...account, email: account.expectedEmail }]);
    await expect(service.start(owner, "people", { ...input, accounts: [{ ...account, service: "stripe" }] })).rejects.toThrow();
    installed.mockResolvedValue(false);
    await expect(service.start(owner, "people", input)).rejects.toThrow();
    expect(await repository.get(owner, "people")).toBeNull();
  });
  it("revalidates the exact connection before every account run and stops a revoked grant", async () => {
    await service.start(owner, "people", input);
    inventory.mockResolvedValue([]);
    const dispatch = vi.fn(); onDispatch = dispatch;
    await service.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await service.status(owner, "people")).toMatchObject({ status: "failed", error: "connection_changed", nextCheckAt: null });
  });
  it("never overlaps manual retries or multiple workers for the same import", async () => {
    const queued = await service.start(owner, "people", input);
    const claims = await Promise.all([repository.claim(clock), repository.claim(clock)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(service.start(owner, "people", { ...input, requestId: crypto.randomUUID() })).rejects.toThrow();
    expect((await service.status(owner, "people"))?.runId).toBe(queued.runId);
  });
  it("marks an interrupted run as failed instead of silently replaying AI work", async () => {
    await service.start(owner, "people", input); const lease = (await repository.claim(clock))!;
    await repository.progress(lease, { sources: lease.snapshot.sources.map(s => ({ ...s, status: "running" })) }, clock);
    clock = new Date(clock.getTime() + 20 * 60 * 1000);
    await service.tick();
    expect(await service.status(owner, "people")).toMatchObject({ status: "failed", error: "interrupted", nextCheckAt: null, sources: [{ status: "failed" }] });
  });
  it("pauses updates durably and fences late worker writes", async () => {
    await service.start(owner, "people", input);
    const lease = (await repository.claim(clock))!;
    await service.pause(owner, "people");
    expect(await repository.progress(lease, { stage: "verifying" }, clock)).toBe(false);
    expect(await service.status(owner, "people")).toMatchObject({ status: "paused", keepUpdated: false, nextCheckAt: null });
    await service.tick();
    expect(await service.status(owner, "people")).toMatchObject({ status: "paused" });
  });
  it("checks mailbox changes without repeating AI work when nothing arrived, then imports new mail", async () => {
    const probe = vi.fn().mockResolvedValue({ gmail_work: "100" });
    service.options.probe = probe;
    const run = vi.fn(onDispatch); onDispatch = run;
    await service.start(owner, "people", input); await service.tick();
    expect(run).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + 60_000); await service.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await service.status(owner, "people")).toMatchObject({ status: "complete", lastCheckedAt: clock.toISOString() });
    probe.mockResolvedValue({ gmail_work: "101" });
    clock = new Date(clock.getTime() + 60_000); await service.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
