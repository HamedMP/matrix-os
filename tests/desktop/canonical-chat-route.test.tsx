// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CanonicalChatRoute } from "@desktop/renderer/src/features/chat/CanonicalChatRoute";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
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
  afterEach(cleanup);

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
});
