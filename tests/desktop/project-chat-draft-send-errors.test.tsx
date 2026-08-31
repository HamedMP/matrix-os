// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentThreadComposerDraft, type RuntimeSummary } from "@matrix-os/contracts";
import { ProjectChatDraft } from "@desktop/renderer/src/features/project/ProjectChatDraft";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDraftChat } from "@desktop/renderer/src/stores/draft-chat";
import { useProjectWorkspaces } from "@desktop/renderer/src/stores/project-workspaces";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { AppError } from "@desktop/shared/app-error";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";

const catalogMock = vi.hoisted(() => ({ attachments: true }));
vi.mock("@desktop/renderer/src/features/chat/chat-provider-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@desktop/renderer/src/features/chat/chat-provider-catalog")>();
  return {
    ...actual,
    useChatProviderCatalog: (fallback: { instances: Array<{ supports: { attachments: string[] } }> }) => ({
      catalog: catalogMock.attachments
        ? fallback
        : {
            ...fallback,
            instances: fallback.instances.map((instance) => ({
              ...instance,
              supports: { ...instance.supports, attachments: [] },
            })),
          },
      status: "ready",
    }),
  };
});

const summary: RuntimeSummary = {
  runtime: { id: "rt_primary", label: "Matrix", status: "available" },
  capabilities: [{ id: "codingAgentsThreadCreate", enabled: true }],
  providers: [{
    id: "codex",
    kind: "codex",
    displayName: "Codex",
    availability: "available",
    installStatus: "installed",
    authStatus: "authenticated",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
  }, {
    id: "claude",
    kind: "claude",
    displayName: "Claude Code",
    availability: "available",
    installStatus: "installed",
    authStatus: "authenticated",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
  }],
  projects: { items: [], hasMore: false, limit: 20 },
  activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [], hasMore: false, limit: 20 },
  terminalSessions: { items: [], hasMore: false, limit: 20 },
  previewSessions: { items: [], hasMore: false, limit: 20 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
  serverTime: "2026-08-31T00:00:00.000Z",
};

