// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanonicalChatRoute } from "@desktop/renderer/src/features/chat/CanonicalChatRoute";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { afterEach, describe, expect, it, vi } from "vitest";

function api(get: ApiClient["get"]): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get,
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

describe("CanonicalChatRoute", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses the canonical workspace when the selected Gateway exposes the contract", async () => {
    const routeApi = api(vi.fn(async (path: string) => {
      if (path.startsWith("/api/chat-providers")) throw new Error("catalog unavailable");
      return { items: [] };
    }));
    const { rerender } = render(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active
        fallback={<div>legacy chat</div>}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeTruthy();
    rerender(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active={false}
        fallback={<div>legacy chat</div>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("shows a neutral loading state instead of the legacy Chat UI while probing the canonical route", async () => {
    let resolveProbe!: (value: { items: never[] }) => void;
    const routeApi = api(vi.fn(async (path: string) => {
      if (path.startsWith("/api/chat-providers")) throw new Error("catalog unavailable");
      return new Promise<{ items: never[] }>((resolve) => {
        resolveProbe = resolve;
      });
    }));

    render(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active
        fallback={<button type="button">Legacy new chat</button>}
      />,
    );

    expect(screen.getByRole("status", { name: "Loading chats" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Legacy new chat" })).toBeNull();

    await act(async () => resolveProbe({ items: [] }));
    expect(await screen.findByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("preserves an in-progress canonical draft when the retained Chat tab is reactivated", async () => {
    const routeApi = api(vi.fn(async (path: string) => {
      if (path.startsWith("/api/chat-providers")) throw new Error("catalog unavailable");
      return { items: [] };
    }));
    const { rerender } = render(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active
        fallback={<div>legacy chat</div>}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("textbox", { name: "Start a chat" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Global chats" })).toBeTruthy();

    rerender(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active={false}
        fallback={<div>legacy chat</div>}
      />,
    );
    rerender(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active
        fallback={<div>legacy chat</div>}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "Start a chat" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Global chats" })).toBeTruthy();

    rerender(
      <CanonicalChatRoute
        api={api(routeApi.get)}
        projectId={null}
        active
        fallback={<div>legacy chat</div>}
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Start a chat" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Global chats" })).toBeTruthy();
  });

  it("keeps the legacy route on an older Gateway instead of showing a broken surface", async () => {
    render(
      <CanonicalChatRoute
        api={api(vi.fn(async () => ({ legacy: true })))}
        projectId={null}
        active
        fallback={<div>legacy chat</div>}
      />,
    );

    expect(await screen.findByText("legacy chat")).toBeTruthy();
  });

  it("forwards the revisioned cancellation body through the real queued-turn route adapter", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const running = createCanonicalChatFixture("running");
    const { project, providerBinding, activeRun, ...chat } = running.snapshot.chat;
    const record = {
      chat,
      projectId: project?.projectId,
      providerBinding,
      activeRun,
    };
    const queuedTurn = {
      id: "qturn_route_cancel",
      chatId: chat.id,
      clientRequestId: "req_route_cancel",
      position: 1,
      parts: [{ type: "text" as const, text: "Cancel this queued turn" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project" as const, projectId: "matrix-os" },
      createdAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T02:00:00.000Z",
    };
    const detail = {
      record,
      messages: running.snapshot.messages,
      turns: running.snapshot.turns,
      runs: running.snapshot.runs,
      activities: running.snapshot.activities,
      queuedTurns: [queuedTurn],
    };
    const routeApi = api(vi.fn(async (path: string) => {
      if (path.startsWith("/api/chat-providers")) return running.providerCatalog;
      if (path.startsWith(`/api/chats/${chat.id}`)) return detail;
      if (path.startsWith("/api/chats")) return { items: [record] };
      throw new Error("route unavailable");
    }));
    routeApi.delete = vi.fn(async () => {
      detail.queuedTurns = [];
      return {
        queuedTurnId: queuedTurn.id,
        queueDepth: 0,
        cancellation: "cancelled" as const,
      };
    });

    render(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        initialChatId={chat.id}
        initialView="conversation"
        active
        fallback={<div>legacy chat</div>}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel Cancel this queued turn" }));

    await waitFor(() => {
      expect(routeApi.delete).toHaveBeenCalledWith(
        `/api/chats/${chat.id}/queued-turns/${queuedTurn.id}`,
        expect.objectContaining({
          clientRequestId: expect.any(String),
          baseRevision: chat.revision,
        }),
      );
      expect(screen.queryByText("Cancel this queued turn")).toBeNull();
    });
  });
});
