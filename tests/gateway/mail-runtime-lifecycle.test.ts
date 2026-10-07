import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createMailWorker } from "../../packages/gateway/src/mail/worker.js";
import type { createMailService } from "../../packages/gateway/src/mail/service.js";
import type { MailSource } from "../../packages/gateway/src/mail/types.js";
import {
  markAuthContextReady,
  setPlatformVerifiedPrincipal,
} from "../../packages/gateway/src/request-principal.js";

const harness = vi.hoisted(() => ({
  repository: {
    bootstrap: vi.fn(),
    listGrantedSources: vi.fn(),
    getSyncJob: vi.fn(),
    enqueueSync: vi.fn(),
    collectObject: vi.fn(),
    pruneExpiredObjectLeases: vi.fn(),
    destroy: vi.fn(),
  },
  objects: { sweep: vi.fn(), destroy: vi.fn() },
  transport: { inventory: vi.fn(), call: vi.fn() },
  manifest: vi.fn(),
  worker: vi.fn(),
  service: vi.fn(),
  sync: vi.fn(),
  ready: vi.fn(),
  sharedDestroy: vi.fn(),
}));
vi.mock("../../packages/gateway/src/mail/repository.js", () => ({
  MailArchiveRepository: vi.fn(function () {
    return harness.repository;
  }),
}));
vi.mock("../../packages/gateway/src/mail/objects.js", () => ({
  MailObjectStore: vi.fn(function () {
    return harness.objects;
  }),
}));
vi.mock("../../packages/gateway/src/mail/transport.js", () => ({
  createMailTransport: () => harness.transport,
}));
vi.mock("../../packages/gateway/src/mail/worker.js", () => ({
  createMailWorker: harness.worker,
}));
vi.mock("../../packages/gateway/src/mail/service.js", () => ({
  createMailService: harness.service,
}));
vi.mock("../../packages/gateway/src/app-gallery/pinned-directory.js", () => ({
  readLimited: harness.manifest,
}));
vi.mock("../../packages/gateway/src/funded-ai-readiness.js", () => ({
  createFundedAiReadinessReader: () => ({ read: harness.ready }),
}));
import { createMailRuntime } from "../../packages/gateway/src/mail/runtime.js";
import { JEV_MODEL_ID } from "@matrix-os/contracts";

type Runtime = Awaited<ReturnType<typeof createMailRuntime>>;
const source: MailSource = {
  ownerId: "owner",
  accountId: "account",
  provider: "gmail",
  connectionId: "connection",
  email: "reader@example.test",
  accountLabel: "Personal",
  group: "personal",
  namespace: "a".repeat(64),
  quotaBytes: 1024,
  usedBytes: 0,
  cursor: null,
  revision: 0,
};
const connection = {
  id: source.connectionId,
  service: "gmail",
  account_email: source.email,
  account_label: source.accountLabel,
  status: "active",
};
let worker: Parameters<typeof createMailWorker>[0];
let service: Parameters<typeof createMailService>[0];
let runtimes: Runtime[];

async function create(
  overrides: Partial<Parameters<typeof createMailRuntime>[0]> = {},
) {
  const runtime = await createMailRuntime({
    homePath: "/fictional-owner",
    ownerId: "owner",
    ownerIds: ["owner", "clerk-owner"],
    db: { destroy: harness.sharedDestroy } as never,
    internalBaseUrl: null,
    jev: null,
    notify: vi.fn(),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}
async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  vi.clearAllMocks();
  runtimes = [];
  harness.manifest.mockResolvedValue(
    Buffer.from(
      JSON.stringify({ slug: "edition", listingTrust: "first_party" }),
    ),
  );
  harness.repository.bootstrap.mockResolvedValue(undefined);
  harness.repository.listGrantedSources.mockResolvedValue([source]);
  harness.repository.getSyncJob.mockResolvedValue(null);
  harness.repository.pruneExpiredObjectLeases.mockResolvedValue(0);
  harness.repository.destroy.mockResolvedValue(undefined);
  harness.objects.sweep.mockResolvedValue(0);
  harness.objects.destroy.mockResolvedValue(undefined);
  harness.transport.inventory.mockResolvedValue([connection]);
  harness.sync.mockResolvedValue({ state: "completed" });
  harness.worker.mockImplementation((options) => {
    worker = options;
    return { sync: harness.sync };
  });
  harness.service.mockImplementation((options) => {
    service = options;
    return { handle: async () => ({ sources: [] }) };
  });
  harness.ready.mockResolvedValue({
    readiness: { state: "ready" },
    allowedModelIds: [JEV_MODEL_ID],
  });
});
afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  vi.useRealTimers();
});

