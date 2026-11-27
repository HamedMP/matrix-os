import { describe, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION, type AgentProviderSummary } from "@matrix-os/contracts";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createCodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import { createAgentCredentialStatusService } from "../../packages/gateway/src/onboarding/agent-credential-status.js";
import { resolveAgentCredentialProbe } from "../../packages/gateway/src/onboarding/agent-credential-probe.js";

const principal = { userId: "owner_selected_discovery", source: "jwt" as const };

function fixture() {
  const commands: string[] = [];
  const summaries: string[] = [];
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    commands.push(`${command}:${args.join(" ")}`);
    if (args[0] === "--version") return {
      stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
      stderr: "",
    };
    return { stdout: command === "codex" ? "Logged in using ChatGPT\n" : "ok\n", stderr: "" };
  });
  const launcher = createAgentLauncher({ runCommand });
  const credentials = createAgentCredentialStatusService({
    probeAgent: async (_ownerId, agent) => {
      // Exercise the native command boundary as well as registry selection.
      // Reflect.apply lets the regression run before the optional hint exists;
      // the old implementation ignores it and probes the unrelated agent.
      const detected = await Reflect.apply(launcher.detectAgentCredentials, launcher, [agent]);
      return resolveAgentCredentialProbe("/tmp/matrix-selected-discovery-fixture", agent,
        detected.agents.find((candidate: { id: string }) => candidate.id === agent));
    },
  });
  const provider = (id: "codex" | "claude" | "pi"): CodingAgentProviderAdapter => ({
    providerId: id,
    getSummary: () => {
      summaries.push(id);
      return {
        id, kind: id, displayName: id, availability: "available", installStatus: "installed",
        authStatus: id === "codex" ? "unknown" : "authenticated", supportedModes: ["default"],
        defaultMode: "default", defaultModel: id === "codex" ? "gpt-test" : "model-test", setupActions: [],
      } satisfies AgentProviderSummary;
    },
    healthCheck: () => ({ ok: true }),
    startThread: () => [],
  });
  const registry = createCodingAgentProviderRegistry({
    providers: [provider("codex"), provider("claude"), provider("pi")], agentCredentials: credentials,
  });
  const catalog = createChatProviderCatalogService({
    codingProviders: registry,
    // Selected coding reads never require the system runtime. A full inventory
    // may observe it; this deterministic unavailable runtime adds no providers.
    agentRuntimeSource: async () => { throw new Error("No system runtime in fixture"); },
    codingModelCatalogSource: async (provider) => ({
      models: [{ id: provider.id === "codex" ? "gpt-test" : "model-test", displayName: "Test model",
        capabilities: ["tools"], supportsToolUse: true, supportsVision: false }],
      defaultModel: provider.id === "codex" ? "gpt-test" : "model-test", options: [],
    }),
  });
  return { catalog, commands, summaries };
}

describe("selected Chat provider discovery", () => {
  it("admits a selected Codex catalog without starting unrelated CLI or adapter probes", async () => {
    const { catalog, commands, summaries } = fixture();

    const result = await catalog.getCatalog(principal, { instanceId: "codex_default", model: "gpt-test" });

    expect(result.instances).toEqual([expect.objectContaining({
      id: "codex_default", availability: "available", models: [expect.objectContaining({ id: "gpt-test" })],
    })]);
    expect.soft(summaries).toEqual(["codex"]);
    expect.soft(commands).toEqual(["codex:--version", "codex:login status"]);
  });

  it("still discovers every coding provider and credential for a full inventory", async () => {
    const { catalog, commands, summaries } = fixture();

    const result = await catalog.getCatalog(principal);

    expect(result.instances.filter(instance => ["codex", "claude_code", "pi"].includes(instance.driverKind))
      .map(instance => instance.id)).toEqual(["codex_default", "claude_code_default", "pi_default"]);
    expect(summaries.sort()).toEqual(["claude", "codex", "pi"]);
    expect(commands.sort()).toEqual([
      "claude:--version", "claude:auth status", "codex:--version", "codex:login status",
    ]);
  });
});
