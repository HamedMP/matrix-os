import { describe, expect, it, vi } from "vitest";
import type { AgentCredentialStatus } from "../../packages/gateway/src/onboarding/activation-contracts.js";
import type { AgentCredentialStatusService } from "../../packages/gateway/src/onboarding/agent-credential-status.js";
import {
  createCodingAgentProviderRegistry,
} from "../../packages/gateway/src/coding-agents/provider-registry.js";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const baseNow = new Date("2026-07-09T12:00:00.000Z");
const owner: RequestPrincipal = { userId: "owner_user", source: "jwt" };

function credentialService(
  status: AgentCredentialStatus,
): Pick<AgentCredentialStatusService, "getStatus"> {
  return {
    getStatus: vi.fn(async () => ({
      systemAgent: "hermes" as const,
      activeAgents: status === "available" ? ["codex", "hermes"] as const : ["hermes"] as const,
      routingExplanation: "Provider state is runtime-owned.",
      agents: [{
        agent: "codex" as const,
        status,
        coordinationRole: "coding_specialist" as const,
        workflows: ["coding" as const],
        degradedWorkflows: status === "available" ? [] : ["coding" as const],
        verifiedAt: status === "available" ? baseNow.toISOString() : null,
        nextAction: null,
      }],
    })),
  };
}

function adapter(overrides: Partial<CodingAgentProviderAdapter> = {}): CodingAgentProviderAdapter {
  return {
    providerId: "codex",
    getSummary: ({ now }) => ({
      id: "codex",
      displayName: "Codex",
      kind: "codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default", "review"],
      defaultMode: "default",
      setupActions: [],
      lastCheckedAt: now().toISOString(),
    }),
    healthCheck: () => ({ ok: true }),
    buildSetupAction: () => [{
      id: "codex_login",
      kind: "foreground_terminal",
      label: "Connect Codex",
      command: "codex login",
    }],
    startThread: () => [],
    ...overrides,
  };
}

