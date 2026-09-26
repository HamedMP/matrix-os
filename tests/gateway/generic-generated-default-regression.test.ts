import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AiProviderSnapshotV3Schema, type AgentProviderSummary } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createCodexHarnessAdmission } from "../../packages/gateway/src/coding-agents/codex-harness-admission.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentThreadStore, createFakeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const principal = { userId: "owner_user", source: "jwt" as const };
const kinds = ["pi", "opencode"] as const;
function post(body: unknown): Request {
  return new Request("http://localhost/api/coding-agents/threads", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function fixture(kind: typeof kinds[number], reconcile: boolean) {
  const homePath = await mkdtemp(join(tmpdir(), "generated-harness-default-"));
  const canonical = providerSettingsCanonicalFixture();
  const store = new ProviderSettingsStore({
    homePath, providerSnapshotReader: { getSnapshot: async () => AiProviderSnapshotV3Schema.parse(canonical) },
    now: () => PROVIDER_SETTINGS_NOW,
  });
  if (reconcile) await store.getSnapshot();
  canonical.drivers.push({
    id: kind, displayName: kind, kind: "cli", installState: "installed", health: "ready",
    capabilities: ["tools", "resume"], setupActions: [],
  });
  await store.getSnapshot();
  const provider = createFakeCodingAgentProvider({ providerId: kind });
  const summary: AgentProviderSummary = {
    ...provider.getSummary!({ now: () => PROVIDER_SETTINGS_NOW }),
    id: kind, kind, availability: "available", installStatus: "installed", authStatus: "authenticated",
    supportedModes: ["default"], defaultMode: "default", defaultModel: "native:working-model", setupActions: [],
  };
  const catalog = createChatProviderCatalogService({
    codingProviders: { listProviders: async () => [summary], invalidate: () => undefined },
    agentRuntimeSource: async () => { throw new Error("No system runtime in this fixture"); },
    harnessSettingsSource: store, executableDriverKinds: [kind], credentialedDriverKinds: [kind],
    codingModelCatalogSource: async () => ({
      models: [{ id: "native:working-model", displayName: "Working native model", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
      options: [], defaultModel: "native:working-model",
    }),
  });
  const threads = createCodingAgentThreadStore({
    homePath, providers: [provider], providerAdmission: createCodexHarnessAdmission({ homePath }),
    relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined },
  });
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({ threads, turns: threads, getPrincipal: () => principal }));
  return { homePath, store, catalog, app, threads, cleanup: async () => {
    await threads.shutdownTurns();
    await rm(homePath, { recursive: true, force: true });
  } };
}

describe("generated Settings defaults preserve existing native coding routes", () => {
  for (const reconcile of [false, true]) {
    it.each(kinds)(`${reconcile ? "reconciled" : "initial"} generated %s configuration does not disable its working native Chat route`, async (kind) => {
      const f = await fixture(kind, reconcile);
      try {
        const catalog = await f.catalog.getCatalog(principal);
        const instance = catalog.instances.find((entry) => entry.driverKind === kind)!;
        expect(instance).toMatchObject({ availability: "available", models: [{ id: "native:working-model" }] });
        expect(instance.defaultSelection).toBeDefined();
        expect(validateChatProviderSelection({ catalog, selection: instance.defaultSelection! }).ok).toBe(true);
      } finally { await f.cleanup(); }
    });
    it.each(kinds)(`${reconcile ? "reconciled" : "initial"} generated %s configuration does not block a fresh Workspace or Project run`, async (kind) => {
      const f = await fixture(kind, reconcile);
      try {
        for (const projectId of [undefined, "matrix-os"]) {
          const response = await f.app.request(post({
            providerId: kind, prompt: "Inspect", clientRequestId: `req_${kind}_${projectId ?? "workspace"}`, ...(projectId ? { projectId } : {}),
          }));
          expect(response.status).toBe(202);
        }
        const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
        expect(config.harnesses.find((entry: { harness: string }) => entry.harness === kind)).toMatchObject({ enablementOrigin: "generated_default" });
      } finally { await f.cleanup(); }
    });
  }
});
