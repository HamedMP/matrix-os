// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";

const renameProject = vi.fn(async () => true);
const deleteProject = vi.fn(async () => true);

vi.mock("../../shell/src/hooks/useChatProjects.js", () => ({
  useChatProjects: () => ({
    projects: [{ id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "scratch" }],
    error: null,
    pendingSlug: null,
    renameProject,
    deleteProject,
  }),
}));

vi.mock("../../shell/src/hooks/useVoice.js", () => ({
  useVoice: () => ({
    isRecording: false,
    isTranscribing: false,
    isSupported: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("web Chat Desktop parity", () => {
  it("shows project conversations and exposes the same Rename/Delete menu on click and right click", async () => {
    render(
      <ChatApp
        messages={[]}
        sessionId="alpha-chat"
        busy={false}
        connected
        conversations={[{
          id: "alpha-chat",
          preview: "Alpha chat",
          messageCount: 1,
          createdAt: 1,
          updatedAt: 2,
          context: { projectId: "proj_alpha", projectName: "Alpha", projectKind: "scratch", status: "ready" },
        }]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onDeleteConversation={vi.fn(async () => true)}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByRole("button", { name: "Alpha chat" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Alpha project" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("dialog", { name: "Rename project" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }), { clientX: 100, clientY: 120 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete project permanently?" })).toBeTruthy();
  });
});