describe("coding-agent provider registry", () => {
  it("normalizes installed and authenticated providers into safe summaries", async () => {
    const healthCheck = vi.fn(({ signal }: { signal: AbortSignal }) => ({ ok: !signal.aborted }));
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({ healthCheck })],
      agentCredentials: credentialService("available"),
      now: () => baseNow,
    });

    const summaries = await registry.listProviders(owner);

    expect(summaries).toEqual([{
      id: "codex",
      displayName: "Codex",
      kind: "codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default", "review"],
      defaultMode: "default",
      setupActions: [{
        id: "codex_login",
        kind: "foreground_terminal",
        label: "Connect Codex",
        command: "codex login",
      }],
      lastCheckedAt: baseNow.toISOString(),
    }]);
    expect(healthCheck).toHaveBeenCalledWith(expect.objectContaining({
      principal: owner,
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ["missing", "setup_required", "missing", "missing"],
    ["expired", "auth_required", "installed", "expired"],
    ["revoked", "auth_required", "installed", "expired"],
    ["failed", "unavailable", "failed", "unknown"],
  ] as const)(
    "maps %s credential state to coarse provider status",
    async (status, availability, installStatus, authStatus) => {
      const healthCheck = vi.fn(() => ({ ok: true }));
      const registry = createCodingAgentProviderRegistry({
        providers: [adapter({ healthCheck })],
        agentCredentials: credentialService(status),
        now: () => baseNow,
      });

      const [summary] = await registry.listProviders(owner);

      expect(summary).toMatchObject({ availability, installStatus, authStatus });
      expect(healthCheck).not.toHaveBeenCalled();
    },
  );

  it("fails closed when credential status cannot be read", async () => {
    const healthCheck = vi.fn(() => ({ ok: true }));
    const buildSetupAction = vi.fn(() => [{
      id: "codex_login",
      kind: "foreground_terminal" as const,
      label: "Connect Codex",
      command: "codex login",
    }]);
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({ healthCheck, buildSetupAction })],
      agentCredentials: {
        getStatus: vi.fn(async () => {
          throw new Error("credential backend unavailable");
        }),
      },
      now: () => baseNow,
    });

    const [summary] = await registry.listProviders(owner);

    expect(summary).toMatchObject({
      id: "codex",
      availability: "unavailable",
      installStatus: "unknown",
      authStatus: "unknown",
      setupActions: [],
      lastCheckedAt: baseNow.toISOString(),
    });
    expect(healthCheck).not.toHaveBeenCalled();
    expect(buildSetupAction).not.toHaveBeenCalled();
  });

  it("keeps credential-known providers without execution adapters in the summary", async () => {
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter()],
      agentCredentials: {
        getStatus: vi.fn(async () => ({
          systemAgent: "hermes" as const,
          activeAgents: ["claude", "codex", "hermes"] as const,
          routingExplanation: "Provider state is runtime-owned.",
          agents: [
            {
              agent: "claude" as const,
              status: "available" as const,
              coordinationRole: "coding_specialist" as const,
              workflows: ["coding" as const],
              degradedWorkflows: [],
              verifiedAt: baseNow.toISOString(),
              nextAction: null,
            },
            {
              agent: "codex" as const,
              status: "available" as const,
              coordinationRole: "coding_specialist" as const,
              workflows: ["coding" as const],
              degradedWorkflows: [],
              verifiedAt: baseNow.toISOString(),
              nextAction: null,
            },
          ],
        })),
      },
      now: () => baseNow,
    });

    const summaries = await registry.listProviders(owner);

    expect(summaries.map((summary) => summary.id)).toEqual(["claude", "codex"]);
    expect(summaries[0]).toMatchObject({
      id: "claude",
      displayName: "Claude",
      kind: "claude",
      availability: "unavailable",
      installStatus: "installed",
      authStatus: "authenticated",
      setupActions: [],
      lastCheckedAt: baseNow.toISOString(),
    });
  });

  it("times out provider health checks and aborts their signal", async () => {
    let aborted = false;
    const healthCheck = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return new Promise<{ ok: boolean }>(() => undefined);
    });
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({ healthCheck })],
      agentCredentials: credentialService("available"),
      healthTimeoutMs: 5,
      now: () => baseNow,
    });

    const [summary] = await registry.listProviders(owner);

    expect(aborted).toBe(true);
    expect(summary).toMatchObject({
      id: "codex",
      availability: "unavailable",
      installStatus: "installed",
      authStatus: "authenticated",
      lastCheckedAt: baseNow.toISOString(),
    });
  });

  it("reuses health within the TTL and refreshes it after expiry", async () => {
    let currentTime = baseNow.getTime();
    const healthCheck = vi.fn(() => ({ ok: true }));
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({ healthCheck })],
      agentCredentials: credentialService("available"),
      cacheTtlMs: 1_000,
      now: () => new Date(currentTime),
    });

    await registry.listProviders(owner);
    await registry.listProviders(owner);
    currentTime += 1_001;
    await registry.listProviders(owner);

    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used health entries at the cache cap", async () => {
    const healthCheck = vi.fn(() => ({ ok: true }));
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({ healthCheck })],
      agentCredentials: credentialService("available"),
      cacheTtlMs: 60_000,
      maxCacheEntries: 2,
      now: () => baseNow,
    });
    const ownerOne = { ...owner, userId: "owner_one" };
    const ownerTwo = { ...owner, userId: "owner_two" };
    const ownerThree = { ...owner, userId: "owner_three" };

    await registry.listProviders(ownerOne);
    await registry.listProviders(ownerTwo);
    await registry.listProviders(ownerOne);
    await registry.listProviders(ownerThree);
    await registry.listProviders(ownerTwo);

    expect(healthCheck).toHaveBeenCalledTimes(4);
  });

  it("falls back to an unavailable safe summary for malformed adapter output", async () => {
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({
        getSummary: () => ({
          id: "codex",
          displayName: "/home/matrix/private",
          kind: "codex",
        } as never),
        buildSetupAction: () => [{
          id: "../unsafe",
          kind: "foreground_terminal",
          label: "/home/matrix/private",
          command: "token=secret",
        } as never],
      })],
      agentCredentials: credentialService("available"),
      now: () => baseNow,
    });

    const summaries = await registry.listProviders(owner);

    expect(summaries).toEqual([expect.objectContaining({
      id: "codex",
      displayName: "Coding agent",
      availability: "unavailable",
      installStatus: "unknown",
      authStatus: "unknown",
      setupActions: [],
    })]);
    expect(JSON.stringify(summaries)).not.toMatch(/\/home\/matrix|token|secret|\.\.\/unsafe/);
  });

  it("drops malformed setup actions without hiding a valid provider", async () => {
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({
        buildSetupAction: () => [{
          id: "../unsafe",
          kind: "foreground_terminal",
          label: "/home/matrix/private",
          command: "token=secret",
        } as never],
      })],
      agentCredentials: credentialService("available"),
      now: () => baseNow,
    });

    const summaries = await registry.listProviders(owner);

    expect(summaries).toEqual([expect.objectContaining({
      id: "codex",
      availability: "available",
      setupActions: [],
    })]);
    expect(JSON.stringify(summaries)).not.toMatch(/\/home\/matrix|token|secret|\.\.\/unsafe/);
  });

  it("preserves schema-valid summary setup actions when no builder exists", async () => {
    const registry = createCodingAgentProviderRegistry({
      providers: [adapter({
        getSummary: ({ now }) => ({
          id: "codex",
          displayName: "Codex",
          kind: "codex",
          availability: "setup_required",
          installStatus: "missing",
          authStatus: "missing",
          supportedModes: ["default"],
          defaultMode: "default",
          setupActions: [{
            id: "codex_settings",
            kind: "open_settings",
            label: "Open agent settings",
          }],
          lastCheckedAt: now().toISOString(),
        }),
        buildSetupAction: undefined,
      })],
      now: () => baseNow,
    });

    const [summary] = await registry.listProviders(owner);

    expect(summary.setupActions).toEqual([{
      id: "codex_settings",
      kind: "open_settings",
      label: "Open agent settings",
    }]);
  });

  it("rejects unsafe or duplicate provider configuration", () => {
    expect(() => createCodingAgentProviderRegistry({
      providers: [adapter({ providerId: "../unsafe" })],
    })).toThrow();
    expect(() => createCodingAgentProviderRegistry({
      providers: [adapter(), adapter()],
    })).toThrow(/duplicate/i);
  });
});
