import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema, ProviderSettingsSnapshotSchema, type MatrixAnthropicConnection } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { withMatrixAnthropicProviderInstances } from "../../packages/gateway/src/bots/matrix-anthropic-provider-instance.js";
import { createMatrixAnthropicConnectionRoutes } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection-routes.js";
import { createAiProviderRoutes } from "../../packages/gateway/src/ai-providers/routes.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW } from "./provider-settings-test-support.js";
import type { MatrixAnthropicConnectionService } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";

const connection: MatrixAnthropicConnection = {
  connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key",
  revision: 3, enabled: true, credentialGeneration: "e16625fe-cad7-4983-a9db-e808bbf104cc",
  sourceCredentialGeneration: "e16625fe-cad7-4983-a9db-e808bbf104cc", state: "ready",
  models: [{ id: "claude-observed", displayName: "Observed Claude" }], actions: ["connect", "refresh", "disconnect"],
  checkedAt: "2026-08-30T10:00:00.000Z", staleAfter: "2026-08-30T10:05:00.000Z", supports: { rootChat: true, recipeBots: true },
};
const canonical = () => ({ ...providerSettingsCanonicalFixture(), matrixAnthropicConnection: connection });

it("accepts optional strict Matrix authority in V3 and copies it to Settings without native source substitution", async () => {
  const snapshot = AiProviderSnapshotV3Schema.parse(canonical());
  const settings = await projectProviderSettings({ canonical: snapshot, config: initialProviderSettingsConfiguration(snapshot, undefined, PROVIDER_SETTINGS_NOW),
    now: PROVIDER_SETTINGS_NOW, supportedActions: [] });
  expect(settings.matrixAnthropicConnection).toEqual(connection);
  expect(ProviderSettingsSnapshotSchema.parse(settings).matrixAnthropicConnection).toEqual(connection);
  expect(AiProviderSnapshotV3Schema.safeParse(providerSettingsCanonicalFixture()).success).toBe(true);
  expect(AiProviderSnapshotV3Schema.safeParse({ ...canonical(), matrixAnthropicConnection: { ...connection, apiKey: "synthetic-secret" } }).success).toBe(false);
  expect(AiProviderSnapshotV3Schema.safeParse({ ...canonical(), matrixAnthropicConnection: { ...connection, sourceCredentialGeneration: null } }).success).toBe(false);
});

it("reads actual saved Matrix observation into V3 on ordinary and scoped reads without probing", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-v3-"));
  const observation = vi.fn(async () => connection), healthProbe = vi.fn();
  const service = new AiProviderService({ homePath, env: {}, now: () => PROVIDER_SETTINGS_NOW,
    matrixAnthropicConnection: observation, healthProbe });
  try {
    expect((await service.getSnapshot()).matrixAnthropicConnection).toEqual(connection);
    expect((await service.getSnapshot({ admissionScope: "managed_matrix" })).matrixAnthropicConnection).toEqual(connection);
    expect(observation).toHaveBeenCalledTimes(2);
    expect(healthProbe).not.toHaveBeenCalled();
  } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
});

it("projects catalog models from the V3 field and fences another owner before snapshot reads", async () => {
  const base = { getCatalog: vi.fn(async () => ({ revision: "base", drivers: [], instances: [] })) };
  const reader = { getSnapshot: vi.fn(async () => canonical()) };
  const catalog = withMatrixAnthropicProviderInstances(base, reader, () => true, "owner");
  const result = await catalog.getCatalog({ userId: "owner", source: "jwt" });
  expect(result.instances.find(instance => instance.id === "matrix_pi_anthropic_api")?.models[0]?.id).toBe("claude-observed");
  expect(reader.getSnapshot).toHaveBeenCalledTimes(1);
  expect((await catalog.getCatalog({ userId: "other", source: "jwt" })).instances).toEqual([]);
  expect(reader.getSnapshot).toHaveBeenCalledTimes(1);
});

