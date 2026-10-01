// @vitest-environment jsdom
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AoedeBootstrapResponse } from "../../packages/contracts/src/aoede.js";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { ShellAoedeHost } from "../../shell/src/components/ShellAoedeHost.js";
import type { AoedeApi } from "../../packages/ui/src/aoede/client.js";
import type { VoiceSessionClient } from "../../packages/ui/src/voice-session/client-types.js";
import type { CanonicalChatInvalidation } from "../../packages/ui/src/canonical-chat-event-source.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { useCommandStore } from "../../shell/src/stores/commands.js";
import { AOEDE_COMMAND_ID } from "../../shell/src/lib/aoede-shell.js";

const binding: AoedeBootstrapResponse = {
  chatId: "chat_aoede",
  scope: { kind: "workspace", id: "workspace", label: "Workspace" },
  selection: { instanceId: "pi_main", model: "test:model" },
  capability: {
    contractVersion: 1,
    surface: "web_desktop",
    status: "available",
    transportModes: ["relayed_websocket"],
    turnModes: ["hands_free", "push_to_talk"],
    supportsInterruption: true,
    resume: "delivery_aware",
    sessionOnly: "unsupported",
    actionMode: "canonical_actions",
    actionCancellation: "run",
    supportsInputSelection: false,
    supportsOutputSelection: false,
  },
};

