// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup.js";

function providerCatalog(available = true, secondModel = false) {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_shell",
    drivers: [
      { kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      { kind: "opencode", displayName: "OpenCode", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
    ],
    instances: [{
      id: "pi_default", driverKind: "pi", displayName: "Pi",
      availability: available ? "available" : "unavailable",
      ...(available ? {} : { unavailabilityReason: "disabled_in_settings" }),
      workspaceRequirement: "project_optional",
      models: available ? [{
        id: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5", availability: "available",
        capabilities: ["reasoning", "tools"], supportsVision: false, supportsToolUse: true,
      }, ...(secondModel ? [{
        id: "anthropic:claude-opus-5", displayName: "Claude Opus 5", availability: "available" as const,
        capabilities: ["reasoning" as const, "tools" as const], supportsVision: false, supportsToolUse: true,
      }] : [])] : [],
      options: available ? [{
        id: "effort", label: "Reasoning", kind: "enum", placement: "composer",
        values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], defaultValue: "low",
      }, { id: "thinking", label: "Thinking", kind: "boolean", placement: "advanced", defaultValue: false }] : [],
      skills: [], commands: [], setupActions: available ? [] : [{
        id: "pi_settings", kind: "open_settings", label: "Configure Pi",
      }],
      supports: {
        rootChat: true, resume: true, cancellation: true, attachments: ["structured_ref"], tools: [],
        approvals: false, userInput: false, worktrees: "optional", resources: ["project"],
        interactionModes: ["default", "plan"], permissionModes: ["supervised", "full_access"],
      },
      ...(available ? { defaultSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" } } : {}),
      catalogRevision: "catalog_shell",
    }, {
      id: "opencode_default", driverKind: "opencode", displayName: "OpenCode",
      availability: "unavailable", unavailabilityReason: "runtime_not_runnable",
      workspaceRequirement: "project_optional", models: [], options: [], skills: [], commands: [], setupActions: [{
        id: "opencode_connect", kind: "foreground_terminal", label: "Connect OpenCode", command: "sh -lc 'opencode'",
      }],
      supports: {
        rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false,
        userInput: false, worktrees: "optional", resources: [], interactionModes: [], permissionModes: [],
      },
      catalogRevision: "catalog_shell",
    }],
  });
}

function openClawCatalog() {
  const source = providerCatalog();
  const instance = source.instances[0]!;
  return CanonicalProviderCatalogSchema.parse({
    ...source,
    drivers: [{ kind: "openclaw", displayName: "OpenClaw", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
    instances: [{
      ...instance,
      id: "openclaw_default",
      driverKind: "openclaw",
      displayName: "OpenClaw",
      defaultSelection: { instanceId: "openclaw_default", model: "anthropic:claude-sonnet-5" },
    }],
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

describe("Chat canonical provider state", () => {
  it("renames the shared Web Desktop and Web Canvas Chat from the header, rail double-click, and context menu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog())));
    const onSwitchConversation = vi.fn();
    const renameConversation = vi.fn(async () => true);
    const conversation = {
      id: "chat_shared", title: "Old title", preview: "Last message", messageCount: 1, updatedAt: Date.now(),
    };

    const { rerender } = render(<ChatApp
      messages={[]} sessionId="chat_shared" busy={false} connected conversations={[conversation]}
      activeConversationTitle="Old title" onRenameConversation={renameConversation}
      onNewChat={vi.fn()} onSwitchConversation={onSwitchConversation} onSubmit={vi.fn()}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename Old title" }));
    const headerEditor = await screen.findByRole("textbox", { name: "Rename Old title" });
    fireEvent.click(headerEditor);
    expect(screen.getByRole("textbox", { name: "Rename Old title" })).toBeVisible();
    fireEvent.change(headerEditor, { target: { value: "Header title" } });
    fireEvent.keyDown(headerEditor, { key: "Enter" });
    await waitFor(() => expect(renameConversation).toHaveBeenCalledWith("chat_shared", "Header title"));

    renameConversation.mockClear();
    rerender(<ChatApp
      messages={[]} sessionId="chat_shared" busy={false} connected
      conversations={[{ ...conversation, title: "Header title" }]}
      activeConversationTitle="Header title" onRenameConversation={renameConversation}
      onNewChat={vi.fn()} onSwitchConversation={onSwitchConversation} onSubmit={vi.fn()}
    />);
    const row = screen.getByRole("button", { name: "Header title" });
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    expect(await screen.findByRole("textbox", { name: "Rename Header title" })).toBeVisible();
    expect(onSwitchConversation).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename Header title" }), { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Header title" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("textbox", { name: "Rename Header title" })).toBeVisible();
  });

  it("keeps the shared Web Mobile Chat header rename touch-accessible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog())));
    const renameConversation = vi.fn(async () => true);
    render(<ChatApp
      mobile messages={[]} sessionId="chat_mobile" busy={false} connected
      conversations={[{ id: "chat_mobile", title: "Mobile title", preview: "", messageCount: 0, updatedAt: Date.now() }]}
      activeConversationTitle="Mobile title" onRenameConversation={renameConversation}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);

    const titleButton = await screen.findByRole("button", { name: "Rename Mobile title" });
    expect(titleButton.className).toContain("min-h-11");
    fireEvent.click(titleButton);
    const editor = await screen.findByRole("textbox", { name: "Rename Mobile title" });
    fireEvent.change(editor, { target: { value: "Renamed on mobile" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(renameConversation).toHaveBeenCalledWith("chat_mobile", "Renamed on mobile"));
  });

  it("does not let an earlier pending rename close a later editor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog())));
    let resolveRename!: (value: boolean) => void;
    const renameConversation = vi.fn(() => new Promise<boolean>((resolve) => { resolveRename = resolve; }));
    render(<ChatApp
      messages={[]} sessionId="chat_a" busy={false} connected
      conversations={[
        { id: "chat_a", title: "Alpha", preview: "", messageCount: 0, updatedAt: Date.now() },
        { id: "chat_b", title: "Beta", preview: "", messageCount: 0, updatedAt: Date.now() - 1 },
      ]}
      activeConversationTitle="Alpha" onRenameConversation={renameConversation}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Alpha" }));
    const editor = await screen.findByRole("textbox", { name: "Rename Alpha" });
    fireEvent.change(editor, { target: { value: "Alpha pending" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(renameConversation).toHaveBeenCalledOnce());

    expect(screen.getByRole("button", { name: "Beta" })).toHaveProperty("ondblclick", null);
    expect(screen.getByRole("textbox", { name: "Rename Alpha" })).toBeDisabled();
    await act(async () => resolveRename(true));
  });

  it("coalesces a focus refresh that arrives while the provider catalog is in flight", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first)
      .mockImplementation(async () => Response.json(providerCatalog()));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);

    fireEvent(window, new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst!(Response.json(providerCatalog()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Pi")).toBeVisible();
  });

  it("refreshes the canonical catalog after provider settings change", async () => {
    const fetchMock = vi.fn(async () => Response.json(providerCatalog()));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent(window, new Event(PROVIDER_SETTINGS_CHANGED_EVENT));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("uses the canonical catalog, preserves the draft, and submits the exact harness route", async () => {
    const fetchMock = vi.fn(async () => Response.json(providerCatalog()));
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn();
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={onSubmit}
    />);

    expect(await screen.findByText("Pi")).toBeVisible();
    const draft = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));

    expect(await screen.findByRole("button", { name: "Claude Sonnet 5 via Pi" })).toBeVisible();
    expect(screen.getByText("OpenCode — Not supported in this runtime")).toBeVisible();
    expect(screen.queryByText("Channels")).toBeNull();
    expect(draft).toHaveValue("Keep this draft");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/chat-providers?refresh=true"), expect.any(Object));

    fireEvent.change(screen.getByLabelText("Interaction mode"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Permission mode"), { target: { value: "full_access" } });
    fireEvent.change(screen.getByLabelText("Reasoning"), { target: { value: "high" } });
    fireEvent.click(screen.getByLabelText("Thinking"));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      "Keep this draft", undefined, {
        displayText: "Keep this draft",
        instanceId: "pi_default",
        model: "anthropic:claude-sonnet-5",
        interactionMode: "plan",
        permissionMode: "full_access",
        modelOptions: [{ id: "effort", value: "high" }, { id: "thinking", value: true }],
      },
    ));
  });

  it("disables submission and explains settings-disabled harnesses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog(false))));
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);

    expect(await screen.findByText("Connect a harness in Settings to start chatting.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    expect(await screen.findByText("Pi — Disabled in Settings")).toBeVisible();
    expect(screen.getByPlaceholderText("AI harness unavailable")).toBeDisabled();
  });

  it("renders canonical setup actions for shared Canvas and web desktop Chat", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog(false))));
    const onProviderSetupAction = vi.fn();
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
      onProviderSetupAction={onProviderSetupAction}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Configure Pi" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenCode" }));

    expect(onProviderSetupAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "pi_default" }),
      expect.objectContaining({ kind: "open_settings", id: "pi_settings" }),
    );
    expect(onProviderSetupAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "opencode_default" }),
      expect.objectContaining({ kind: "foreground_terminal", id: "opencode_connect" }),
    );
  });

  it("fails closed when an existing chat's bound harness route is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog())));
    render(<ChatApp
      messages={[]} sessionId="chat_bound" busy={false} connected conversations={[]}
      providerSelection={{ instanceId: "opencode_default", model: "openai:gpt-5" }}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);

    expect(await screen.findByText("Connect a harness in Settings to start chatting.")).toBeVisible();
    expect(screen.getByPlaceholderText("AI harness unavailable")).toBeDisabled();
  });

  it("locks an existing chat to its instance while allowing its model and run controls to change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog(true, true))));
    const onSubmit = vi.fn();
    render(<ChatApp
      messages={[]} sessionId="chat_bound" busy={false} connected conversations={[]}
      providerSelection={{
        instanceId: "pi_default", model: "anthropic:claude-sonnet-5",
        options: [{ id: "effort", value: "high" }],
      }}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={onSubmit}
    />);

    fireEvent.change(await screen.findByPlaceholderText("Ask anything..."), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claude Opus 5 via Pi" }));
    fireEvent.change(screen.getByLabelText("Interaction mode"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Permission mode"), { target: { value: "full_access" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Continue", undefined, expect.objectContaining({
      instanceId: "pi_default",
      model: "anthropic:claude-opus-5",
      interactionMode: "plan",
      permissionMode: "full_access",
      modelOptions: [{ id: "effort", value: "high" }, { id: "thinking", value: false }],
    })));
  });

  it("renders and submits canonical approval actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog())));
    const onSubmitApproval = vi.fn(async () => true);
    render(<ChatApp
      messages={[{
        id: "msg_approval", role: "system", content: "Run command: Allow this command?", timestamp: Date.now(),
        metadata: { canonicalApproval: {
          runId: "run_original", approvalId: "approval_1", title: "Run command", description: "Allow this command?",
          risk: "medium", allowedDecisions: ["approve", "decline"], pending: true,
        } },
      }]}
      sessionId="chat_approval" busy connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
      onSubmitApproval={onSubmitApproval}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onSubmitApproval).toHaveBeenCalledWith("run_original", "approval_1", "approve"));
    expect(screen.getByRole("button", { name: "Decline" })).toBeVisible();
  });

  it("shows one safe shell notification when a canonical setup action fails", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/chat-providers")) return Response.json(providerCatalog(false));
      if (String(url).includes("/api/terminal/sessions") && init?.method === "POST") {
        return Response.json({ error: "private terminal failure" }, { status: 503 });
      }
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenCode" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open setup. Open Settings to continue.");
    expect(screen.queryByText("private terminal failure")).toBeNull();
  });

  it("keeps Hermes channel controls and prompt instructions out of OpenClaw turns", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(openClawCatalog())));
    const onSubmit = vi.fn();
    render(<ChatApp
      messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={onSubmit}
    />);

    fireEvent.change(await screen.findByPlaceholderText("Ask anything..."), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    expect(screen.queryByText("Channels")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Hello", undefined, expect.not.objectContaining({
      promptText: expect.anything(),
    })));
  });
});
