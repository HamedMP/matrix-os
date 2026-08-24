import { describe, expect, it } from "vitest";
import type { AgentProviderSummary, RuntimeSummary } from "@matrix-os/contracts";
import {
  deriveProviderReadiness,
  type ProviderReadinessPresentation,
} from "../../desktop/src/renderer/src/features/coding-agents/provider-readiness.js";

const installAction = {
  id: "codex_install",
  kind: "foreground_terminal" as const,
  label: "Install Codex",
  command: "npm install -g @openai/codex",
};

const connectAction = {
  id: "codex_connect",
  kind: "foreground_terminal" as const,
  label: "Connect Codex",
  command: "codex login",
};

const connectClaudeAction = {
  id: "claude_connect",
  kind: "foreground_terminal" as const,
  label: "Connect Claude",
  command: "claude",
};

function provider(overrides: Partial<AgentProviderSummary> = {}): AgentProviderSummary {
  return {
    id: "codex",
    kind: "codex",
    displayName: "Codex",
    availability: "available",
    installStatus: "installed",
    authStatus: "authenticated",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
    ...overrides,
  };
}

function summary(providers: AgentProviderSummary[]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
    providers,
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16_384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8_192,
      maxListItems: 20,
    },
    serverTime: "2026-08-21T12:00:00.000Z",
  };
}

function visibleCopy(readiness: ProviderReadinessPresentation): string {
  return `${readiness.title} ${readiness.description}`;
}

