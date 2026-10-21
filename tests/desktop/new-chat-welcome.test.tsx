// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";

vi.mock("@desktop/renderer/src/features/chat/ChatProviderOnboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const prompts = [
  "Explore and understand code",
  "Build a new feature, app, or tool",
  "Review code and suggest changes",
  "Fix issues and failures",
];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useBoard.setState({ projects: [{ id: "matrix-os", slug: "matrix-os", name: "Matrix OS", kind: "folder" } as never] });
});
afterEach(cleanup);

it.each([null, "matrix-os"])('fills an ordinary New Chat draft from each starter without sending (Project=%s)', async projectId => {
  const client = createCanonicalChatWorkspaceClient();
  render(<CanonicalChatWorkspace client={client} projectId={projectId} initialView="draft" externalNavigation active catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Start a chat" });
  await waitFor(() => expect(editor.getAttribute("contenteditable")).toBe("true"));
  expect(screen.getByRole("heading", { name: "What should we build today?" })).toBeTruthy();
  const logo = screen.getByTestId("chat-welcome-matrix-logo");
  expect(logo.style.maskImage).toContain("matrix-logo.svg");
  for (const prompt of prompts) {
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    await waitFor(() => expect(editor.textContent).toBe(prompt));
    if (projectId) expect(screen.getByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
  }
  expect(client.create).not.toHaveBeenCalled();
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(client.queueTurn).not.toHaveBeenCalled();
});

it.each(["index", "conversation"] as const)("does not introduce welcome cards in a Project %s", async initialView => {
  const client = createCanonicalChatWorkspaceClient();
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialView={initialView}
    initialChatId={initialView === "conversation" ? snapshot.chat.id : undefined} externalNavigation active catalog={providerCatalog} />);
  await screen.findByRole("textbox", { name: initialView === "conversation" ? "Reply to chat" : "Start a chat" });
  expect(screen.queryByRole("heading", { name: "What should we build today?" })).toBeNull();
  for (const prompt of prompts) expect(screen.queryByRole("button", { name: prompt })).toBeNull();
  expect(client.create).not.toHaveBeenCalled();
  expect(client.admitTurn).not.toHaveBeenCalled();
});
