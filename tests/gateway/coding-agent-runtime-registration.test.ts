import { EventEmitter } from "node:events";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSource } from "../../packages/gateway/src/agent-config/service.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createCodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import type { OpenCodeSpawnFn } from "../../packages/gateway/src/coding-agents/opencode-provider.js";
import { resolveWorkspaceProviderRuntime } from "../../packages/gateway/src/coding-agents/workspace-provider-config.js";
import { createWorkspaceCodingAgentProviderSet } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const principal: RequestPrincipal = { userId: "owner_runtime", source: "jwt" };
const now = new Date("2026-08-31T00:00:00.000Z");

function runtimeSource(): AgentRuntimeSource {
  return async () => ({
    runtime: {
      selected: "hermes",
      options: [{
        id: "hermes",
        displayName: "Hermes",
        installState: "installed",
        health: "healthy",
        selectionState: "active",
        configured: true,
        capabilities: ["provider_catalog", "model_selection", "authentication"],
      }],
      transition: null,
    },
    providers: [],
    messaging: { runtime: "hermes", provider: null, model: null, configured: false },
  });
}

function harnessSettings(): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: "providers_runtime" },
    revision: 1,
    refreshedAt: now.toISOString(),
    access: { mode: "writable" },
    supportedActions: [],
    modelProviders: [],
    accessSources: [{
      id: "matrix_included",
      kind: "matrix_gateway",
      fundingKind: "matrix_included",
      providerId: "anthropic",
      accountId: null,
      displayName: "Matrix AI",
      readiness: {
        state: "ready",
        checkedAt: now.toISOString(),
        staleAfter: "2026-08-31T00:05:00.000Z",
        action: "none",
        safeReason: null,
      },
      eligibleModelIds: ["claude-sonnet-5"],
      usage: {
        kind: "unavailable",
        authority: "unavailable",
        state: "not_applicable",
        scope: "owner_entitlement",
        reason: "provider_does_not_report",
        asOf: null,
      },
    }],
    accounts: [],
    harnesses: [{
      id: "harness_opencode",
      harness: "opencode",
      displayName: "OpenCode",
      accentColor: null,
      enabled: true,
      version: "1.16.0",
      installState: "installed",
      authState: "authenticated",
      loginMethods: ["terminal"],
      recommendedLoginMethod: "terminal",
      connectivity: "online",
      accountIds: [],
      selectedAccountId: null,
      accessSourceId: "matrix_included",
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
      activeChatCount: 0,
    }],
    gatewayPolicy: null,
  };
}

describe("customer coding-agent runtime registration", () => {
  it("carries the VPS env registration through catalog selection and a structured OpenCode run", async () => {
    const configured = resolveWorkspaceProviderRuntime({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: "claude,codex,pi,opencode",
      MATRIX_NODE_PREFIX: "/opt/matrix/runtime/node",
    });
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const spawnFn: OpenCodeSpawnFn = (_command, args, options) => {
      calls.push({ args, env: options.env });
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const exit: Array<(code: number | null) => void> = [];
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "text",
          sessionID: "ses_runtime_123",
          part: { id: "part_runtime", type: "text", text: "Ready" },
        })}\n`));
        stdout.emit("end");
        exit.forEach((listener) => listener(0));
      });
      return {
        stdout,
        stderr,
        once(event: "exit" | "error", listener: never) {
          if (event === "exit") exit.push(listener);
        },
        kill: vi.fn(),
      };
    };
    const credentialLaunch = async () => ({ env: { ANTHROPIC_API_KEY: "selected-runtime-key" } });
    const providers = createWorkspaceCodingAgentProviderSet({
      agents: configured.agents,
      runtime: { startSession: vi.fn(), stopSession: vi.fn() },
      homePath: "/home/matrix/home",
      pi: {
        resolveCredentialLaunch: credentialLaunch,
        runCommand: async () => ({ stdout: "0.81.0", stderr: "" }),
      },
      opencode: {
        resolveCredentialLaunch: credentialLaunch,
        spawnFn,
        runCommand: async () => ({ stdout: "1.16.0", stderr: "" }),
        resolveProjectPath: async () => "/work/repo",
      },
    });
    const registry = createCodingAgentProviderRegistry({
      providers: providers.registryProviders,
      now: () => now,
    });
    const inventoryOnlyCatalog = await createChatProviderCatalogService({
      codingProviders: registry,
      agentRuntimeSource: runtimeSource(),
      executableDriverKinds: ["hermes", "codex", "claude_code", "pi", "opencode"],
      credentialedDriverKinds: ["pi", "opencode"],
    }).getCatalog(principal);
    expect(inventoryOnlyCatalog.instances.find((instance) => instance.id === "opencode_default"))
      .toMatchObject({ availability: "auth_required" });
    expect(inventoryOnlyCatalog.instances.find((instance) => instance.id === "pi_default"))
      .toMatchObject({ availability: "auth_required" });

    const catalog = await createChatProviderCatalogService({
      codingProviders: registry,
      agentRuntimeSource: runtimeSource(),
      aiProviderSource: { getSnapshot: async () => providerSettingsCanonicalFixture() },
      harnessSettingsSource: { getSnapshot: async () => harnessSettings() },
      executableDriverKinds: ["hermes", "codex", "claude_code", "pi", "opencode"],
      credentialedDriverKinds: ["pi", "opencode"],
    }).getCatalog(principal);
    const selection = catalog.instances.find((instance) => instance.id === "opencode_default")!;

    expect(providers.executionProviders.map((provider) => provider.providerId))
      .toEqual(["claude", "codex", "pi", "opencode"]);
    expect(selection.unavailabilityReason).toBeUndefined();
    expect(selection).toMatchObject({
      availability: "available",
      defaultSelection: { instanceId: "opencode_default", model: "anthropic:claude-sonnet-5" },
    });

    const opencode = providers.executionProviders.find((provider) => provider.providerId === "opencode")!;
    const result = await opencode.startThread({
      principal,
      thread: {
        id: "thread_019f8e9c1e8c7bedbd12eda826fd07",
        providerId: "opencode",
        title: "OpenCode run",
        status: "queued",
        attention: "none",
        projectId: "matrix-os",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      request: {
        providerId: "opencode",
        prompt: "Inspect the project",
        projectId: "matrix-os",
        clientRequestId: "req_runtime_1",
        model: selection.defaultSelection!.model,
        sandboxMode: "read_only",
      },
      now: () => now,
      nextEventId: (() => { let value = 0; return () => `evt_runtime_${++value}`; })(),
    });

    expect(calls[0]!.args).toEqual(expect.arrayContaining([
      "--format", "json", "--model", "anthropic/claude-sonnet-5", "Inspect the project",
    ]));
    expect(calls[0]!.env).toMatchObject({ ANTHROPIC_API_KEY: "selected-runtime-key" });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant.text.delta", delta: "Ready" }),
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
  });
});
