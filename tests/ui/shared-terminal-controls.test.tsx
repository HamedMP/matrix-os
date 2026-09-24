// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SharedTerminalControls } from "../../packages/ui/src/collaboration/SharedTerminalControls";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminal = {
  id: "terminal_release",
  scopeId,
  incarnation: `terminal-${"a".repeat(32)}`,
  executionGeneration: "4",
  status: "active" as const,
  createdBy: { actorId: "user_owner", displayName: "Nima" },
  createdAt: "2026-09-11T12:00:00.000Z",
};

function scope(role: "owner" | "editor" | "viewer") {
  return {
    id: scopeId,
    ownerId: "user_owner",
    kind: "terminal" as const,
    resourceId: terminal.id,
    membershipMode: "direct" as const,
    lifecycle: "shared" as const,
    revision: "1",
    authEpoch: "1",
    authorityGeneration: "1",
    role,
    capabilities: {
      read: true,
      discuss: false,
      manageMembers: role === "owner",
      requestAi: false,
      observeTerminal: true,
      controlTerminal: role !== "viewer",
      stopTerminal: role === "owner",
    },
  };
}

type TerminalHandlers = {
  onReady(frame: unknown): void;
  onOutput(frame: unknown): void;
  onState(frame: unknown): void;
  onRefreshRequired(): void | Promise<void>;
  onUnavailable(): void;
  onDisconnected(): void;
};

function apiFixture() {
  let handlers: TerminalHandlers | undefined;
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => path.includes("/discussion/messages")
      ? { messages: [], latestSequence: "0" }
      : terminal),
    post: vi.fn(async () => ({ terminal, action: "accepted" })),
    delete: vi.fn(),
    subscribeTerminal: vi.fn((_scopeId: string, next: TerminalHandlers) => {
      handlers = next;
      return () => undefined;
    }),
  };
  return { api, handlers: () => handlers! };
}

function readyFrame(connectionId: string, current = terminal) {
  return {
    version: 1 as const,
    type: "terminal.ready" as const,
    connectionId,
    scopeId,
    resourceId: terminal.id,
    authorityGeneration: "1",
    incarnation: terminal.incarnation,
    sequence: "0",
    terminal: current,
  };
}

function outputFrame(sequence: string, data: string) {
  return {
    version: 1 as const,
    type: "terminal.output" as const,
    scopeId,
    resourceId: terminal.id,
    authorityGeneration: "1",
    incarnation: terminal.incarnation,
    sequence,
    data,
  };
}

