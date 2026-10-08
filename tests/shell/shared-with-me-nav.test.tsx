// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedWithMeNav } from "../../shell/src/components/chat/SharedWithMeNav";
import { OrganizationStateProvider } from "../../shell/src/lib/collaboration-organization-state";

const mocks = vi.hoisted(() => ({ inbox: vi.fn(), release: vi.fn() }));

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
  releaseShellCollaborationApi: mocks.release,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.inbox.mockReset();
  mocks.release.mockReset();
});

describe("SharedWithMeNav", () => {
  it("hides without querying when the membership list confirms no organizations", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}>
      <SharedWithMeNav active={false} onOpen={vi.fn()} />
    </OrganizationStateProvider>);

    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /shared with me/i })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.inbox).not.toHaveBeenCalled();
  });

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

  it("releases its collaboration API when confirmed absence hides the destination", async () => {
    mocks.release.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ capabilities: { collaboration: true } }),
    })));
    mocks.inbox.mockResolvedValue({ items: [] });
    const view = render(<OrganizationStateProvider value={{ status: "member", organizationId: "org_matrix" }}>
      <SharedWithMeNav active={false} onOpen={vi.fn()} />
    </OrganizationStateProvider>);
    await screen.findByRole("button", { name: /shared with me/i });

    view.rerender(<OrganizationStateProvider value={{ status: "none", organizationId: null }}>
      <SharedWithMeNav active={false} onOpen={vi.fn()} />
    </OrganizationStateProvider>);

    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