it("does not advertise a Matrix API source absent from the canonical V3 snapshot", async () => {
  const base = { getCatalog: async () => ({ revision: "base", drivers: [], instances: [] }) };
  const catalog = withMatrixAnthropicProviderInstances(base, { getSnapshot: async () => providerSettingsCanonicalFixture() }, () => true, "owner");
  expect(await catalog.getCatalog({ userId: "owner", source: "jwt" })).toEqual(await base.getCatalog());
});

it("returns canonical V3 receipts after mutation rather than raw service receipt readiness", async () => {
  const observe = vi.fn(async () => connection), connect = vi.fn(async () => ({ ...connection, revision: 4 }));
  const service = { observe, connect } as unknown as MatrixAnthropicConnectionService;
  const projected = { ...connection, state: "refresh_required" as const, models: [] };
  const reader = { getSnapshot: vi.fn(async () => ({ ...canonical(), matrixAnthropicConnection: projected })) };
  const app = createMatrixAnthropicConnectionRoutes({ ownerId: "owner", service, providerSnapshotReader: reader,
    getPrincipal: () => ({ userId: "owner" }) });
  expect(await (await app.request("/matrix-connections/anthropic")).json()).toEqual(projected);
  expect(observe).not.toHaveBeenCalled();
  const response = await app.request("/matrix-connections/anthropic/connect", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-synthetic-only", expectedRevision: 3, expectedCredentialGeneration: connection.credentialGeneration, idempotencyKey: "connect1" }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual(projected);
  expect(connect).toHaveBeenCalledOnce(); expect(reader.getSnapshot).toHaveBeenCalledTimes(2);
});

it("negotiates the owner-only canonical field without changing legacy V3 wire responses", async () => {
  const service = { getSnapshot: async () => canonical() };
  let owner = true;
  const app = createAiProviderRoutes({ service, getPrincipal: () => ({ userId: owner ? "owner" : "other" }), canReadMatrixConnections: () => owner });
  expect(await (await app.request("/providers")).json()).not.toHaveProperty("matrixAnthropicConnection");
  expect(await (await app.request("/providers?includeMatrixAnthropicConnection=true")).json()).toHaveProperty("matrixAnthropicConnection", connection);
  owner = false;
  expect(await (await app.request("/providers?includeMatrixAnthropicConnection=true")).json()).not.toHaveProperty("matrixAnthropicConnection");
  expect((await app.request("/providers?includeMatrixAnthropicConnection=yes")).status).toBe(400);
});

it("negotiates canonical Settings state for its owner and strips it from legacy and shared-Computer reads", async () => {
  const snapshot = AiProviderSnapshotV3Schema.parse(canonical());
  const settings = await projectProviderSettings({ canonical: snapshot, config: initialProviderSettingsConfiguration(snapshot),
    now: PROVIDER_SETTINGS_NOW, supportedActions: [] });
  let owner = true;
  const app = createProviderSettingsRoutes({ store: { getSnapshot: async () => settings,
    mutate: async () => ({ kind: "snapshot", snapshot: settings }) },
    getPrincipal: () => ({ userId: owner ? "owner" : "other" }), canReadNativeAccountMetadata: () => owner });
  expect(await (await app.request("/provider-settings")).json()).not.toHaveProperty("matrixAnthropicConnection");
  const response = await app.request("/provider-settings?includeMatrixAnthropicConnection=true");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toHaveProperty("matrixAnthropicConnection", connection);
  owner = false;
  expect(await (await app.request("/provider-settings?includeMatrixAnthropicConnection=true")).json()).not.toHaveProperty("matrixAnthropicConnection");
  expect((await app.request("/provider-settings?includeMatrixAnthropicConnection=yes")).status).toBe(400);
});

it("fails closed without a canonical reader or source instead of falling back to direct authority", async () => {
  const observe = vi.fn(async () => connection);
  for (const providerSnapshotReader of [undefined, { getSnapshot: async () => providerSettingsCanonicalFixture() }]) {
    const app = createMatrixAnthropicConnectionRoutes({ ownerId: "owner", service: { observe } as unknown as MatrixAnthropicConnectionService,
      providerSnapshotReader, getPrincipal: () => ({ userId: "owner" }) });
    expect((await app.request("/matrix-connections/anthropic")).status).toBe(503);
  }
  expect(observe).not.toHaveBeenCalled();
});
