// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering.js";

const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "catalog_web_parity",
  drivers: [{ kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{
    id: "pi_default",
    driverKind: "pi",
    displayName: "Pi",
    availability: "available",
    workspaceRequirement: "project_optional",
    models: [{
      id: "anthropic:claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      availability: "available",
      capabilities: ["reasoning", "tools"],
      supportsVision: false,
      supportsToolUse: true,
    }],
    options: [], skills: [], commands: [], setupActions: [],
    supports: {
      rootChat: true, resume: true, cancellation: true, attachments: [], tools: [],
      approvals: false, userInput: false, worktrees: "optional", resources: ["project"],
      interactionModes: ["default"], permissionModes: ["supervised"],
    },
    defaultSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
    catalogRevision: "catalog_web_parity",
  }],
});

const conversations = [{
  id: "chat_active",
  title: "Launch plan",
  preview: "The complete launch plan and milestones",
  messageCount: 4,
  updatedAt: Date.now(),
}, {
  id: "chat_older",
  title: "Customer notes",
  preview: "A long preview that should not replace the canonical title",
  messageCount: 2,
  updatedAt: Date.now() - 3_600_000,
}];

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

function renderChat(overrides: Partial<React.ComponentProps<typeof ChatApp>> = {}) {
  return render(<ChatApp
    messages={[]}
    sessionId="chat_active"
    busy={false}
    connected
    conversations={conversations}
    onNewChat={vi.fn()}
    onSwitchConversation={vi.fn()}
    onSubmit={vi.fn()}
    {...overrides}
  />);
}

describe("Web Chat Electron Desktop parity", () => {
  it("uses the canonical desktop Chat rail structure and conversation titles", async () => {
    renderChat();

    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    const rail = screen.getByRole("complementary", { name: "Global chats" });
    expect(rail).toHaveAttribute("data-chat-rail", "desktop");
    expect(rail.style.zIndex).toBe(String(SHELL_Z_INDEX.appSurfaceRail));
    expect(screen.getByRole("button", { name: "Launch plan conversation" })).toHaveTextContent("Launch plan");
    expect(screen.getByRole("button", { name: "Customer notes conversation" })).toHaveTextContent("Customer notes");
    expect(screen.getAllByText(/Just now|m ago|h ago/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("web-chat-workspace")).toHaveAttribute("data-desktop-parity", "true");
  });

  it("confirms deletion and keeps the active chat visible until the server succeeds", async () => {
    let resolveDelete: ((deleted: boolean) => void) | undefined;
    const onDeleteConversation = vi.fn(() => new Promise<boolean>((resolve) => { resolveDelete = resolve; }));
    renderChat({ onDeleteConversation });

    fireEvent.click(await screen.findByRole("button", { name: "Delete Launch plan" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete Launch plan?");
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    expect(onDeleteConversation).toHaveBeenCalledWith("chat_active");
    expect(document.querySelector('[aria-label="Launch plan conversation"]')).toBeInTheDocument();
    resolveDelete!(true);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("exposes the canonical stop action while a response is active", async () => {
    const onAbort = vi.fn();
    renderChat({
      busy: true,
      canAbort: true,
      onAbort,
      messages: [{ id: "msg_user", role: "user", content: "Keep working", timestamp: Date.now() }],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Stop response" }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("does not expose Stop while busy work has no cancellable active run", async () => {
    renderChat({
      busy: true,
      canAbort: false,
      onAbort: vi.fn(),
      messages: [{ id: "msg_user", role: "user", content: "Uploading", timestamp: Date.now() }],
    });

    expect(await screen.findByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
  });
});
