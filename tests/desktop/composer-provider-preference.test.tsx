// @vitest-environment jsdom

// A saved default provider must not override the ready provider unless it can
// actually start a run. Selecting a provider that still needs setup or auth
// produces a draft that buildCreateAgentThreadRequestFromComposer rejects, so
// the seeded chat fails on submit instead of running.

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentThreadComposerDraft, type RuntimeSummary } from "@matrix-os/contracts";
import { AgentComposer } from "../../desktop/src/renderer/src/features/coding-agents/AgentComposer";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

const NOW = "2026-07-27T12:00:00.000Z";

function provider(id: string, ready: boolean) {
  return {
    id,
    kind: id,
    displayName: id === "codex" ? "Codex" : id === "pi" ? "Pi" : "Claude",
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
    useCodingAgentWorkspace.setState({ createStatus: "idle", createError: null });
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

  it("applies a hydrated preference without dropping seeded project context", async () => {
    let releasePreference!: (value: { value: { defaultProviderId: string } }) => void;
    const preference = new Promise<{ value: { defaultProviderId: string } }>((resolve) => {
      releasePreference = resolve;
    });
    window.operator.invoke = vi.fn(async (channel: string) =>
      channel === "state:get" ? preference : { ok: true },
    ) as typeof window.operator.invoke;
    const summary = summaryWith([provider("codex", true), provider("claude", true)]);

    render(
      <AgentComposer
        summary={summary}
        seed={{
          seedId: 1,
          draft: {
            ...defaultAgentThreadComposerDraft(summary),
            projectId: "matrix-os",
          },
        }}
        focusRequestId={0}
      />,
    );

    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("codex");
    await act(async () => {
      releasePreference({ value: { defaultProviderId: "claude" } });
      await preference;
    });

    await waitFor(() =>
      expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("claude"),
    );
  });

  it("does not replace an explicit provider selection when hydration finishes", async () => {
    let releasePreference!: (value: { value: { defaultProviderId: string } }) => void;
    const preference = new Promise<{ value: { defaultProviderId: string } }>((resolve) => {
      releasePreference = resolve;
    });
    window.operator.invoke = vi.fn(async (channel: string) =>
      channel === "state:get" ? preference : { ok: true },
    ) as typeof window.operator.invoke;
    const summary = summaryWith([
      provider("codex", true),
      provider("claude", true),
      provider("opencode", true),
    ]);

    render(<AgentComposer summary={summary} seed={null} focusRequestId={0} />);
    const providerSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: "opencode" } });
    expect(providerSelect.value).toBe("opencode");

    await act(async () => {
      releasePreference({ value: { defaultProviderId: "claude" } });
      await preference;
    });

    await waitFor(() => expect(providerSelect.value).toBe("opencode"));
  });

  it("switches the desktop draft to Pi's runnable read-only sandbox", async () => {
    const createThread = vi.fn(async () => null);
    useCodingAgentWorkspace.setState({ createThread });
    render(
      <AgentComposer
        summary={summaryWith([provider("codex", true), provider("pi", true)])}
        seed={null}
        focusRequestId={0}
      />,
    );

    fireEvent.change(screen.getByLabelText("Provider", { selector: "select" }), {
      target: { value: "pi" },
    });
    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Inspect the repository" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "pi",
      sandboxMode: "read_only",
    })));
  });
});
