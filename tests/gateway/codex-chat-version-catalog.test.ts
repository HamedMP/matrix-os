import { expect, it } from "vitest";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { createAgentCredentialStatusService } from "../../packages/gateway/src/onboarding/agent-credential-status.js";
import { resolveAgentCredentialProbe } from "../../packages/gateway/src/onboarding/agent-credential-probe.js";
import { createCodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";

const principal = { userId: "owner_1", source: "jwt" } as const;

it.each([
  ["0.171.0", "available"],
  ["0.162.1", "available"],
  ["0.168.0", "version_unsupported"],
] as const)("projects the credential and Chat model availability of Codex %s", async (version, status) => {
  const homePath = "/tmp";
  const launcher = createAgentLauncher({
    cwd: homePath,
    runCommand: async (command, args) => {
      if (command !== "codex") throw Object.assign(new Error("CLI missing"), { code: "ENOENT" });
      return { stdout: args[0] === "--version" ? "codex-cli " + version : "Logged in using ChatGPT", stderr: "" };
    },
  });
  const agentCredentials = createAgentCredentialStatusService({
    probeAgent: async (_ownerId, agent) => {
      const { agents } = await launcher.detectAgentCredentials();
      return resolveAgentCredentialProbe(homePath, agent, agents.find(candidate => candidate.id === agent));
    },
  });
  const codingProviders = createCodingAgentProviderRegistry({
    agentCredentials,
    providers: [{ providerId: "codex", getSummary: () => ({
      id: "codex", kind: "codex", displayName: "Codex", availability: "available",
      installStatus: "installed", authStatus: "unknown", defaultModel: "gpt-5.4",
      supportedModes: ["default"], defaultMode: "default", setupActions: [],
    }), healthCheck: () => ({ ok: true }), startThread: () => [] }],
  });
  const catalog = createChatProviderCatalogService({
    codingProviders,
    agentRuntimeSource: async () => ({
      runtime: { selected: "hermes", options: [], transition: null },
      providers: [],
      messaging: { runtime: "hermes", provider: null, model: null, configured: false },
    }),
  });

  const credentials = await agentCredentials.getStatus(principal.userId);
  expect(credentials.agents.find(agent => agent.agent === "codex")?.status).toBe(status);
  const { instances } = await catalog.getCatalog(principal);
  const codex = instances.find(instance => instance.id === "codex_default");
  const availability = status === "available" ? "available" : "unavailable";
  expect(codex).toMatchObject({
    availability, models: status === "available" ? [{ id: "gpt-5.4", availability }] : [],
  });
});
