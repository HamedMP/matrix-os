// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
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

    expect(await screen.findByRole("region", { name: "Global Chat" })).toBeTruthy();
    rerender(
      <CanonicalChatRoute
        api={routeApi}
        projectId={null}
        active={false}
        fallback={<div>legacy chat</div>}
      />,
    );
    expect(screen.getByRole("region", { name: "Global Chat" })).toBeTruthy();
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