const detail: CanonicalChatDetailResponse = {
  record: {
    chat: {
      id: "chat_aoede",
      revision: 0,
      ownerScope: { type: "personal", ownerId: "owner_test" },
      title: "Aoede",
      lifecycle: "active",
      attention: "none",
      messageCount: 0,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  messages: [],
  turns: [],
  runs: [],
  activities: [],
};

const operationView = { id: "action_nav", chatId: "chat_aoede", runId: "run_nav", toolId: "tool_open", schemaRevision: "s1", policyRevision: "p1", state: "succeeded" as const, argumentDigest: "a".repeat(64), cancellationRequested: false, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };

function runningDetail(): CanonicalChatDetailResponse {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const run = { ...fixture.runs[0]!, chatId: binding.chatId, capabilitySnapshot: { ...fixture.runs[0]!.capabilitySnapshot, cancellation: "run" as const } };
  return { ...detail, record: { ...detail.record, activeRun: { runId: run.id, turnId: run.turnId, status: "running" } }, runs: [run],
    turns: fixture.turns.map(item => ({ ...item, chatId: binding.chatId })), messages: fixture.messages.map(item => ({ ...item, chatId: binding.chatId })), activities: [] };
}

function harness(bootstrapImpl?: () => Promise<AoedeBootstrapResponse>, initialDetail = detail) {
  const source = {
    subscribe: vi.fn((_listener: (event: CanonicalChatInvalidation) => void) => ({ dispose: vi.fn() })),
    start: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const bootstrap = vi.fn(bootstrapImpl ?? (async () => binding));
  const detailFn = vi.fn(async () => initialDetail);
  const cancelRun = vi.fn(async () => ({}));
  const api = {
    bootstrap,
    detail: detailFn,
    events: () => source,
    cancelRun,
    submitInput: vi.fn(async () => ({})),
    submitApproval: vi.fn(async () => ({})),
  } as unknown as AoedeApi;
  let mediaListener: (() => void) | undefined;
  const media = {
    subscribe: vi.fn((listener: () => void) => { mediaListener = listener; return () => {}; }),
    getSnapshot: vi.fn(() => ({
      phase: "idle" as const,
      voice: null,
      error: null,
      notice: null,
      chatId: null,
      sessionId: null,
      reconnectStatus: null,
    })),
    startVoice: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    dispose: vi.fn(),
    controller: () => null,
    retry: vi.fn(),
    listDevices: vi.fn(async () => null),
    setInputDevice: vi.fn(async () => true),
    setOutputDevice: vi.fn(async () => "applied" as const),
  } as unknown as VoiceSessionClient;
  const voiceFactory = vi.fn(() => media);
  return { api, bootstrap, detailFn, cancelRun, source, media, voiceFactory, notifyMedia: () => mediaListener?.() };
}

function renderHost(
  deps: ReturnType<typeof harness>,
  props: Partial<Parameters<typeof ShellAoedeHost>[0]> = {},
  children: React.ReactNode = <div data-testid="shell-child" />,
) {
  return render(
    <ShellAoedeHost
      userId="owner_test"
      runtimeSlot={null}
      surface="web_desktop"
      supported
      controllerDeps={{ api: deps.api, voiceFactory: deps.voiceFactory }}
      {...props}
    >
      {children}
    </ShellAoedeHost>,
  );
}

function paletteCommand() {
  return useCommandStore.getState().commands.get(AOEDE_COMMAND_ID);
}

describe("Shell Aoede host", () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: new Map() });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts the assistant without any Chat UI or chat state", async () => {
    const h = harness();
    renderHost(h);
    expect(screen.getByTestId("shell-child")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    expect(document.querySelector("[data-testid='aoede-host'] .matrix-aoede")).not.toBeNull();
    // No Chat composer/message list may appear inside the assistant surface.
    expect(screen.queryByPlaceholderText(/message/i)).toBeNull();
    expect(document.querySelector("[data-testid='aoede-host'] [role='log']")).toBeNull();
  });

  it("shows literal idle status, mic off and scope after the icon launch", async () => {
    const h = harness();
    renderHost(h);
    const launcher = screen.getByTestId("aoede-launcher");
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    await act(async () => {
      fireEvent.click(launcher);
    });
    await waitFor(() => expect(screen.getByText("Idle")).toBeInTheDocument());
    expect(screen.getByText("Microphone off")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    expect(h.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      intent: "continue",
      surface: "web_desktop",
    }));
  });

  it("converges racing launcher-icon and palette invocations on one instance with one bootstrap", async () => {
    const h = harness();
    renderHost(h);
    expect(paletteCommand()).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
      paletteCommand()?.execute();
      fireEvent.click(screen.getByTestId("aoede-launcher"));
      paletteCommand()?.execute();
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    expect(h.voiceFactory).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-testid='aoede-host']")).toHaveLength(1);
    // Neither launch path may start media.
    expect(h.media.startVoice).not.toHaveBeenCalled();
  });

  it("never requests microphone access on icon/palette reveal", async () => {
    // jsdom has no mediaDevices; any getUserMedia attempt would throw.
    const h = harness();
    renderHost(h);
    expect(navigator.mediaDevices?.getUserMedia).toBeUndefined();
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
      paletteCommand()?.execute();
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    expect(h.media.startVoice).not.toHaveBeenCalled();
    // Media still requires the explicit two-step Start gesture.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    expect(screen.getByText("Permission")).toBeInTheDocument();
    expect(h.media.startVoice).not.toHaveBeenCalled();
  });

  it("bootstraps the owner workspace scope with no active chat or project", async () => {
    const h = harness();
    renderHost(h);
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    const request = h.bootstrap.mock.calls[0]?.[0] as { projectId?: string; intent: string };
    expect(request.projectId).toBeUndefined();
    expect(request.intent).toBe("continue");
  });

  it("stops media on dismissal without claiming canonical cancellation", async () => {
    const h = harness();
    renderHost(h);
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss Aoede" }));
    });
    await waitFor(() => expect(screen.queryByTestId("aoede-host")).toBeNull());
    expect(h.media.end).toHaveBeenCalled();
    expect(h.cancelRun).not.toHaveBeenCalled();
    expect(h.source.dispose).not.toHaveBeenCalled();
  });

  it("dismisses safely on Escape", async () => {
    const h = harness();
    renderHost(h);
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    const host = await screen.findByTestId("aoede-host");
    await act(async () => {
      fireEvent.keyDown(host, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("aoede-host")).toBeNull());
    expect(h.media.end).toHaveBeenCalled();
  });

  it("is a labelled nonmodal dialog and light-dismisses outside clicks", async () => {
    const h = harness();
    renderHost(h, {}, <button type="button" data-testid="shell-child">Other</button>);
    const launcher = screen.getByTestId("aoede-launcher");
    await act(async () => {
      fireEvent.click(launcher);
    });
    const host = await screen.findByRole("dialog", { name: "Aoede assistant" });
    expect(host).toHaveAttribute("aria-modal", "false");

    const other = screen.getByTestId("shell-child");
    await act(async () => {
      fireEvent.pointerDown(other);
    });
    await waitFor(() => expect(screen.queryByTestId("aoede-host")).toBeNull());
    expect(h.media.end).toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(other));

    // A launcher press while open is a reveal intent, not an outside dismiss.
    await act(async () => {
      fireEvent.click(launcher);
    });
    await screen.findByTestId("aoede-host");
    await act(async () => {
      fireEvent.pointerDown(launcher);
    });
    expect(screen.getByTestId("aoede-host")).toBeInTheDocument();
  });

  it("returns focus to the launcher invoker after dismissal", async () => {
    const h = harness();
    renderHost(h);
    const launcher = screen.getByTestId("aoede-launcher");
    await act(async () => {
      fireEvent.click(launcher);
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("aoede-host"), { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("aoede-host")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it("registers and removes the global palette action with the mounted host", async () => {
    const h = harness();
    const { unmount } = renderHost(h);
    expect(paletteCommand()?.label).toBe("Aoede");
    expect(paletteCommand()?.group).toBe("Apps");
    unmount();
    expect(paletteCommand()).toBeUndefined();
  });

  it("hides every entry point and stops media when the surface is unsupported", async () => {
    const h = harness();
    const { rerender } = renderHost(h, { supported: false });
    expect(screen.queryByTestId("aoede-launcher")).toBeNull();
    expect(paletteCommand()).toBeUndefined();
    await act(async () => {
      paletteCommand()?.execute();
    });
    expect(h.bootstrap).not.toHaveBeenCalled();

    // Open while supported, then drop support (viewport/design change):
    // the panel hides and media is released rather than running invisibly.
    rerender(
      <ShellAoedeHost
        userId="owner_test"
        runtimeSlot={null}
        surface="web_desktop"
        supported
        controllerDeps={{ api: h.api, voiceFactory: h.voiceFactory }}
      >
        <div />
      </ShellAoedeHost>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    rerender(
      <ShellAoedeHost
        userId="owner_test"
        runtimeSlot={null}
        surface="web_desktop"
        supported={false}
        controllerDeps={{ api: h.api, voiceFactory: h.voiceFactory }}
      >
        <div />
      </ShellAoedeHost>,
    );
    await waitFor(() => expect(screen.queryByTestId("aoede-host")).toBeNull());
    expect(screen.queryByTestId("aoede-launcher")).toBeNull();
    expect(paletteCommand()).toBeUndefined();
    expect(h.media.end).toHaveBeenCalled();
  });

  it("keeps one owner and refreshes capability when Canvas/Desktop presentation changes", async () => {
    const h = harness();
    const { rerender } = renderHost(h);
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    rerender(
      <ShellAoedeHost
        userId="owner_test"
        runtimeSlot={null}
        surface="web_canvas"
        supported
        controllerDeps={{ api: h.api, voiceFactory: h.voiceFactory }}
      >
        <div />
      </ShellAoedeHost>,
    );
    await waitFor(() => expect(h.bootstrap).toHaveBeenCalledTimes(2));
    expect(h.bootstrap).toHaveBeenLastCalledWith(expect.objectContaining({ surface: "web_canvas" }));
    expect(h.media.end).not.toHaveBeenCalled();
    expect(h.voiceFactory).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-testid='aoede-host']")).toHaveLength(1);
  });

  it("forwards the palette invoker so dismissal restores its focus", async () => {
    const h = harness();
    renderHost(h, {}, <button type="button" data-testid="invoker">Invoke</button>);
    const invoker = screen.getByTestId("invoker");
    await act(async () => {
      paletteCommand()?.execute({ invoker });
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("aoede-host"), { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("aoede-host")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(invoker));
  });

  it("shows the settings panel wired to the singleton controller", async () => {
    const h = harness();
    renderHost(h);
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    });
    await waitFor(() => expect(screen.getByText("Turn mode")).toBeInTheDocument());
    expect(screen.getByLabelText("Hands free")).toBeChecked();
    // Truthful degradation: this api/media harness exposes no catalog or enumeration.
    await waitFor(() => expect(screen.getByText("Provider list unavailable.")).toBeInTheDocument());
    expect(screen.getByText(/Device list unavailable/)).toBeInTheDocument();
  });

  it("routes the panel's Cancel generation to canonical run cancellation", async () => {
    const running = runningDetail();
    const h = harness(undefined, running);
    renderHost(h);
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    vi.mocked(h.media.getSnapshot).mockReturnValue({
      phase: "active", voice: { state: "thinking", muted: false, turnMode: "hands_free" },
      error: null, notice: null, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null,
    } as never);
    await act(async () => { h.notifyMedia(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    });
    await waitFor(() => expect(h.cancelRun).toHaveBeenCalledWith(binding.chatId, running.runs[0].id, expect.objectContaining({ clientRequestId: expect.stringMatching(/^req_/) })));
    expect(h.media.end).not.toHaveBeenCalled();
  });

  it("routes canonical card navigation through the validated shell destination", async () => {
    const h = harness(undefined, {
      ...detail,
      operations: [{ ...operationView, result: { navigation: { kind: "open_app", app: "files", path: "apps/files/index.html" } } }],
    });
    const onOpenNavigation = vi.fn();
    renderHost(h, { onOpenNavigation });
    await act(async () => {
      fireEvent.click(screen.getByTestId("aoede-launcher"));
    });
    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Open files/i }));
    });
    expect(onOpenNavigation).toHaveBeenCalledWith({ app: "files", path: "apps/files/index.html" });
  });
});