describe("ProjectChatDraft send failures", () => {
  beforeEach(() => {
    catalogMock.attachments = true;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    useConnection.setState({ api: null });
    useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true);
    useDraftChat.setState({ entries: {} });
    useProjectWorkspaces.setState({
      resolveNewChatTarget: vi.fn(async () => ({ projectId: "matrix-os" })),
    });
    resetProviderPreferences({ hydrated: true });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:get") return { value: null };
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("restores the last Provider Instance and model in a canonical Project Chat draft", async () => {
    resetProviderPreferences({
      hydrated: true,
      lastComposerInstanceId: "claude_code_default",
      composerSelections: {
        claude_code_default: {
          model: "provider-default",
          options: [],
          permissionMode: "supervised",
        },
      },
    });

    render(
      <ProjectChatDraft
        summary={summary}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{} as never}
      />,
    );

    await screen.findByRole("textbox", { name: "Message new chat" });
    const picker = screen.getByRole("button", { name: "Choose model and provider" });
    expect(picker.getAttribute("data-provider-instance")).toBe("claude_code_default");
    expect(picker.getAttribute("data-model")).toBe("provider-default");
  });

  it("keeps an explicitly selected restored draft provider ahead of the global default", async () => {
    const summaryWithModels: RuntimeSummary = {
      ...summary,
      providers: summary.providers.map((provider) => ({
        ...provider,
        defaultModel: provider.id === "claude" ? "claude-sonnet-4.6" : "gpt-5.6",
      })),
    };
    useDraftChat.getState().setDraft("matrix-os", {
      ...defaultAgentThreadComposerDraft(summaryWithModels),
      providerId: "claude",
      prompt: "Continue the restored draft",
    }, true);
    resetProviderPreferences({
      hydrated: true,
      lastComposerInstanceId: "codex_default",
      composerSelections: {
        codex_default: {
          model: "gpt-5.6",
          options: [{ id: "effort", value: "high" }],
          permissionMode: "supervised",
        },
      },
    });

    render(
      <ProjectChatDraft
        summary={summaryWithModels}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{} as never}
      />,
    );

    const picker = await screen.findByRole("button", { name: "Choose model and provider" });
    expect(picker.getAttribute("data-provider-instance")).toBe("claude_code_default");
    expect(picker.getAttribute("data-model")).toBe("claude-sonnet-4.6");
  });

  it("applies the global default to a restored draft without explicit picker intent", async () => {
    const summaryWithModels: RuntimeSummary = {
      ...summary,
      providers: summary.providers.map((provider) => ({
        ...provider,
        defaultModel: provider.id === "claude" ? "claude-sonnet-4.6" : "gpt-5.6",
      })),
    };
    useDraftChat.getState().setDraft("matrix-os", {
      ...defaultAgentThreadComposerDraft(summaryWithModels),
      providerId: "claude",
      prompt: "Continue the untouched restored draft",
    });
    resetProviderPreferences({
      hydrated: true,
      lastComposerInstanceId: "codex_default",
      composerSelections: {
        codex_default: {
          model: "gpt-5.6",
          options: [{ id: "effort", value: "high" }],
          permissionMode: "supervised",
        },
      },
    });

    render(
      <ProjectChatDraft
        summary={summaryWithModels}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{} as never}
      />,
    );

    const picker = await screen.findByRole("button", { name: "Choose model and provider" });
    expect(picker.getAttribute("data-provider-instance")).toBe("codex_default");
    expect(picker.getAttribute("data-model")).toBe("gpt-5.6");
  });

  it("applies a remembered effort after preferences hydrate on a cold mount", async () => {
    resetProviderPreferences();
    let resolveStateGet!: (result: { value: unknown }) => void;
    const stateGet = new Promise<{ value: unknown }>((resolve) => {
      resolveStateGet = resolve;
    });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") return stateGet;
      if (channel === "state:set") return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(
      <ProjectChatDraft
        summary={summary}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{} as never}
      />,
    );

    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("Low");
    resolveStateGet({
      value: {
        defaultProviderId: null,
        lastComposerInstanceId: "codex_default",
        composerSelections: {
          codex_default: {
            model: "provider-default",
            options: [{ id: "effort", value: "high" }],
            permissionMode: "supervised",
          },
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    });
  });

  it("shows the upload reason and keeps the draft for retry", async () => {
    render(
      <ProjectChatDraft
        summary={summary}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{} as never}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message new chat" });
    await setSharedComposerText(input, "Inspect this file");
    fireEvent.change(screen.getByLabelText("Choose files"), {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Attachment upload is unavailable because no Matrix computer is connected.",
    );
    expect(input.textContent).toBe("Inspect this file");
  });

  it("explains when the selected provider cannot send files", async () => {
    catalogMock.attachments = false;
    render(
      <ProjectChatDraft
        summary={summary}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{} as never}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message new chat" });
    await setSharedComposerText(input, "Inspect this file");
    fireEvent.change(screen.getByLabelText("Choose files"), {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: The selected provider does not support file attachments.",
    );
  });

  it("translates a canonical admission failure into a safe reason", async () => {
    const create = vi.fn(async () => { throw new AppError("server", { detail: "model_unavailable" }); });
    render(
      <ProjectChatDraft
        summary={summary}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
        canonicalClient={{ create } as never}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message new chat" });
    await setSharedComposerText(input, "Use this model");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: The selected model is unavailable. Choose another model.",
    );
  });

  it("shows the safe reason from the wired legacy thread creation path", async () => {
    useCodingAgentWorkspace.setState({ summary });
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:create-thread") return {
        ok: false,
        error: {
          code: "thread_create_offline",
          safeMessage: "Can't reach Matrix OS. Check your connection.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      };
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    render(
      <ProjectChatDraft
        summary={summary}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active={false}
        seed={null}
        focusRequestId={0}
        typeToStartEnabled={false}
        onCreated={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message new chat" });
    await setSharedComposerText(input, "Keep this draft");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Can't reach Matrix OS. Check your connection.",
    );
    expect(input.textContent).toBe("Keep this draft");
  });
});
