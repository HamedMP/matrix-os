import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { createManagedCreditOwnerAuthorization } from "../../packages/gateway/src/ai-providers/provider-managed-credit-authorization.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture, providerSettingsFundingSummaryFixture } from "./provider-settings-test-support.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(saved = true, funded = true) {
  const root = await mkdtemp(join(tmpdir(), "managed-credit-")); homes.push(root);
  const funding = providerSettingsFundingSummaryFixture();
  const summary = { ...funding, chatAvailability: { contractVersion: 1 as const, asOf: funding.funding.asOf, eligibleBalanceMicrousd: 900_000, availableBalanceMicrousd: 800_000 } };
  const getFundingSummary = vi.fn(async (options?: { signal?: AbortSignal }) => { void options; return summary; });
  const getSnapshot = vi.fn(async () => providerSettingsCanonicalFixture());
  const native = vi.fn(); const catalog = vi.fn(); const recovery = vi.fn();
  const store = new ProviderSettingsStore({ homePath: join(root, "home"), privateRootPath: join(root, "private"),
    providerSnapshotReader: { getSnapshot }, ...(funded ? { fundingSummaryReader: { getFundingSummary } } : {}), now: () => PROVIDER_SETTINGS_NOW,
    codexNativeAccountMetadataReader: native, genericModelCatalogReader: { getCatalog: catalog } as never,
    runtimeCoordinator: { supportedActions: [], isRecoveryReady: () => false, reconcilePending: recovery, applyConfiguration: vi.fn(), rollbackConfiguration: vi.fn() },
  });
  const config = initialProviderSettingsConfiguration(providerSettingsCanonicalFixture(), undefined, PROVIDER_SETTINGS_NOW);
  if (saved) { await mkdir(dirname(store.configurationPath), { recursive: true }); await writeFile(store.configurationPath, JSON.stringify(config)); }
  return { store, summary, getFundingSummary, getSnapshot, native, catalog, recovery, config };
}

describe("funding-only Settings observations", () => {
  it("reads fresh ledger authority without discovery, native/catalog/recovery or owner writes", async () => {
    const f = await fixture(); const bytes = await readFile(f.store.configurationPath, "utf8");
    const observed = await f.store.getManagedCreditObservation();
    expect(observed).toMatchObject({ contractVersion: 1, revision: 0, gatewayPolicyAccessSourceId: "matrix_included", topUpEnabled: false,
      usage: { kind: "managed_credit", scope: "owner_entitlement", asOf: f.summary.funding.asOf, chatAvailability: f.summary.chatAvailability } });
    expect(f.getFundingSummary).toHaveBeenCalledTimes(1);
    for (const reader of [f.getSnapshot, f.native, f.catalog, f.recovery]) expect(reader).not.toHaveBeenCalled();
    expect(await readFile(f.store.configurationPath, "utf8")).toBe(bytes);
  });
  it("fails without a funding dependency and on invalid saved owner intent", async () => {
    const missing = await fixture(true, false);
    await expect(missing.store.getManagedCreditObservation()).rejects.toMatchObject({ code: "projection_unavailable" });
    expect(missing.getSnapshot).not.toHaveBeenCalled();
    const invalid = await fixture(); await writeFile(invalid.store.configurationPath, "invalid-json");
    await expect(invalid.store.getManagedCreditObservation()).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(invalid.getFundingSummary).not.toHaveBeenCalled();
  });
  it("reports a null saved gateway binding without inventing a source", async () => {
    const f = await fixture(); await writeFile(f.store.configurationPath, JSON.stringify({ ...f.config, gatewayPolicy: null }));
    const observed = await f.store.getManagedCreditObservation();
    expect(observed.gatewayPolicyAccessSourceId).toBeNull(); expect(observed.revision).toBe(f.config.revision);
    expect(f.getSnapshot).not.toHaveBeenCalled();
  });
  it("does not initialize absent configuration or read financial authority for it", async () => {
    const f = await fixture(false);
    await expect(f.store.getManagedCreditObservation()).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(f.getFundingSummary).not.toHaveBeenCalled();
    await expect(readFile(f.store.configurationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects changed saved revision or policy reference while funding waits", async () => {
    for (const change of [{ revision: 1 }, { gatewayPolicy: null }]) {
      const f = await fixture(); let complete!: (value: typeof f.summary) => void;
      f.getFundingSummary.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      const pending = f.store.getManagedCreditObservation();
      await vi.waitFor(() => expect(f.getFundingSummary).toHaveBeenCalled());
      await writeFile(f.store.configurationPath, JSON.stringify({ ...f.config, ...change })); complete(f.summary);
      await expect(pending).rejects.toMatchObject({ code: "projection_unavailable" });
    }
  });
  it("rejects a mutation generation race even when the failed writer leaves revision unchanged", async () => {
    const f = await fixture(); let complete!: (value: typeof f.summary) => void;
    f.getFundingSummary.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = f.store.getManagedCreditObservation();
    await vi.waitFor(() => expect(f.getFundingSummary).toHaveBeenCalled());
    await expect(f.store.setAccountSecret("missing_account", "unused")).rejects.toMatchObject({ code: "not_found" });
    complete(f.summary); await expect(pending).rejects.toMatchObject({ code: "projection_unavailable" });
  });
  it("promptly aborts an injected reader that never settles", async () => {
    const f = await fixture(); f.getFundingSummary.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController(); const pending = f.store.getManagedCreditObservation({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "projection_unavailable" });
    await vi.waitFor(() => expect(f.getFundingSummary).toHaveBeenCalled());
    controller.abort(); await rejected;
  });
  it("applies a hard ten-second deadline even when its injected reader ignores the signal", async () => {
    const deadline = new AbortController(); const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const f = await fixture(); f.getFundingSummary.mockImplementationOnce(() => new Promise(() => {}));
      const pending = f.store.getManagedCreditObservation(); const rejected = expect(pending).rejects.toMatchObject({ code: "projection_unavailable" });
      await vi.waitFor(() => expect(f.getFundingSummary).toHaveBeenCalled());
      expect(timeout).toHaveBeenCalledWith(10_000); deadline.abort(new DOMException("Expired", "TimeoutError")); await rejected;
    } finally { timeout.mockRestore(); }
  });
  it("rejects already cancelled callers before funding begins", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.store.getManagedCreditObservation({ signal: controller.signal })).rejects.toMatchObject({ code: "projection_unavailable" });
    expect(f.getFundingSummary).not.toHaveBeenCalled();
  });
  it("forwards cancellation and rejects even an uncancellable late reader", async () => {
    const f = await fixture(); const controller = new AbortController();
    f.getFundingSummary.mockImplementationOnce(async ({ signal } = {}) => { expect(signal).toBeDefined(); controller.abort(); return f.summary; });
    await expect(f.store.getManagedCreditObservation({ signal: controller.signal })).rejects.toThrow();
  });
  it("preserves legacy missing Chat as unknown and rejects incoherent policy authority", async () => {
    const f = await fixture(); delete (f.summary as Partial<typeof f.summary>).chatAvailability;
    expect((await f.store.getManagedCreditObservation()).usage).not.toHaveProperty("chatAvailability");
    f.summary.policy.checkedAt = "2026-08-30T09:59:00.000Z";
    await expect(f.store.getManagedCreditObservation()).rejects.toMatchObject({ code: "projection_unavailable" });
  });
});

