// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const matrixContext = {
  projectId: "matrix-os",
  projectName: "Matrix OS",
  projectKind: "github" as const,
  repositoryLabel: "FinnaAI/matrix-os",
  status: "ready" as const,
};

describe("Hermes chat project context", () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    useBoard.setState(useBoard.getInitialState(), true);
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    useBoard.setState({
      projects: [{
        slug: "matrix-os",
        name: "Matrix OS",
        kind: "github",
        github: { owner: "FinnaAI", repo: "matrix-os" },
      }],
    });
    useHermesChat.setState({
      view: "conversation",
      indexStatus: "ready",
      sessionId: "conversation-one",
      messages: [{ id: "message-one", role: "assistant", content: "Ready", timestamp: 1 }],
      status: "idle",
      conversationContext: null,
      contextStatus: "ready",
      contextError: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("selects a canonical project and renders truthful project and repository controls", async () => {
    const patch = vi.fn().mockResolvedValue({ context: matrixContext });
    useConnection.setState({ api: { patch } as never });
    render(<ChatTab />);

    expect(screen.getByRole("button", { name: "Add to project" })).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByText("On VPS")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    fireEvent.click(screen.getByRole("option", { name: "Matrix OS, GitHub, FinnaAI/matrix-os" }));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      "/api/conversations/conversation-one/context",
      { projectId: "matrix-os" },
    ));
    expect(await screen.findByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repository FinnaAI/matrix-os" })).toBeTruthy();
  });

  it("uses persisted context instead of the first project and disables controls during a turn", () => {
    useBoard.setState({
      projects: [
        { slug: "wrong", name: "Wrong Project", kind: "scratch" },
        { slug: "matrix-os", name: "Matrix OS", kind: "github" },
      ],
    });
    useHermesChat.setState({ conversationContext: matrixContext, status: "thinking" });
    useConnection.setState({ api: { patch: vi.fn() } as never });
    render(<ChatTab />);

    expect(screen.queryByText("Wrong Project")).toBeNull();
    expect(screen.getByRole("button", { name: "Project Matrix OS" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Repository FinnaAI/matrix-os" }).hasAttribute("disabled")).toBe(true);
  });

  it("blocks send for stale context and exposes explicit recovery without clearing the transcript", async () => {
    const patch = vi.fn().mockRejectedValue(
      new AppError("notFound", { detail: "project_unavailable" }),
    );
    useConnection.setState({ api: { patch } as never });
    useHermesChat.setState({
      conversationContext: { ...matrixContext, status: "unavailable" },
    });
    render(<ChatTab />);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply to Hermes…" }), {
      target: { value: "continue" },
    });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("project is unavailable");
    expect(screen.getByRole("button", { name: "Choose another project" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove project context" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      "/api/conversations/conversation-one/context",
      { projectId: null },
    ));
    expect(useHermesChat.getState().conversationContext).toEqual({
      ...matrixContext,
      status: "unavailable",
    });
    expect(screen.getByRole("button", { name: "Project Matrix OS, unavailable" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("That project is unavailable");
  });
});