describe("shared terminal controls", () => {
  it("toggles the discussion layer from the terminal chrome", async () => {
    const { api } = apiFixture();
    render(<SharedTerminalControls api={api} scope={scope("viewer")} actorId="user_viewer" />);
    const trigger = screen.getByRole("button", { name: "Open terminal discussion" });

    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Discussion" })).toBeVisible();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Discussion" })).toBeNull();
  });

  it("drops the superseded transcript when the server replaces terminal history", async () => {
    const { api, handlers } = apiFixture();
    render(<SharedTerminalControls api={api} scope={scope("viewer")} actorId="user_viewer" />);
    await waitFor(() => expect(api.subscribeTerminal).toHaveBeenCalled());
    act(() => handlers().onReady(readyFrame("connection_viewer")));
    act(() => handlers().onOutput(outputFrame("1", "stale screen\n")));
    expect(await screen.findByText("stale screen", { exact: false })).toBeVisible();

    // The daemon reconnected, so the gateway voids retained history and replays its snapshot.
    // A refresh reloads metadata only, so without an explicit reset the snapshot lands on top
    // of the screen it is meant to replace and the viewer reads the same output twice.
    await act(async () => { await handlers().onRefreshRequired(); });
    act(() => handlers().onOutput(outputFrame("2", "snapshot screen\n")));

    expect(await screen.findByText("snapshot screen", { exact: false })).toBeVisible();
    expect(screen.queryByText("stale screen", { exact: false })).toBeNull();
  });

  it("lets a viewer watch bounded output without exposing mutation controls", async () => {
    const { api, handlers } = apiFixture();
    render(<SharedTerminalControls api={api} scope={scope("viewer")} actorId="user_viewer" />);
    await waitFor(() => expect(api.subscribeTerminal).toHaveBeenCalledWith(scopeId, expect.any(Object)));
    act(() => handlers().onReady(readyFrame("connection_viewer")));
    act(() => handlers().onOutput({
      version: 1,
      type: "terminal.output",
      scopeId,
      resourceId: terminal.id,
      authorityGeneration: "1",
      incarnation: terminal.incarnation,
      sequence: "1",
      data: "release ready\n",
    }));

    expect(await screen.findByText("release ready", { exact: false })).toBeVisible();
    expect(screen.getByText("Watching only")).toBeVisible();
    expect(screen.queryByRole("button", { name: /control/i })).toBeNull();
    expect(screen.getByLabelText("Terminal input")).toBeDisabled();
  });

  it("binds editor input and release to the issued connection and lease epoch", async () => {
    const { api, handlers } = apiFixture();
    api.post.mockImplementation(async (_path, body) => {
      const action = body as { type?: string };
      const controlled = {
        ...terminal,
        controller: {
          actor: { actorId: "user_editor", displayName: "Ada" },
          leaseEpoch: "7",
          expiresAt: "2026-09-11T12:00:30.000Z",
        },
      };
      if (action.type === "release") return { terminal, action: "released" };
      return { terminal: controlled, action: action.type === "acquire" ? "acquired" : "accepted" };
    });
    render(<SharedTerminalControls api={api} scope={scope("editor")} actorId="user_editor" />);
    await waitFor(() => expect(api.subscribeTerminal).toHaveBeenCalled());
    act(() => handlers().onReady(readyFrame("connection_editor")));
    fireEvent.click(await screen.findByRole("button", { name: "Request control" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({
        type: "acquire",
        incarnation: terminal.incarnation,
        connectionId: "connection_editor",
      }),
    ));
    act(() => handlers().onState({
      version: 1,
      type: "terminal.state",
      scopeId,
      resourceId: terminal.id,
      authorityGeneration: "1",
      incarnation: terminal.incarnation,
      sequence: "0",
      terminal: {
        ...terminal,
        controller: {
          actor: { actorId: "user_editor", displayName: "Ada" },
          leaseEpoch: "7",
          expiresAt: "2026-09-11T12:00:30.000Z",
        },
      },
    }));
    fireEvent.change(screen.getByLabelText("Terminal input"), { target: { value: "pnpm test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send input" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({
        type: "input",
        connectionId: "connection_editor",
        leaseEpoch: "7",
        data: "pnpm test",
      }),
    ));
    act(() => handlers().onState({
      version: 1,
      type: "terminal.state",
      scopeId,
      resourceId: terminal.id,
      authorityGeneration: "1",
      incarnation: terminal.incarnation,
      sequence: "0",
      terminal: {
        ...terminal,
        controller: {
          actor: { actorId: "user_editor", displayName: "Ada" },
          leaseEpoch: "7",
          expiresAt: "2026-09-11T12:00:30.000Z",
        },
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({ type: "release", connectionId: "connection_editor", leaseEpoch: "7" }),
    ));
  });

  it("offers takeover only to an owner and fences the surface when access becomes unavailable", async () => {
    const { api, handlers } = apiFixture();
    render(<SharedTerminalControls api={api} scope={scope("owner")} actorId="user_owner" />);
    await waitFor(() => expect(api.subscribeTerminal).toHaveBeenCalled());
    act(() => handlers().onReady(readyFrame("connection_owner", {
      ...terminal,
      controller: {
        actor: { actorId: "user_editor", displayName: "Ada" },
        leaseEpoch: "3",
        expiresAt: "2026-09-11T12:00:30.000Z",
      },
    })));
    fireEvent.click(await screen.findByRole("button", { name: "Take control from Ada" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({ type: "takeover", connectionId: "connection_owner" }),
    ));
    act(() => handlers().onUnavailable());
    expect(await screen.findByRole("alert")).toHaveTextContent("terminal is no longer available");
    expect(screen.getByLabelText("Terminal input")).toBeDisabled();
  });

  it("stops without a socket and clears local control when the socket disconnects", async () => {
    const { api, handlers } = apiFixture();
    render(<SharedTerminalControls api={api} scope={scope("owner")} actorId="user_owner" />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Stop terminal" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.not.objectContaining({ connectionId: expect.anything() }),
    ));

    act(() => handlers().onReady(readyFrame("connection_owner")));
    fireEvent.click(await screen.findByRole("button", { name: "Request control" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({ type: "acquire", connectionId: "connection_owner" }),
    ));
    act(() => handlers().onDisconnected());
    expect(screen.getByLabelText("Terminal input")).toBeDisabled();
  });
});
