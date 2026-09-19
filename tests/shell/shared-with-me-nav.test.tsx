// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedWithMeNav } from "../../shell/src/components/chat/SharedWithMeNav";

const mocks = vi.hoisted(() => ({ inbox: vi.fn() }));

vi.mock("../../shell/src/hooks/useBrowserOrigin", () => ({
  useBrowserOrigin: () => "https://app.matrix-os.com",
}));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "https://gateway.matrix.test" }));
vi.mock("../../shell/src/lib/collaboration", () => ({
  collaborationRuntimeFromSystemInfo: (value: { capabilities?: { collaboration?: boolean } }) => ({
    handle: null,
    runtimeSlot: "primary",
    runtimeId: null,
    collaborationEnabled: value.capabilities?.collaboration === true,
  }),
  createShellCollaborationApi: () => ({
    baseUrl: "https://app.matrix-os.com",
    get: mocks.inbox,
    post: vi.fn(),
    delete: vi.fn(),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.inbox.mockReset();
});

describe("SharedWithMeNav", () => {
  it("does not expose collaboration or query discovery when the feature flag is off", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ capabilities: { collaboration: false } }),
    }));
    vi.stubGlobal("fetch", fetch);

    render(<SharedWithMeNav active={false} onOpen={vi.fn()} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /shared with me/i })).toBeNull();
    expect(mocks.inbox).not.toHaveBeenCalled();
  });

  it("keeps the destination visible when an enabled inbox request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ capabilities: { collaboration: true } }),
    })));
    mocks.inbox.mockRejectedValue(new Error("NetworkUnavailable"));

    render(<SharedWithMeNav active={false} onOpen={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /shared with me/i })).toBeVisible();
    await waitFor(() => expect(mocks.inbox).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /shared with me/i })).toBeVisible();
  });
});