describe("managed-credit route", () => {
  async function route(principal: unknown = { userId: "owner" }, owner: boolean | null = true) {
    const f = await fixture(); const app = createProviderSettingsRoutes({ store: f.store, getPrincipal: () => principal,
      ...(owner === null ? {} : { canReadManagedCredit: () => owner }) }); return { ...f, app };
  }
  it("requires authenticated runtime owner and a trusted authorization dependency", async () => {
    for (const [principal, owner, status] of [[null, true, 401], [{ userId: "guest" }, false, 403], [{ userId: "owner" }, null, 503]] as const) {
      const f = await route(principal, owner); const response = await f.app.request("/provider-settings/managed-credit");
      expect(response.status).toBe(status); expect(f.getFundingSummary).not.toHaveBeenCalled();
    }
  });
  it("rejects all client identity/options query parameters and returns private validated observations", async () => {
    const f = await route();
    for (const query of ["ownerId=other", "refresh=true", "sourceId=matrix_included", "includeCapabilities=true"]) {
      expect((await f.app.request(`/provider-settings/managed-credit?${query}`)).status).toBe(400);
    }
    expect(f.getFundingSummary).not.toHaveBeenCalled();
    const response = await f.app.request("/provider-settings/managed-credit");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ contractVersion: 1, revision: 0 }); expect(f.getSnapshot).not.toHaveBeenCalled();
  });
  it("validates custom writer observations before exposing any response", async () => {
    const f = await route();
    const app = createProviderSettingsRoutes({ store: { getSnapshot: f.getSnapshot as never, mutate: vi.fn(),
      getManagedCreditObservation: vi.fn(async () => ({ ownerSecret: "never exposed" }) as never) }, getPrincipal: () => true, canReadManagedCredit: () => true });
    const response = await app.request("/provider-settings/managed-credit");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("never exposed");
  });
  it("fails safely without optional writer support and never exposes internal reader errors", async () => {
    const f = await route();
    const app = createProviderSettingsRoutes({ store: { getSnapshot: f.getSnapshot as never, mutate: vi.fn() }, getPrincipal: () => true, canReadManagedCredit: () => true });
    expect((await app.request("/provider-settings/managed-credit")).status).toBe(503);
    f.getFundingSummary.mockRejectedValueOnce(new Error("secret /private/provider"));
    const response = await f.app.request("/provider-settings/managed-credit"); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
});

it("mounts the narrow route using trusted runtime owner authority, ignoring spoofed identity headers", async () => {
  const f = await fixture();
  for (const [runtimeOwnerId, userId, status] of [["owner", "owner", 200], ["owner", "guest", 403], [undefined, "owner", 503]] as const) {
    const app = new Hono();
    const principal = () => ({ userId });
    app.route("/api/ai", createProviderSettingsRoutes({ store: f.store, getPrincipal: principal,
      canReadManagedCredit: createManagedCreditOwnerAuthorization(runtimeOwnerId, principal) }));
    const response = await app.request("/api/ai/provider-settings/managed-credit", { headers: { "x-owner-id": "owner", "x-forwarded-user": "owner" } });
    expect(response.status).toBe(status);
  }
  expect(f.getFundingSummary).toHaveBeenCalledTimes(1);
  const mount = await readFile(new URL("../../packages/gateway/src/server/collaboration-chat-routes.ts", import.meta.url), "utf8");
  expect(mount).toContain("canReadManagedCredit: createManagedCreditOwnerAuthorization(options.runtimeOwnerId, requireRequestPrincipal)");
});
