import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeProviderWorkflowRuntime } from "../../packages/gateway/src/server/native-provider-workflow-runtime";

const fixture = vi.hoisted(() => ({ starts: 0, completion: "succeeded" as "succeeded" | "failed" | "cancelled", timeline: [] as string[] }));
// Keep the production adapter, HTTP workflow service and runtime owner binding real.
// Only the external native connection is synthetic; protocol/child cancellation
// is exercised separately by provider-device-code-cancellation.test.ts.
vi.mock("../../packages/gateway/src/ai-providers/codex-settings-connection", () => ({
  createCodexSettingsConnection: () => ({
    available: async () => true,
    start: async ({ onSuccess, publish, registerCleanup }: {
      onSuccess: (proof: () => Promise<boolean>, current: () => boolean) => Promise<void>;
      publish: (update: { state: string; safeFailure: null }) => void;
      registerCleanup: (cleanup: () => Promise<void>) => void;
    }) => {
      registerCleanup(async () => {});
      fixture.starts++;
      if (fixture.completion === "succeeded") await onSuccess(async () => true, () => true);
      fixture.timeline.push("publish");
      publish({ state: fixture.completion, safeFailure: null });
      return { cancel: async () => {} };
    },
  }),
}));

function storeFixture() {
  const snapshot = { revision: 1, access: { mode: "writable" }, harnesses: [{
    id: "codex_contract", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["terminal"],
  }] };
  return { getSnapshot: vi.fn(async () => snapshot), mutate: vi.fn(),
    completeCodexNativeLogin: vi.fn(async () => { fixture.timeline.push("commit"); return { kind: "snapshot", snapshot }; }) };
}

afterEach(() => { fixture.starts = 0; fixture.completion = "succeeded"; fixture.timeline = []; });

it.each(["succeeded", "failed", "cancelled"] as const)("binds the production Codex %s producer to the configured runtime owner", async state => {
  fixture.completion = state;
  const app = new Hono(), store = storeFixture();
  const invalidateNativeLoginCatalog = vi.fn(() => { fixture.timeline.push("evict"); });
  const runtime = await createNativeProviderWorkflowRuntime({ app, homePath: "/synthetic/runtime", ownerId: "configured_owner",
    getPrincipal: () => ({ userId: "configured_owner" }), store: store as never, terminal: {} as never,
    profileGuard: {} as never, inventory: async () => ({ drivers: [] }), invalidateNativeLoginCatalog });
  try {
    const response = await app.request("/api/ai/provider-settings/workflows", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex_contract", kind: "login", method: "device_code", idempotencyKey: `contract_${state}` }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ harnessInstanceId: "codex_contract", kind: "login", state });
    expect(fixture.starts).toBe(1);
    if (state === "succeeded") {
      expect(invalidateNativeLoginCatalog).toHaveBeenCalledExactlyOnceWith("configured_owner", "codex");
      expect(store.completeCodexNativeLogin).toHaveBeenCalledOnce();
      expect(fixture.timeline).toEqual(["commit", "evict", "publish"]);
    } else {
      expect(invalidateNativeLoginCatalog).not.toHaveBeenCalled();
      expect(store.completeCodexNativeLogin).not.toHaveBeenCalled();
      expect(fixture.timeline).toEqual(["publish"]);
    }
  } finally { await runtime.close(); }
});

it.each([null, "another_owner"])("refuses producer dispatch from a non-owner principal %s", async userId => {
  const app = new Hono(), invalidateNativeLoginCatalog = vi.fn();
  const runtime = await createNativeProviderWorkflowRuntime({ app, homePath: "/synthetic/runtime", ownerId: "configured_owner",
    getPrincipal: () => userId === null ? null : { userId }, store: storeFixture() as never, terminal: {} as never,
    profileGuard: {} as never, inventory: async () => ({ drivers: [] }), invalidateNativeLoginCatalog });
  try {
    const response = await app.request("/api/ai/provider-settings/workflows", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex_contract", kind: "login", method: "device_code", idempotencyKey: "foreign_contract" }) });
    expect(response.status).toBe(userId === null ? 401 : 403);
    expect(fixture.starts).toBe(0);
    expect(invalidateNativeLoginCatalog).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it("does not evict or publish success after the canonical Codex completion rejects", async () => {
  const app = new Hono(), store = storeFixture(), invalidateNativeLoginCatalog = vi.fn();
  store.completeCodexNativeLogin.mockRejectedValueOnce(new Error("synthetic canonical refusal"));
  const runtime = await createNativeProviderWorkflowRuntime({ app, homePath: "/synthetic/runtime", ownerId: "configured_owner",
    getPrincipal: () => ({ userId: "configured_owner" }), store: store as never, terminal: {} as never,
    profileGuard: {} as never, inventory: async () => ({ drivers: [] }), invalidateNativeLoginCatalog });
  try {
    const response = await app.request("/api/ai/provider-settings/workflows", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex_contract", kind: "login", method: "device_code", idempotencyKey: "canonical_refused" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "failed" });
    expect(store.completeCodexNativeLogin).toHaveBeenCalledOnce();
    expect(invalidateNativeLoginCatalog).not.toHaveBeenCalled();
    expect(fixture.timeline).toEqual([]);
  } finally { await runtime.close(); }
});
