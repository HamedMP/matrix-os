import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntimeServices } from "../../packages/gateway/src/agent-config/runtime-services.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { createHermesRuntimeSource } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { createCanonicalNativeHarnessCatalogReader } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";

// Exercise the production dependency choice with real runtime composition.
// The messaging projection intentionally omits native-only profile evidence.
async function productionSource(services: ReturnType<typeof createAgentRuntimeServices>) {
  const server = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
  const binding = server.match(/hermesRuntimeSource:\s*agentRuntimeServices\.(source|systemRuntimeSources\.hermes)\s*,/);
  if (!binding) throw new Error("Production Hermes native source binding is missing");
  return binding[1] === "source" ? services.source : services.systemRuntimeSources.hermes;
}

describe("production Hermes native catalog wiring", () => {
  it.each([true, false])("refreshes cached native credential evidence for each catalog read (authenticated: %s)", async (authenticated) => {
    let clock = 0;
    let currentAuth = true;
    const source = createHermesRuntimeSource(async (path) => path === "/api/status" ? { gateway_running: false } : {
      provider: "openai-codex", model: "gpt-5.6-sol", providers: [{
        slug: "openai-codex", authenticated: currentAuth, is_user_defined: false, models: ["gpt-5.6-sol"],
      }],
    }, { now: () => clock });
    await source(AbortSignal.timeout(1000));
    clock = 4000;
    currentAuth = authenticated;
    const reader = createCanonicalNativeHarnessCatalogReader({
      getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }),
    }, { hermesRuntimeSource: source, now: () => new Date(clock) });
    const catalog = await reader(false);
    if (authenticated) {
      expect(catalog.profiles[0]?.localObservation).toEqual({ state: "present_unverified",
        checkedAt: new Date(4000).toISOString(), staleAfter: new Date(9000).toISOString() });
    } else {
      expect(catalog).toEqual({ profiles: [], failures: ["hermes"] });
    }
  });

  it.each(["copilot", "openai-codex"])("retains Codex evidence with native default %s", async (provider) => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-native-wiring-"));
    const mutateNative = vi.fn();
    const services = createAgentRuntimeServices({ homePath,
      hostControl: {
        status: async () => ({ hermes: { installed: true, running: true }, openclaw: { installed: false, running: false } }),
        switch: mutateNative, stop: mutateNative,
      },
      client: {
        readJson: async (path) => path === "/api/status" ? { gateway_running: false } : {
          provider, model: "gpt-5.6-sol", providers: [
            { slug: "copilot", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] },
            { slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol", "gpt-5.6-luna"] },
          ],
        },
        requestJson: mutateNative,
      },
    });
    const producer = new AiProviderService({ homePath, env: {},
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: await productionSource(services),
    });
    try {
      const snapshot = await producer.getSnapshot({ refresh: true });
      expect(snapshot.nativeHarnessCatalog).toMatchObject({ profiles: [{
        harness: "hermes", providerId: "openai-codex",
        defaultModelId: provider === "openai-codex" ? "openai-codex:gpt-5.6-sol" : null,
        models: expect.arrayContaining([
          { id: "openai-codex:gpt-5.6-sol", displayName: "gpt-5.6-sol", enabled: true },
          { id: "openai-codex:gpt-5.6-luna", displayName: "gpt-5.6-luna", enabled: true },
        ]), localObservation: { state: "present_unverified" },
      }], failures: [] });
      expect(mutateNative).not.toHaveBeenCalled();
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
});
