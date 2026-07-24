import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentProviderSummarySchema,
  ProviderIdSchema,
  ProviderKindSchema,
} from "../../packages/contracts/src/index.js";
import { configuredWorkspaceProviderAgents } from "../../packages/gateway/src/coding-agents/workspace-provider-config.js";
import { createWorkspaceCodingAgentProviderSet } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const baseNow = new Date("2026-07-23T12:00:00.000Z");

let homePath: string;
beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "matrix-pi-config-"));
});
afterEach(async () => {
  await rm(homePath, { recursive: true, force: true });
});

function fakeRuntime() {
  return {
    startSession: vi.fn(async () => ({ ok: false as const, status: 503, error: { code: "unavailable", message: "unused" } })),
    stopSession: vi.fn(async () => ({ ok: false as const, status: 503, error: { code: "unavailable", message: "unused" } })),
  };
}

describe("pi provider id contracts", () => {
  it("accepts pi as a provider id and kind", () => {
    expect(ProviderIdSchema.parse("pi")).toBe("pi");
    expect(ProviderKindSchema.parse("pi")).toBe("pi");
  });
});

describe("workspace provider env configuration with pi", () => {
  it("accepts pi in MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS", () => {
    expect(configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: "pi",
    })).toEqual(["pi"]);
    expect(configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: "claude, pi ,codex",
    })).toEqual(["claude", "pi", "codex"]);
  });

  it("rejects duplicates and unknown agents", () => {
    expect(() => configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: "pi,pi",
    })).toThrow();
    expect(() => configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: "pi,unknown-agent",
    })).toThrow();
  });

  it("keeps the legacy codex-only path unchanged", () => {
    expect(configuredWorkspaceProviderAgents({ MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER: "1" })).toEqual(["codex"]);
    expect(configuredWorkspaceProviderAgents({ MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER: "0" })).toEqual([]);
    expect(configuredWorkspaceProviderAgents({})).toEqual([]);
  });
});

describe("workspace provider set wiring with pi", () => {
  it("registers pi as a runnable execution provider without touching codex/claude behavior", async () => {
    const set = createWorkspaceCodingAgentProviderSet({
      agents: ["claude", "codex", "pi"],
      runtime: fakeRuntime(),
      homePath,
      pi: { runCommand: async () => ({ stdout: "0.81.0\n", stderr: "" }) },
    });

    expect(set.registryProviders.map((provider) => provider.providerId)).toEqual(["claude", "codex", "pi"]);
    // claude stays registry-only, codex and pi are executable.
    expect(set.executionProviders.map((provider) => provider.providerId).sort()).toEqual(["codex", "pi"]);

    const pi = set.registryProviders.find((provider) => provider.providerId === "pi")!;
    const summary = AgentProviderSummarySchema.parse(await pi.getSummary!({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    }));
    expect(summary).toMatchObject({
      id: "pi",
      displayName: "Pi",
      kind: "pi",
      availability: "available",
    });
  });

  it("keeps codex-only sets identical to the previous behavior", () => {
    const set = createWorkspaceCodingAgentProviderSet({
      agents: ["codex"],
      runtime: fakeRuntime(),
      homePath,
    });
    expect(set.registryProviders.map((provider) => provider.providerId)).toEqual(["codex"]);
    expect(set.executionProviders.map((provider) => provider.providerId)).toEqual(["codex"]);
  });
});
