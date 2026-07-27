// @vitest-environment jsdom

// A saved default provider must not override the ready provider unless it can
// actually start a run. Selecting a provider that still needs setup or auth
// produces a draft that buildCreateAgentThreadRequestFromComposer rejects, so
// the seeded chat fails on submit instead of running.

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { AgentComposer } from "../../desktop/src/renderer/src/features/coding-agents/AgentComposer";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";

const NOW = "2026-07-27T12:00:00.000Z";

function provider(id: string, ready: boolean) {
  return {
    id,
    kind: id,
    displayName: id === "codex" ? "Codex" : "Claude",
    availability: ready ? "available" : "setup_required",
    installStatus: ready ? "installed" : "missing",
    authStatus: ready ? "authenticated" : "missing",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
  };
}

function summaryWith(providers: unknown[]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsThreadCreate", enabled: true }],
    providers,
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  } as unknown as RuntimeSummary;
}

describe("AgentComposer default provider preference", () => {
  beforeEach(() => {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) =>
          channel === "state:get" ? { value: null } : { ok: true },
        ),
        on: vi.fn(() => () => undefined),
      },
    });
    useProviderPreferences.setState({ defaultProviderId: null, hydrated: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the ready provider when the saved preference is not runnable", () => {
    useProviderPreferences.setState({ defaultProviderId: "claude", hydrated: true });
    render(
      <AgentComposer
        summary={summaryWith([provider("codex", true), provider("claude", false)])}
        seed={null}
        focusRequestId={0}
      />,
    );

    const select = screen.getByLabelText("Provider", { selector: "select" }) as HTMLSelectElement
      ?? (screen.getAllByRole("combobox")[0] as HTMLSelectElement);
    expect(select.value).toBe("codex");
  });

  it("uses the saved preference when that provider is runnable", () => {
    useProviderPreferences.setState({ defaultProviderId: "claude", hydrated: true });
    render(
      <AgentComposer
        summary={summaryWith([provider("codex", true), provider("claude", true)])}
        seed={null}
        focusRequestId={0}
      />,
    );

    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(select.value).toBe("claude");
  });
});