describe("deriveProviderReadiness", () => {
  it("keeps summary hydration distinct from an unconfigured provider", () => {
    expect(deriveProviderReadiness({ summary: null, loading: true })).toEqual({
      state: "loading",
      blocked: true,
      title: "Checking coding agent provider",
      description: "Matrix is verifying the selected provider.",
      action: null,
    });
  });

  it("fails closed when the runtime summary is unavailable", () => {
    expect(deriveProviderReadiness({ summary: null, loading: false })).toEqual({
      state: "unverified",
      blocked: true,
      title: "Matrix could not verify this provider",
      description: "Refresh provider status before sending.",
      action: { kind: "refresh" },
    });
  });

  it("opens provider settings when no provider is configured", () => {
    expect(deriveProviderReadiness({ summary: summary([]), loading: false })).toEqual({
      state: "unconfigured",
      blocked: true,
      title: "No coding agent provider is configured",
      description: "Open provider settings to choose a coding agent provider.",
      action: {
        kind: "setup",
        action: {
          id: "provider_settings",
          kind: "open_settings",
          label: "Open provider settings",
        },
      },
    });
  });

  it("fails closed when the selected provider is missing from the summary", () => {
    expect(deriveProviderReadiness({
      summary: summary([provider({ id: "claude", displayName: "Claude", kind: "claude" })]),
      providerId: "codex",
      loading: false,
    })).toEqual({
      state: "unverified",
      blocked: true,
      title: "Matrix could not verify this provider",
      description: "Refresh provider status before sending.",
      action: { kind: "refresh" },
    });
  });

  it("keeps Claude connection recovery available when verification is inconclusive", () => {
    expect(deriveProviderReadiness({
      summary: summary([provider({
        id: "claude",
        displayName: "Claude",
        kind: "claude",
        availability: "unavailable",
        installStatus: "unknown",
        authStatus: "unknown",
        setupActions: [connectClaudeAction],
      })]),
      providerId: "claude",
      loading: false,
    })).toEqual({
      state: "unverified",
      blocked: true,
      title: "Matrix could not verify Claude",
      description: "Refresh provider status or connect Claude before sending.",
      action: { kind: "setup", action: connectClaudeAction },
    });
  });

  it("does not invent a Claude connection action when the Gateway omits setup actions", () => {
    expect(deriveProviderReadiness({
      summary: summary([provider({
        id: "claude",
        displayName: "Claude",
        kind: "claude",
        availability: "unavailable",
        installStatus: "unknown",
        authStatus: "unknown",
        setupActions: [],
      })]),
      providerId: "claude",
      loading: false,
    })).toEqual({
      state: "unverified",
      blocked: true,
      title: "Matrix could not verify Claude",
      description: "Refresh provider status before sending.",
      action: { kind: "refresh" },
    });
  });

  it("allows sending only for an available, installed, authenticated provider", () => {
    expect(deriveProviderReadiness({
      summary: summary([provider()]),
      providerId: "codex",
      loading: false,
    })).toEqual({
      state: "ready",
      blocked: false,
      title: "",
      description: "",
      action: null,
    });
  });

  it("selects the authentication action for an installed provider that needs login", () => {
    const readiness = deriveProviderReadiness({
      summary: summary([provider({
        availability: "auth_required",
        installStatus: "installed",
        authStatus: "missing",
        setupActions: [installAction, connectAction],
      })]),
      providerId: "codex",
      loading: false,
    });

    expect(readiness.action).toEqual({ kind: "setup", action: connectAction });
  });

  it("opens provider settings when authentication recovery is unavailable", () => {
    const readiness = deriveProviderReadiness({
      summary: summary([provider({
        availability: "auth_required",
        installStatus: "installed",
        authStatus: "missing",
        setupActions: [installAction],
      })]),
      providerId: "codex",
      loading: false,
    });

    expect(readiness.action).toEqual({
      kind: "setup",
      action: {
        id: "provider_settings",
        kind: "open_settings",
        label: "Open provider settings",
      },
    });
  });

  it.each([
    {
      name: "not installed",
      value: provider({
        availability: "setup_required",
        installStatus: "missing",
        authStatus: "missing",
        setupActions: [installAction],
      }),
      expected: {
        state: "missing",
        blocked: true,
        title: "Codex is not installed",
        description: "Install Codex before sending a message.",
        action: { kind: "setup", action: installAction },
      },
    },
    {
      name: "authentication required",
      value: provider({
        availability: "auth_required",
        authStatus: "missing",
        setupActions: [connectAction],
      }),
      expected: {
        state: "auth_required",
        blocked: true,
        title: "Connect Codex to continue",
        description: "Sign in to Codex before sending a message.",
        action: { kind: "setup", action: connectAction },
      },
    },
    {
      name: "authentication expired",
      value: provider({
        availability: "auth_required",
        authStatus: "expired",
        setupActions: [connectAction],
      }),
      expected: {
        state: "expired",
        blocked: true,
        title: "Codex needs to be reconnected",
        description: "Reconnect Codex before sending a message.",
        action: { kind: "setup", action: connectAction },
      },
    },
    {
      name: "installing",
      value: provider({
        availability: "installing",
        installStatus: "installing",
        authStatus: "unknown",
      }),
      expected: {
        state: "installing",
        blocked: true,
        title: "Installing Codex",
        description: "Refresh provider status after installation finishes.",
        action: { kind: "refresh" },
      },
    },
    {
      name: "version unsupported",
      value: provider({
        availability: "unavailable",
        installStatus: "failed",
        authStatus: "unknown",
      }),
      expected: {
        state: "unsupported",
        blocked: true,
        title: "Update Codex to a supported version",
        description: "Open setup to install a supported Codex version.",
        action: {
          kind: "setup",
          action: {
            id: "provider_settings",
            kind: "open_settings",
            label: "Open provider settings",
          },
        },
      },
    },
    {
      name: "check failed",
      value: provider({
        availability: "unavailable",
        installStatus: "unknown",
        authStatus: "unknown",
      }),
      expected: {
        state: "unverified",
        blocked: true,
        title: "Matrix could not verify Codex",
        description: "Refresh provider status before sending.",
        action: { kind: "refresh" },
      },
    },
  ])("derives safe presentation for $name", ({ value, expected }) => {
    const readiness = deriveProviderReadiness({
      summary: summary([value]),
      providerId: "codex",
      loading: false,
    });

    expect(readiness).toEqual(expected);
    expect(visibleCopy(readiness)).not.toMatch(/npm install|codex login|token|secret|\/home\//i);
  });
});