describe("production mail runtime composition", () => {
  it("authorizes agent reads from owner aliases and installed consumers without allowing mutations", async () => {
    const runtime = await create();
    const signal = new AbortController().signal;
    await expect(runtime.read("clerk-owner", { appId: "edition", action: "sources", payload: {} }, signal)).resolves.toEqual({ sources: [] });
    await expect(runtime.read("someone-else", { appId: "edition", action: "sources", payload: {} }, signal)).rejects.toMatchObject({ status: 403 });
    await expect(runtime.read("owner", { appId: "edition", action: "sync", payload: { sourceId: "account" } } as never, signal)).rejects.toMatchObject({ status: 400 });
    harness.manifest.mockResolvedValueOnce(Buffer.from(JSON.stringify({ slug: "edition", listingTrust: "community" })));
    await expect(runtime.read("owner", { appId: "edition", action: "sources", payload: {} }, signal)).rejects.toMatchObject({ status: 403 });
  });
  it("coalesces asynchronous requests and stops interval dispatch after close", async () => {
    const runtime = await create();
    await flush();
    expect(harness.sync).not.toHaveBeenCalled();
    harness.repository.getSyncJob.mockResolvedValue({
      status: "pending",
      checkpoint: null,
    });
    service.sync(source);
    service.sync(source);
    expect(harness.sync).not.toHaveBeenCalled();
    await flush();
    expect(harness.sync).toHaveBeenCalledOnce();
    expect(harness.sync.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    harness.repository.getSyncJob.mockResolvedValue({
      status: "completed",
      checkpoint: { completedAt: new Date().toISOString() },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sync).toHaveBeenCalledOnce();
    await runtime.close();
    service.sync(source);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(harness.sync).toHaveBeenCalledOnce();
    expect(harness.sharedDestroy).not.toHaveBeenCalled();
  });
  it("checks installation, current grant, live binding and cancellation before worker authorization", async () => {
    await create();
    await flush();
    const signal = new AbortController().signal;
    await expect(worker.authorize(source, signal)).resolves.toBeUndefined();
    harness.manifest.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({ slug: "edition", listingTrust: "community" }),
      ),
    );
    await expect(worker.authorize(source, signal)).rejects.toMatchObject({
      status: 403,
    });
    harness.repository.listGrantedSources.mockResolvedValueOnce([]);
    await expect(worker.authorize(source, signal)).rejects.toMatchObject({
      status: 403,
    });
    harness.repository.listGrantedSources.mockResolvedValueOnce([
      { ...source, connectionId: "rebound" },
    ]);
    await expect(worker.authorize(source, signal)).rejects.toMatchObject({
      status: 403,
    });
    harness.transport.inventory.mockResolvedValueOnce([
      { ...connection, account_email: "other@example.test" },
    ]);
    await expect(worker.authorize(source, signal)).rejects.toMatchObject({
      status: 403,
    });
    harness.transport.inventory.mockResolvedValueOnce([
      { ...connection, status: "revoked" },
    ]);
    await expect(worker.authorize(source, signal)).rejects.toMatchObject({
      status: 403,
    });
    const cancelled = new AbortController();
    cancelled.abort();
    const calls = harness.transport.inventory.mock.calls.length;
    await expect(worker.authorize(source, cancelled.signal)).rejects.toThrow();
    expect(harness.transport.inventory.mock.calls).toHaveLength(calls);
  });
  it("routes owner principals and denies another owner or an uninstalled consumer", async () => {
    const runtime = await create();
    await flush();
    let principal = "clerk-owner";
    const app = new Hono();
    app.use("*", async (c, next) => {
      markAuthContextReady(c);
      setPlatformVerifiedPrincipal(c, principal);
      await next();
    });
    app.route("/api/mail", runtime.routes);
    const request = () =>
      app.request("/api/mail/action", {
        method: "POST",
        body: JSON.stringify({
          appId: "edition",
          action: "sources",
          payload: {},
        }),
      });
    expect((await request()).status).toBe(200);
    principal = "stranger";
    expect((await request()).status).toBe(403);
    principal = "owner";
    harness.manifest.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({ slug: "edition", listingTrust: "community" }),
      ),
    );
    expect((await request()).status).toBe(403);
  });
  it("requires funded readiness for the exact JeV route and maps the funding owner", async () => {
    const evaluate = vi.fn(async () => ({ result: "classified" }));
    await create({
      jev: { evaluate } as never,
      fundedOwnerId: "billing-owner",
      summary: {} as never,
      routes: {} as never,
    });
    await flush();
    const signal = new AbortController().signal;
    expect(await worker.fundedReady(source, signal)).toBe(true);
    harness.ready.mockResolvedValueOnce({
      readiness: { state: "unavailable" },
      allowedModelIds: [JEV_MODEL_ID],
    });
    expect(await worker.fundedReady(source, signal)).toBe(false);
    harness.ready.mockResolvedValueOnce({
      readiness: { state: "ready" },
      allowedModelIds: ["another-model"],
    });
    expect(await worker.fundedReady(source, signal)).toBe(false);
    const input = { purpose: "email-triage" };
    await worker.jev!.evaluate("owner", input as never, signal);
    expect(evaluate).toHaveBeenCalledWith("billing-owner", input, signal);
    await create();
    await flush();
    expect(await worker.fundedReady(source, signal)).toBe(false);
    expect(worker.jev).toBeNull();
  });
  it("aborts active sync and drains it before destroying runtime resources", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    harness.repository.getSyncJob.mockResolvedValue({
      status: "pending",
      checkpoint: null,
    });
    harness.sync.mockImplementation((_source, incoming) => {
      signal = incoming;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const runtime = await create();
    await flush();
    expect(finish).toBeTypeOf("function");
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await flush();
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(harness.objects.destroy).not.toHaveBeenCalled();
    expect(harness.repository.destroy).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(harness.objects.destroy).toHaveBeenCalledOnce();
    expect(harness.repository.destroy).toHaveBeenCalledOnce();
    expect(harness.sharedDestroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(harness.sync).toHaveBeenCalledOnce();
  });
});
