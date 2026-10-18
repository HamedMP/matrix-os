import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeProviderWorkflowRuntime } from "../../packages/gateway/src/server/native-provider-workflow-runtime";

const fixture = vi.hoisted(() => ({ starts: 0, completion: "succeeded" as "succeeded" | "failed" | "cancelled", timeline: [] as string[] }));
// This independent producer implements the existing public adapter interface.
// It does not copy the unmerged native Codex auth/proof implementation.
vi.mock("../../packages/gateway/src/ai-providers/provider-workflow-native", async original => ({
  ...await original<typeof import("../../packages/gateway/src/ai-providers/provider-workflow-native")>(),
  createNativeProviderWorkflowAdapters: async (options: { onLoginSucceeded?: (harness: "claude" | "codex") => void }) => [{
    harnessInstanceId: "codex_contract", harness: "codex", displayName: "Codex", installState: "installed",
    loginMethods: ["device_code"], apiKeyProviders: [], install: false, uninstall: false,
    start: async ({ publish }: { publish: (update: { state: string; safeFailure: null }) => void }) => {
      fixture.starts++;
      if (fixture.completion === "succeeded") options.onLoginSucceeded?.("codex");
      fixture.timeline.push("publish");
      publish({ state: fixture.completion, safeFailure: null });
      return { cancel: async () => {} };
    },
  }],
}));

afterEach(() => { fixture.starts = 0; fixture.completion = "succeeded"; fixture.timeline = []; });

it.each(["succeeded", "failed", "cancelled"] as const)("binds the fake Codex %s producer to the configured runtime owner", async state => {
  fixture.completion = state;
  const app = new Hono();
  const invalidateNativeLoginCatalog = vi.fn(() => { fixture.timeline.push("evict"); });
  const runtime = await createNativeProviderWorkflowRuntime({ app, homePath: "/synthetic/runtime", ownerId: "configured_owner",
    getPrincipal: () => ({ userId: "configured_owner" }), store: {} as never, terminal: {} as never,
    profileGuard: {} as never, inventory: async () => ({ drivers: [] }), invalidateNativeLoginCatalog });
  try {
    const response = await app.request("/api/ai/provider-settings/workflows", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex_contract", kind: "login", method: "device_code", idempotencyKey: `contract_${state}` }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ harnessInstanceId: "codex_contract", kind: "login", state });
    expect(fixture.starts).toBe(1);
    if (state === "succeeded") {
      expect(invalidateNativeLoginCatalog).toHaveBeenCalledExactlyOnceWith("configured_owner", "codex");
      expect(fixture.timeline).toEqual(["evict", "publish"]);
    } else {
      expect(invalidateNativeLoginCatalog).not.toHaveBeenCalled();
      expect(fixture.timeline).toEqual(["publish"]);
    }
  } finally { await runtime.close(); }
});

it.each([null, "another_owner"])("refuses producer dispatch from a non-owner principal %s", async userId => {
  const app = new Hono(), invalidateNativeLoginCatalog = vi.fn();
  const runtime = await createNativeProviderWorkflowRuntime({ app, homePath: "/synthetic/runtime", ownerId: "configured_owner",
    getPrincipal: () => userId === null ? null : { userId }, store: {} as never, terminal: {} as never,
    profileGuard: {} as never, inventory: async () => ({ drivers: [] }), invalidateNativeLoginCatalog });
  try {
    const response = await app.request("/api/ai/provider-settings/workflows", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex_contract", kind: "login", method: "device_code", idempotencyKey: "foreign_contract" }) });
    expect(response.status).toBe(userId === null ? 401 : 403);
    expect(fixture.starts).toBe(0);
    expect(invalidateNativeLoginCatalog).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
